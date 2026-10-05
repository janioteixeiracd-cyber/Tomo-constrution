import type { Vec3, Volume } from './types';

export type MetalKind = 'parafuso' | 'placa' | 'restauracao' | 'fragmento';

export interface MetalObject {
  id: number;
  kind: MetalKind;
  /** volume (mm³) */
  volume: number;
  /** comprimento ao longo do eixo principal (mm) — para parafusos, o comprimento da peça */
  length: number;
  /** largura no segundo eixo (mm) */
  width: number;
  /** espessura no terceiro eixo (mm) */
  thickness: number;
  /** centro em coordenadas do paciente (mm, LPS) */
  center: Vec3;
  /** descrição da posição, ex.: "lado direito, terço médio, anterior" */
  location: string;
}

export interface MetalResult {
  mask: Uint8Array;
  objects: MetalObject[];
  /** limiar usado para as sementes de metal */
  seedThreshold: number;
  /** limiar baixo usado para completar as bordas do metal */
  lowThreshold: number;
}

/** Limiar de metal: titânio e ligas ficam acima de qualquer osso ou esmalte. */
export function metalThresholds(data: ArrayLike<number>, calibratedHU: boolean): { seed: number; low: number } | null {
  if (calibratedHU) return { seed: 3000, low: 2200 };
  // CBCT: valores do aparelho; usa o topo do histograma, só se houver pico separado
  const sample: number[] = [];
  const step = Math.max(1, Math.floor(data.length / 500_000));
  for (let i = 0; i < data.length; i += step) sample.push(data[i]);
  sample.sort((a, b) => a - b);
  const p50 = sample[sample.length >> 1];
  const p999 = sample[Math.floor(sample.length * 0.999)];
  const max = sample[sample.length - 1];
  if (max - p999 < 0.15 * (max - p50)) return null;
  return { seed: p999 + 0.6 * (max - p999), low: p999 };
}

function eigenSym3(m: number[]): { values: number[]; vectors: Vec3[] } {
  // Jacobi para matriz simétrica 3x3
  const a = [
    [m[0], m[1], m[2]],
    [m[1], m[3], m[4]],
    [m[2], m[4], m[5]],
  ];
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 30; sweep++) {
    let off = 0;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += a[p][q] * a[p][q];
    if (off < 1e-12) break;
    for (let p = 0; p < 3; p++)
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-15) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 3; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
  }
  const idx = [0, 1, 2].sort((i, j) => a[j][j] - a[i][i]);
  return { values: idx.map((i) => a[i][i]), vectors: idx.map((i) => [v[0][i], v[1][i], v[2][i]] as Vec3) };
}

/**
 * Detecta metal (placas, parafusos, pinos, restaurações): sementes acima do limiar de metal
 * crescidas até 1,5 mm para dentro do limiar baixo (bordas com volume parcial). Cada peça é
 * medida pelos eixos principais (comprimento, largura, espessura) e classificada pela forma.
 */
export function detectMetal(vol: Volume, calibratedHU: boolean, teethNear?: Uint8Array): MetalResult {
  const [nx, ny, nz] = vol.dims;
  const n = nx * ny * nz;
  const plane = nx * ny;
  const thr = metalThresholds(vol.data, calibratedHU);
  const mask = new Uint8Array(n);
  if (!thr) return { mask, objects: [], seedThreshold: Infinity, lowThreshold: Infinity };
  let frontier: number[] = [];
  for (let i = 0; i < n; i++)
    if (vol.data[i] >= thr.seed) {
      mask[i] = 1;
      frontier.push(i);
    }
  const steps = Math.max(1, Math.round(1.5 / Math.min(...vol.spacing)));
  for (let s = 0; s < steps && frontier.length; s++) {
    const next: number[] = [];
    for (const i of frontier) {
      const x = i % nx;
      const y = ((i / nx) | 0) % ny;
      const z = (i / plane) | 0;
      const nb = [x > 0 ? i - 1 : -1, x < nx - 1 ? i + 1 : -1, y > 0 ? i - nx : -1, y < ny - 1 ? i + nx : -1, z > 0 ? i - plane : -1, z < nz - 1 ? i + plane : -1];
      for (const j of nb)
        if (j >= 0 && !mask[j] && vol.data[j] >= thr.low) {
          mask[j] = 1;
          next.push(j);
        }
    }
    frontier = next;
  }

  // componentes (26-vizinhança: peças finas e oblíquas continuam inteiras)
  const labels = new Int32Array(n);
  const objects: MetalObject[] = [];
  const [sx, sy, sz] = vol.spacing;
  const voxelVol = sx * sy * sz;
  const d = vol.direction;
  const toWorld = (x: number, y: number, z: number): Vec3 => [
    vol.origin[0] + d[0] * x * sx + d[3] * y * sy + d[6] * z * sz,
    vol.origin[1] + d[1] * x * sx + d[4] * y * sy + d[7] * z * sz,
    vol.origin[2] + d[2] * x * sx + d[5] * y * sy + d[8] * z * sz,
  ];
  const queue = new Int32Array(n);
  let nextId = 0;
  const parts: { idx: number[] }[] = [];
  for (let s0 = 0; s0 < n; s0++) {
    if (!mask[s0] || labels[s0]) continue;
    const id = ++nextId;
    let head = 0;
    let tail = 0;
    queue[tail++] = s0;
    labels[s0] = id;
    const idx: number[] = [];
    while (head < tail) {
      const i = queue[head++];
      idx.push(i);
      const x = i % nx;
      const y = ((i / nx) | 0) % ny;
      const z = (i / plane) | 0;
      for (let dz = -1; dz <= 1; dz++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            const zz = z + dz;
            if (xx < 0 || yy < 0 || zz < 0 || xx >= nx || yy >= ny || zz >= nz) continue;
            const j = zz * plane + yy * nx + xx;
            if (mask[j] && !labels[j]) {
              labels[j] = id;
              queue[tail++] = j;
            }
          }
    }
    parts.push({ idx });
  }

  // referência anatômica: centro do volume em x (linha média aproximada) e faixas em z/y
  let objId = 0;
  for (const { idx } of parts) {
    const volume = idx.length * voxelVol;
    if (volume < 1.5) {
      for (const i of idx) mask[i] = 0; // ruído ou cintilação isolada
      continue;
    }
    // centro e covariância em mm (coordenadas do paciente)
    const pts = idx.map((i) => toWorld(i % nx, ((i / nx) | 0) % ny, (i / plane) | 0));
    const c: Vec3 = [0, 0, 0];
    for (const p of pts) for (let a = 0; a < 3; a++) c[a] += p[a] / pts.length;
    const cov = [0, 0, 0, 0, 0, 0];
    for (const p of pts) {
      const q = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
      cov[0] += q[0] * q[0];
      cov[1] += q[0] * q[1];
      cov[2] += q[0] * q[2];
      cov[3] += q[1] * q[1];
      cov[4] += q[1] * q[2];
      cov[5] += q[2] * q[2];
    }
    for (let k = 0; k < 6; k++) cov[k] /= pts.length;
    const { vectors } = eigenSym3(cov);
    const ext = vectors.map((v) => {
      let lo = Infinity;
      let hi = -Infinity;
      for (const p of pts) {
        const t = (p[0] - c[0]) * v[0] + (p[1] - c[1]) * v[1] + (p[2] - c[2]) * v[2];
        if (t < lo) lo = t;
        if (t > hi) hi = t;
      }
      return hi - lo + Math.min(sx, sy, sz);
    });
    const [length, width, thickness] = ext;
    const nearTeeth = teethNear ? idx.some((i) => teethNear[i]) : false;
    let kind: MetalKind;
    if (nearTeeth) kind = 'restauracao';
    else if (length >= 4 && length / Math.max(width, 0.5) >= 2.2 && width <= 4) kind = 'parafuso';
    else if (length >= 8 && width >= 3 && thickness <= Math.max(2.5, 0.4 * width)) kind = 'placa';
    else kind = 'fragmento';
    objects.push({ id: ++objId, kind, volume, length, width, thickness, center: c, location: '' });
  }
  describeLocations(objects, vol, toWorld);
  return { mask, objects, seedThreshold: thr.seed, lowThreshold: thr.low };
}

/** Lado (paciente), terço vertical e profundidade de cada peça, relativos à caixa do volume. */
function describeLocations(objects: MetalObject[], vol: Volume, toWorld: (x: number, y: number, z: number) => Vec3) {
  const [nx, ny, nz] = vol.dims;
  const corners = [toWorld(0, 0, 0), toWorld(nx - 1, ny - 1, nz - 1)];
  const lo = [0, 1, 2].map((a) => Math.min(corners[0][a], corners[1][a]));
  const hi = [0, 1, 2].map((a) => Math.max(corners[0][a], corners[1][a]));
  const mid = [0, 1, 2].map((a) => (lo[a] + hi[a]) / 2);
  for (const o of objects) {
    // LPS: +x = esquerda do paciente, +y = posterior, +z = superior
    const dx = o.center[0] - mid[0];
    const side = Math.abs(dx) < 6 ? 'linha média' : dx > 0 ? 'lado esquerdo' : 'lado direito';
    const rz = (o.center[2] - lo[2]) / Math.max(1, hi[2] - lo[2]);
    const level = rz < 0.33 ? 'terço inferior' : rz < 0.66 ? 'terço médio' : 'terço superior';
    const ry = (o.center[1] - lo[1]) / Math.max(1, hi[1] - lo[1]);
    const depth = ry < 0.4 ? 'anterior' : ry < 0.65 ? 'intermediário' : 'posterior';
    o.location = `${side}, ${level} do exame, ${depth}`;
  }
}

/** Região perto do esmalte (até ~1,5 mm): metal ali é restauração/coroa, não placa ou parafuso. */
export function enamelNear(vol: Volume, metalSeed: number, calibratedHU: boolean): Uint8Array {
  const [nx, ny] = vol.dims;
  const n = vol.data.length;
  const plane = nx * ny;
  const lo = calibratedHU ? 2300 : metalSeed * 0.8;
  const near = new Uint8Array(n);
  let frontier: number[] = [];
  for (let i = 0; i < n; i++)
    if (vol.data[i] >= lo && vol.data[i] < metalSeed) {
      near[i] = 1;
      frontier.push(i);
    }
  const steps = Math.max(1, Math.round(1.5 / Math.min(...vol.spacing)));
  for (let s = 0; s < steps && frontier.length; s++) {
    const next: number[] = [];
    for (const i of frontier)
      for (const d of [1, -1, nx, -nx, plane, -plane]) {
        const j = i + d;
        if (j < 0 || j >= n || near[j]) continue;
        near[j] = 1;
        next.push(j);
      }
    frontier = next;
  }
  return near;
}
