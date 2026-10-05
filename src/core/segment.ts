import type { ReconResult, Vec3 } from './types';

export type SegmentKey = 'cranio' | 'mandibula' | 'dentes' | 'metal';

export interface SegmentationResult {
  /** rótulo por voxel na grade da reconstrução: 0 fundo, 1 crânio/face, 2 mandíbula, 3 dentes, 4 metal */
  labels: Uint8Array;
  notes: string[];
  stats: { key: SegmentKey; volumeMm3: number }[];
  /** limiar baixo usado para a superfície dos dentes */
  teethLow: number;
}

export const LABEL_IDS: Record<SegmentKey, number> = { cranio: 1, mandibula: 2, dentes: 3, metal: 4 };

const NEIGHBORS = (nx: number, ny: number) => [1, -1, nx, -nx, nx * ny, -nx * ny];

/** Rotula componentes conexos (6-vizinhança) de mask=1. */
function components(mask: Uint8Array, dims: Vec3) {
  const [nx, ny, nz] = dims;
  const plane = nx * ny;
  const labels = new Int32Array(mask.length);
  const sizes: number[] = [0];
  const queue = new Int32Array(mask.length);
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || labels[s]) continue;
    const id = sizes.length;
    let head = 0;
    let tail = 0;
    queue[tail++] = s;
    labels[s] = id;
    while (head < tail) {
      const i = queue[head++];
      const x = i % nx;
      const y = ((i / nx) | 0) % ny;
      const z = (i / plane) | 0;
      if (x > 0 && mask[i - 1] && !labels[i - 1]) (labels[i - 1] = id), (queue[tail++] = i - 1);
      if (x < nx - 1 && mask[i + 1] && !labels[i + 1]) (labels[i + 1] = id), (queue[tail++] = i + 1);
      if (y > 0 && mask[i - nx] && !labels[i - nx]) (labels[i - nx] = id), (queue[tail++] = i - nx);
      if (y < ny - 1 && mask[i + nx] && !labels[i + nx]) (labels[i + nx] = id), (queue[tail++] = i + nx);
      if (z > 0 && mask[i - plane] && !labels[i - plane]) (labels[i - plane] = id), (queue[tail++] = i - plane);
      if (z < nz - 1 && mask[i + plane] && !labels[i + plane]) (labels[i + plane] = id), (queue[tail++] = i + plane);
    }
    sizes.push(tail);
  }
  return { labels, sizes };
}

function erode(mask: Uint8Array, dims: Vec3): Uint8Array {
  const [nx, ny, nz] = dims;
  const plane = nx * ny;
  const out = new Uint8Array(mask.length);
  for (let z = 1; z < nz - 1; z++)
    for (let y = 1; y < ny - 1; y++)
      for (let x = 1; x < nx - 1; x++) {
        const i = z * plane + y * nx + x;
        out[i] = mask[i] & mask[i - 1] & mask[i + 1] & mask[i - nx] & mask[i + nx] & mask[i - plane] & mask[i + plane];
      }
  return out;
}

/**
 * Crescimento de região a partir de sementes, limitado a voxels com `allowed` e a
 * `maxSteps` passos (distância geodésica aproximada em voxels).
 */
function growFrom(seeds: Uint8Array, allowed: (i: number) => boolean, dims: Vec3, maxSteps: number): Uint8Array {
  const [nx, ny] = dims;
  const out = new Uint8Array(seeds.length);
  let frontier: number[] = [];
  for (let i = 0; i < seeds.length; i++) if (seeds[i]) (out[i] = 1), frontier.push(i);
  const nb = NEIGHBORS(nx, ny);
  for (let step = 0; step < maxSteps && frontier.length; step++) {
    const next: number[] = [];
    for (const i of frontier)
      for (const d of nb) {
        const j = i + d;
        if (j < 0 || j >= out.length || out[j] || !allowed(j)) continue;
        out[j] = 1;
        next.push(j);
      }
    frontier = next;
  }
  return out;
}

function percentile(values: Float32Array | Int16Array, mask: (i: number) => boolean, p: number, stride = 3): number {
  const sample: number[] = [];
  for (let i = 0; i < values.length; i += stride) if (mask(i)) sample.push(values[i]);
  if (!sample.length) return NaN;
  sample.sort((a, b) => a - b);
  return sample[Math.min(sample.length - 1, Math.floor((p / 100) * sample.length))];
}

/**
 * Segmentação por regras de densidade e forma (não é rede neural):
 * - dentes: sementes de esmalte/restauração (densidade mais alta do exame) crescidas para a dentina vizinha;
 * - mandíbula: separada do crânio por erosão (rompe a ATM e contatos finos) e componentes conexos;
 * - crânio/maxila: o restante do osso.
 */
export function segmentBone(rec: ReconResult, threshold: number, calibratedHU: boolean, metal?: Uint8Array): SegmentationResult {
  const { intensity, surfaceField } = rec;
  const dims = intensity.dims;
  const [nx, ny, nz] = dims;
  const plane = nx * ny;
  const n = nx * ny * nz;
  const field = surfaceField.data;
  const hu = intensity.data;
  const notes: string[] = [];
  const bone = new Uint8Array(n);
  for (let i = 0; i < n; i++) bone[i] = field[i] > 0 && !(metal && metal[i]) ? 1 : 0;

  // ---- dentes (sem o metal, que tem camada própria) ----
  const p999 = percentile(hu, (i) => bone[i] === 1, 99.9);
  const seedT = calibratedHU ? Math.max(2300, Math.min(p999, 3000)) : p999;
  const lowT = threshold + 0.62 * (seedT - threshold);
  const seeds = new Uint8Array(n);
  let seedCount = 0;
  for (let i = 0; i < n; i++)
    if (hu[i] >= seedT && !(metal && metal[i])) {
      seeds[i] = 1;
      seedCount++;
    }
  const voxelMm = Math.min(intensity.spacing[0], intensity.spacing[1], intensity.spacing[2]);
  const voxelVol = intensity.spacing[0] * intensity.spacing[1] * intensity.spacing[2];
  let teeth: Uint8Array = new Uint8Array(n);
  if (seedCount > 0) {
    teeth = growFrom(seeds, (i) => hu[i] >= lowT && !(metal && metal[i]), dims, Math.round(14 / voxelMm));
    // descarta grupos pequenos demais para serem dentes (ruído, calcificações)
    const cc = components(teeth, dims);
    const minVox = 15 / (intensity.spacing[0] * intensity.spacing[1] * intensity.spacing[2]);
    for (let i = 0; i < n; i++) if (teeth[i] && cc.sizes[cc.labels[i]] < minVox) teeth[i] = 0;
  }
  const teethCount = teeth.reduce((a, v) => a + v, 0);
  if (!teethCount) notes.push('Dentes não identificados (sem esmalte ou restaurações de alta densidade na área do exame).');

  // ---- mandíbula ----
  const jaw = new Uint8Array(n);
  for (let i = 0; i < n; i++) jaw[i] = bone[i] && !teeth[i] ? 1 : 0;
  let eroded = erode(jaw, dims);
  // eixo superior/inferior: +z é superior quando a normal dos cortes aponta para S
  const zSup = intensity.direction[8] >= 0;
  const xs = (i: number) => i % nx;
  const ys = (i: number) => ((i / nx) | 0) % ny;
  const zs = (i: number) => (i / plane) | 0;
  // eixo ântero-posterior: +y aponta para posterior quando a coluna da imagem aponta para P
  const yPost = intensity.direction[4] >= 0;

  let bxMin = nx;
  let bxMax = 0;
  let bzMin = nz;
  let bzMax = 0;
  let byMin = ny;
  let byMax = 0;
  for (let i = 0; i < n; i += 2)
    if (jaw[i]) {
      const x = xs(i);
      const y = ys(i);
      const z = zs(i);
      if (y < byMin) byMin = y;
      if (y > byMax) byMax = y;
      if (x < bxMin) bxMin = x;
      if (x > bxMax) bxMax = x;
      if (z < bzMin) bzMin = z;
      if (z > bzMax) bzMax = z;
    }
  // plano oclusal aproximado: altura média dos dentes. O corpo da mandíbula fica abaixo dele;
  // a maxila (palato, processo alveolar) fica acima — evita chamar a maxila de mandíbula quando
  // a mandíbula não está no exame
  let teethZ = NaN;
  if (teethCount) {
    let zsum = 0;
    for (let i = 0; i < n; i++) if (teeth[i]) zsum += (i / plane) | 0;
    teethZ = zsum / teethCount;
  }
  const widthX = Math.max(1, bxMax - bxMin);
  const heightZ = Math.max(1, bzMax - bzMin);
  const depthY = Math.max(1, byMax - byMin);

  let mandibleLabel = -1;
  let cc = components(eroded, dims);
  for (let attempt = 0; attempt < 3 && mandibleLabel < 0; attempt++) {
    if (attempt > 0) {
      eroded = erode(eroded, dims);
      cc = components(eroded, dims);
    }
    const total = cc.sizes.reduce((a, b) => a + b, 0);
    const largest = cc.sizes.indexOf(Math.max(...cc.sizes));
    // estatísticas por componente
    const stats = cc.sizes.map(() => ({ xMin: nx, xMax: 0, zMin: nz, zMax: 0, zSum: 0, ySum: 0 }));
    for (let i = 0; i < n; i++) {
      const l = cc.labels[i];
      if (!l) continue;
      const s = stats[l];
      const x = xs(i);
      if (x < s.xMin) s.xMin = x;
      if (x > s.xMax) s.xMax = x;
      const z = zs(i);
      if (z < s.zMin) s.zMin = z;
      if (z > s.zMax) s.zMax = z;
      s.zSum += z;
      s.ySum += ys(i);
    }
    let bestSize = 0;
    for (let l = 1; l < cc.sizes.length; l++) {
      if (l === largest || cc.sizes[l] < total * 0.01) continue;
      const s = stats[l];
      const span = (s.xMax - s.xMin) / widthX;
      const zMean = s.zSum / cc.sizes[l];
      const relHeight = zSup ? (zMean - bzMin) / heightZ : (bzMax - zMean) / heightZ;
      // mandíbula: larga (cruza a linha média), anterior, chegando ao ponto mais baixo do osso
      // (mento), com volume e altura de mandíbula (medidos após a erosão). Isso evita rotular
      // paredes laterais do crânio, a coluna cervical ou um processo alveolar cortado pela borda.
      const volumeMm3 = cc.sizes[l] * voxelVol;
      const heightMm = (s.zMax - s.zMin) * intensity.spacing[2];
      const lowestRel = zSup ? (s.zMin - bzMin) / heightZ : (bzMax - s.zMax) / heightZ;
      const yRel = (s.ySum / cc.sizes[l] - byMin) / depthY;
      const anterior = yPost ? yRel < 0.6 : yRel > 0.4;
      const plausible = volumeMm3 > 10000 && volumeMm3 < 110000 && heightMm > 30;
      const belowTeeth = Number.isNaN(teethZ) || (zSup ? zMean < teethZ : zMean > teethZ);
      if (span > 0.35 && relHeight < 0.4 && lowestRel < 0.12 && anterior && plausible && belowTeeth && cc.sizes[l] > bestSize) {
        bestSize = cc.sizes[l];
        mandibleLabel = l;
      }
    }
  }

  const labels = new Uint8Array(n);
  if (mandibleLabel > 0) {
    // devolve aos rótulos o osso removido pela erosão (cada voxel vai para o rótulo mais próximo)
    const owner = new Int8Array(n);
    let frontier: number[] = [];
    for (let i = 0; i < n; i++)
      if (cc.labels[i]) {
        owner[i] = cc.labels[i] === mandibleLabel ? 2 : 1;
        frontier.push(i);
      }
    const nb = NEIGHBORS(nx, ny);
    while (frontier.length) {
      const next: number[] = [];
      for (const i of frontier)
        for (const d of nb) {
          const j = i + d;
          if (j < 0 || j >= n || owner[j] || !jaw[j]) continue;
          owner[j] = owner[i];
          next.push(j);
        }
      frontier = next;
    }
    for (let i = 0; i < n; i++) if (jaw[i]) labels[i] = owner[i] === 2 ? 2 : 1;
  } else {
    for (let i = 0; i < n; i++) if (jaw[i]) labels[i] = 1;
    notes.push('Mandíbula não separada: não aparece inteira na área do exame ou está unida à maxila/crânio nos dados disponíveis.');
  }
  for (let i = 0; i < n; i++) if (teeth[i]) labels[i] = 3;
  if (metal) for (let i = 0; i < n; i++) if (metal[i]) labels[i] = 4;

  const counts = new Float64Array(5);
  for (let i = 0; i < n; i++) counts[labels[i]]++;
  const stats: SegmentationResult['stats'] = (Object.keys(LABEL_IDS) as SegmentKey[])
    .filter((k) => counts[LABEL_IDS[k]] > 0)
    .map((k) => ({ key: k, volumeMm3: counts[LABEL_IDS[k]] * voxelVol }));
  notes.push(
    'Segmentação automática por regras de densidade e forma (não é rede neural treinada). Para separar maxila, zigomáticos, ossos nasais e outras estruturas, use Separar por toque ou Cortar pelo plano. Confira as bordas nos cortes.',
  );
  return { labels, notes, stats, teethLow: lowT };
}
