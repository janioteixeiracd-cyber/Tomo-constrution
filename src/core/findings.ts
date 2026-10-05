import type { MetalObject } from './metal';
import { worldToIndex } from './segedit';
import type { Region } from './softseg';
import type { Vec3, Volume } from './types';

/**
 * Leitura automática do exame inteiro, por regras de densidade e forma: gera medidas e achados
 * localizados (sem imagens) para a IA interpretar. Rótulos: 1 crânio/face, 2 mandíbula, 3 dentes,
 * 4 metal, 5 ar interno, 6 vasos.
 */
export interface FindingsInput {
  vol: Volume;
  labels: Uint8Array;
  metal: MetalObject[];
  air: Region[];
  vessels: Region[] | null;
  threshold: number;
  calibratedHU: boolean;
}

export interface LowDensityArea {
  volume: number;
  meanHU: number;
  size: Vec3;
  center: Vec3;
  position: string;
}

export interface ExamFindings {
  /** texto estruturado, em português, para a IA e para a tela */
  text: string;
  mandibleSymmetry: number | null;
  mandibleParts: number;
  lowDensity: LowDensityArea[];
  fragments: { volume: number; position: string }[];
}

const isBone = (l: number) => l === 1 || l === 2 || l === 3;
const fmt = (v: number, d = 1) => v.toLocaleString('pt-BR', { maximumFractionDigits: d, minimumFractionDigits: 0 });
const cm3 = (mm3: number) => `${fmt(mm3 / 1000, mm3 < 10000 ? 2 : 1)} cm³`;

/** Componentes conexos (6-viz.) de mask; devolve rótulos e listas de voxels dos que passam de minVoxels. */
function components(mask: Uint8Array, dims: Vec3, minVoxels: number): number[][] {
  const [nx, ny, nz] = dims;
  const plane = nx * ny;
  const seen = new Uint8Array(mask.length);
  const out: number[][] = [];
  const queue = new Int32Array(mask.length);
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || seen[s]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = s;
    seen[s] = 1;
    while (head < tail) {
      const i = queue[head++];
      const x = i % nx;
      const y = ((i / nx) | 0) % ny;
      const z = (i / plane) | 0;
      if (x > 0 && mask[i - 1] && !seen[i - 1]) (seen[i - 1] = 1), (queue[tail++] = i - 1);
      if (x < nx - 1 && mask[i + 1] && !seen[i + 1]) (seen[i + 1] = 1), (queue[tail++] = i + 1);
      if (y > 0 && mask[i - nx] && !seen[i - nx]) (seen[i - nx] = 1), (queue[tail++] = i - nx);
      if (y < ny - 1 && mask[i + nx] && !seen[i + nx]) (seen[i + nx] = 1), (queue[tail++] = i + nx);
      if (z > 0 && mask[i - plane] && !seen[i - plane]) (seen[i - plane] = 1), (queue[tail++] = i - plane);
      if (z < nz - 1 && mask[i + plane] && !seen[i + plane]) (seen[i + plane] = 1), (queue[tail++] = i + plane);
    }
    if (tail >= minVoxels) out.push(Array.from(queue.subarray(0, tail)));
  }
  return out.sort((a, b) => b.length - a.length);
}

function erode6(mask: Uint8Array, dims: Vec3): Uint8Array {
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

export function examFindings(inp: FindingsInput): ExamFindings {
  const { vol, labels } = inp;
  const [nx, ny, nz] = vol.dims;
  const plane = nx * ny;
  const [sx, sy, sz] = vol.spacing;
  const voxel = sx * sy * sz;
  const d = vol.direction;
  const toWorld = (x: number, y: number, z: number): Vec3 => [
    vol.origin[0] + d[0] * x * sx + d[3] * y * sy + d[6] * z * sz,
    vol.origin[1] + d[1] * x * sx + d[4] * y * sy + d[7] * z * sz,
    vol.origin[2] + d[2] * x * sx + d[5] * y * sy + d[8] * z * sz,
  ];
  const xyz = (i: number): Vec3 => [i % nx, ((i / nx) | 0) % ny, (i / plane) | 0];
  const worldOf = (i: number) => toWorld(...xyz(i));
  // a grade costuma ser axial (x = direita-esquerda); sem isso, simetria por espelho não vale
  const axisAligned = Math.abs(d[0]) > 0.95 && Math.abs(d[4]) > 0.95 && Math.abs(d[8]) > 0.95;

  // referências: linha média (meio da largura óssea), plano oclusal (dentes) e face anterior do esqueleto
  const xs: number[] = [];
  let teethZ: number[] = [];
  let boneCount = 0;
  let anteriorY = Infinity;
  let zLo = Infinity;
  let zHi = -Infinity;
  let yHi = -Infinity;
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i];
    if (!isBone(l)) continue;
    boneCount++;
    const p = worldOf(i);
    if ((i & 7) === 0) xs.push(p[0]);
    if (l === 3 && (i & 3) === 0) teethZ.push(p[2]);
    anteriorY = Math.min(anteriorY, p[1]);
    yHi = Math.max(yHi, p[1]);
    zLo = Math.min(zLo, p[2]);
    zHi = Math.max(zHi, p[2]);
  }
  if (!boneCount) {
    return { text: 'Nenhum osso encontrado com o limiar atual; não foi possível ler o exame.', mandibleSymmetry: null, mandibleParts: 0, lowDensity: [], fragments: [] };
  }
  xs.sort((a, b) => a - b);
  const pct = (arr: number[], p: number) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];
  const xLeft = pct(xs, 0.98);
  const xRight = pct(xs, 0.02);
  const midX = (xLeft + xRight) / 2;
  teethZ.sort((a, b) => a - b);
  const occlusalZ = teethZ.length > 50 ? pct(teethZ, 0.5) : null;
  teethZ = [];

  const position = (p: Vec3) => {
    const dx = p[0] - midX;
    const side = Math.abs(dx) < 6 ? 'linha média' : `${dx > 0 ? 'lado esquerdo' : 'lado direito'} (${fmt(Math.abs(dx), 0)} mm da linha média)`;
    const vert =
      occlusalZ != null
        ? `${fmt(Math.abs(p[2] - occlusalZ), 0)} mm ${p[2] >= occlusalZ ? 'acima' : 'abaixo'} do plano oclusal`
        : `${fmt(p[2] - zLo, 0)} mm acima do ponto ósseo mais baixo`;
    return `${side}, ${vert}, ${fmt(p[1] - anteriorY, 0)} mm atrás do ponto ósseo mais anterior`;
  };
  const labelNear = (p: Vec3) => {
    const [cx, cy, cz] = worldToIndex(vol, p);
    const r = Math.max(1, Math.round(3 / Math.min(sx, sy, sz)));
    const count = new Map<number, number>();
    for (let z = cz - r; z <= cz + r; z++)
      for (let y = cy - r; y <= cy + r; y++)
        for (let x = cx - r; x <= cx + r; x++) {
          if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) continue;
          const l = labels[(z * ny + y) * nx + x];
          if (l === 1 || l === 2 || l === 3) count.set(l, (count.get(l) ?? 0) + 1);
        }
    const best = [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
    return best === 2 ? 'mandíbula' : best === 3 ? 'dentes' : best === 1 ? 'crânio/maxila/face' : 'fora do osso';
  };
  const midIdx = axisAligned ? (worldToIndex(vol, [midX, vol.origin[1], vol.origin[2]])[0] as number) : 0;
  const mirror = (x: number) => Math.round(2 * midIdx - x);

  const out: string[] = [];
  const lowDensity: LowDensityArea[] = [];
  const fragments: { volume: number; position: string }[] = [];

  // ---------- cobertura ----------
  out.push('## Cobertura e referências');
  out.push(
    `- Esqueleto reconstruído: ${fmt(zHi - zLo, 0)} mm de altura (craniocaudal), ${fmt(xLeft - xRight, 0)} mm de largura, ${fmt(yHi - anteriorY, 0)} mm de profundidade; osso total ${cm3(boneCount * voxel)} (limiar ${inp.threshold} HU${inp.calibratedHU ? '' : ', escala do aparelho, sem HU calibrado'}).`,
  );
  out.push(
    occlusalZ != null
      ? '- Posições abaixo são relativas à linha média (meio da largura óssea), ao plano oclusal (altura mediana dos dentes) e ao ponto ósseo mais anterior.'
      : '- Sem dentes identificados; alturas relativas ao ponto ósseo mais baixo do exame.',
  );

  // ---------- mandíbula ----------
  let mandCount = 0;
  let mandHU = 0;
  let mandL = 0;
  let mandR = 0;
  let mandOverlap = 0;
  const ramus = { L: [Infinity, -Infinity], R: [Infinity, -Infinity] };
  const mandMask = new Uint8Array(labels.length);
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] !== 2) continue;
    mandMask[i] = 1;
    mandCount++;
    mandHU += vol.data[i];
    const p = worldOf(i);
    const dx = p[0] - midX;
    if (dx > 0) mandL++;
    else mandR++;
    if (Math.abs(dx) > 25) {
      const r = dx > 0 ? ramus.L : ramus.R;
      r[0] = Math.min(r[0], p[2]);
      r[1] = Math.max(r[1], p[2]);
    }
    if (axisAligned) {
      const [x, y, z] = xyz(i);
      const xm = mirror(x);
      if (xm >= 0 && xm < nx && labels[z * plane + y * nx + xm] === 2) mandOverlap++;
    }
  }
  let mandibleSymmetry: number | null = null;
  let mandibleParts = 0;
  out.push('', '## Mandíbula');
  if (mandCount * voxel < 5000) {
    out.push('- Mandíbula não separada automaticamente (fora do campo, unida ao crânio no limiar atual ou ausente).');
  } else {
    mandibleSymmetry = axisAligned ? mandOverlap / mandCount : null;
    out.push(
      `- Volume ${cm3(mandCount * voxel)}; lado direito ${cm3(mandR * voxel)}, lado esquerdo ${cm3(mandL * voxel)} (diferença ${fmt((Math.abs(mandL - mandR) / Math.max(1, (mandL + mandR) / 2)) * 100, 0)}%).`,
    );
    if (mandibleSymmetry != null)
      out.push(`- Simetria por espelho na linha média: ${fmt(mandibleSymmetry * 100, 0)}% de sobreposição (mandíbulas normais costumam ficar acima de ~75%; desvio, fratura deslocada, ressecção ou lesão expansiva reduzem).`);
    if (Number.isFinite(ramus.L[0]) && Number.isFinite(ramus.R[0]))
      out.push(`- Altura vertical das porções laterais (ramo + corpo): direita ${fmt(ramus.R[1] - ramus.R[0], 0)} mm, esquerda ${fmt(ramus.L[1] - ramus.L[0], 0)} mm.`);
    if (inp.calibratedHU) out.push(`- Densidade média do osso mandibular segmentado: ${fmt(mandHU / mandCount, 0)} HU.`);
    const parts = components(mandMask, vol.dims, Math.ceil(400 / voxel));
    mandibleParts = parts.length;
    if (parts.length > 1) {
      out.push(`- **A mandíbula aparece em ${parts.length} partes separadas** (possível descontinuidade: fratura com afastamento, ressecção, ou osso fino abaixo do limiar):`);
      for (const c of parts.slice(0, 5)) {
        const ctr = centroid(c, worldOf);
        out.push(`  - ${cm3(c.length * voxel)} — ${position(ctr)}`);
      }
    } else out.push('- Mandíbula contínua no limiar atual (uma peça só).');

    // áreas hipodensas internas: buracos de cada corte axial, que resistem a erosão de ~2 mm (exclui o canal)
    const holes = new Uint8Array(labels.length);
    const reach = new Uint8Array(plane);
    const stack: number[] = [];
    for (let z = 0; z < nz; z++) {
      const off = z * plane;
      let any = false;
      for (let k = 0; k < plane; k++) if (mandMask[off + k]) any = true;
      if (!any) continue;
      reach.fill(0);
      for (let x = 0; x < nx; x++)
        for (const y of [0, ny - 1]) {
          const k = y * nx + x;
          if (!mandMask[off + k] && !reach[k]) (reach[k] = 1), stack.push(k);
        }
      for (let y = 0; y < ny; y++)
        for (const x of [0, nx - 1]) {
          const k = y * nx + x;
          if (!mandMask[off + k] && !reach[k]) (reach[k] = 1), stack.push(k);
        }
      while (stack.length) {
        const k = stack.pop()!;
        const x = k % nx;
        const y = (k / nx) | 0;
        for (const j of [x > 0 ? k - 1 : -1, x < nx - 1 ? k + 1 : -1, y > 0 ? k - nx : -1, y < ny - 1 ? k + nx : -1])
          if (j >= 0 && !reach[j] && !mandMask[off + j]) (reach[j] = 1), stack.push(j);
      }
      for (let k = 0; k < plane; k++) {
        const l = labels[off + k];
        if (!reach[k] && !mandMask[off + k] && l !== 3 && l !== 4 && vol.data[off + k] > -300) holes[off + k] = 1;
      }
    }
    let core: Uint8Array = holes;
    const steps = Math.max(1, Math.round(2 / Math.min(sx, sy, sz)));
    for (let s = 0; s < steps; s++) core = erode6(core, vol.dims);
    for (const c of components(holes, vol.dims, Math.ceil(80 / voxel))) {
      if (!c.some((i) => core[i])) continue;
      let hu = 0;
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (const i of c) {
        hu += vol.data[i];
        const p = worldOf(i);
        for (let a = 0; a < 3; a++) (lo[a] = Math.min(lo[a], p[a])), (hi[a] = Math.max(hi[a], p[a]));
      }
      const ctr = centroid(c, worldOf);
      lowDensity.push({
        volume: c.length * voxel,
        meanHU: hu / c.length,
        size: [hi[0] - lo[0] + sx, hi[1] - lo[1] + sy, hi[2] - lo[2] + sz],
        center: ctr,
        position: position(ctr),
      });
    }
    if (lowDensity.length) {
      out.push(`- **Áreas hipodensas dentro da mandíbula** (cercadas por osso, mais largas que o canal mandibular): ${lowDensity.length}.`);
      for (const a of lowDensity.slice(0, 6)) {
        const long = Math.max(...a.size) > 3 * Math.min(...a.size) && Math.max(...a.size) > 30;
        out.push(
          `  - ${cm3(a.volume)}, ${fmt(a.size[0], 0)} × ${fmt(a.size[1], 0)} × ${fmt(a.size[2], 0)} mm (LR × AP × altura), densidade média ${fmt(a.meanHU, 0)}${inp.calibratedHU ? ' HU' : ''} — ${a.position}${long ? ' (alongada, acompanhando o corpo: mais provável medular de baixa densidade ou canal)' : ''}`,
        );
      }
      out.push('  - Podem ser lesão (cisto, tumor, rarefação periapical), alvéolo pós-extração, medular de baixa densidade ou forame; precisa de confirmação nos cortes.');
    } else out.push('- Nenhuma área hipodensa interna maior que o canal mandibular foi encontrada no osso segmentado.');
  }

  // ---------- simetria geral ----------
  if (axisAligned) {
    out.push('', '## Simetria do esqueleto facial (espelho na linha média)');
    const thirds = [0, 0, 0].map(() => ({ n: 0, ov: 0, l: 0, r: 0 }));
    for (let i = 0; i < labels.length; i++) {
      if (!isBone(labels[i])) continue;
      const [x, y, z] = xyz(i);
      const p = toWorld(x, y, z);
      const t = thirds[Math.min(2, Math.floor(((p[2] - zLo) / Math.max(1, zHi - zLo)) * 3))];
      t.n++;
      if (p[0] > midX) t.l++;
      else t.r++;
      const xm = mirror(x);
      if (xm >= 0 && xm < nx && isBone(labels[z * plane + y * nx + xm])) t.ov++;
    }
    ['Terço inferior', 'Terço médio', 'Terço superior'].forEach((name, k) => {
      const t = thirds[k];
      if (t.n * voxel < 2000) return;
      out.push(`- ${name} do volume: sobreposição ${fmt((t.ov / t.n) * 100, 0)}%; osso à direita ${cm3(t.r * voxel)}, à esquerda ${cm3(t.l * voxel)}.`);
    });
    out.push('- Inclinação da cabeça no aparelho também reduz a sobreposição; compare os terços entre si.');
  }

  // ---------- fragmentos isolados ----------
  const boneMask = new Uint8Array(labels.length);
  for (let i = 0; i < labels.length; i++) if (isBone(labels[i])) boneMask[i] = 1;
  const comps = components(boneMask, vol.dims, Math.ceil(150 / voxel));
  const isolated = comps.slice(1).filter((c) => {
    let m = 0;
    for (const i of c) if (labels[i] === 2) m++;
    return !(m > c.length / 2 && c.length * voxel > 10000); // a própria mandíbula, quando solta
  });
  out.push('', '## Partes ósseas isoladas');
  if (isolated.length) {
    out.push(`- ${isolated.length} parte(s) óssea(s) sem ligação com o conjunto principal (fragmento deslocado, osso hioide, vértebra, ou osso fino interrompido pelo limiar):`);
    for (const c of isolated.slice(0, 8)) {
      const ctr = centroid(c, worldOf);
      const f = { volume: c.length * voxel, position: position(ctr) };
      fragments.push(f);
      out.push(`  - ${cm3(f.volume)} — ${f.position}`);
    }
  } else out.push('- Nenhuma: o osso forma um conjunto contínuo (além da mandíbula).');

  // ---------- dentes ----------
  out.push('', '## Dentes');
  let up = 0;
  let low = 0;
  let tl = 0;
  let tr = 0;
  const teethMask = new Uint8Array(labels.length);
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] !== 3) continue;
    teethMask[i] = 1;
    const p = worldOf(i);
    if (occlusalZ != null && p[2] >= occlusalZ) up++;
    else low++;
    if (p[0] > midX) tl++;
    else tr++;
  }
  if (up + low === 0) out.push('- Nenhum dente identificado (edêntulo, fora do campo ou esmalte abaixo do detectável).');
  else {
    const blocks = components(teethMask, vol.dims, Math.ceil(15 / voxel));
    let bu = 0;
    for (const c of blocks) if (occlusalZ != null && centroid(c, worldOf)[2] >= occlusalZ) bu++;
    out.push(
      `- Tecido dentário: ${cm3((up + low) * voxel)}; acima do plano oclusal ${cm3(up * voxel)}, abaixo ${cm3(low * voxel)}; direita ${cm3(tr * voxel)}, esquerda ${cm3(tl * voxel)}.`,
    );
    out.push(
      `- ${blocks.length} bloco(s) dentário(s) separados (${bu} superiores, ${blocks.length - bu} inferiores). Dentes em contato contam como um bloco: não é a contagem de dentes; uma diferença grande entre direita e esquerda sugere ausências ou inclusos de um lado.`,
    );
  }

  // ---------- metal ----------
  out.push('', '## Material metálico');
  if (!inp.metal.length) out.push('- Nenhum metal identificado.');
  else {
    const names = { parafuso: 'Parafuso/pino', placa: 'Placa', restauracao: 'Restauração/coroa', fragmento: 'Peça metálica' } as const;
    out.push(`- ${inp.metal.length} peça(s):`);
    for (const m of inp.metal.slice(0, 20))
      out.push(
        `  - ${names[m.kind]}: ${fmt(m.length, 0)} × ${fmt(m.width, 0)} × ${fmt(m.thickness, 1)} mm, ${fmt(m.volume, 0)} mm³; junto de ${labelNear(m.center)} — ${position(m.center)}`,
      );
    if (inp.metal.length > 20) out.push(`  - … e mais ${inp.metal.length - 20}.`);
    out.push('- Medidas pelo eixo principal; o brilho do metal aumenta um pouco o tamanho aparente.');
  }

  // ---------- seios e vias aéreas ----------
  out.push('', '## Seios paranasais e vias aéreas (ar interno)');
  if (!inp.air.length) out.push('- Nenhum espaço aéreo interno grande encontrado.');
  else {
    const depth = (r: Region) => r.center[1] - anteriorY;
    const lat = (r: Region) => Math.abs(r.center[0] - midX);
    const above = (r: Region) => occlusalZ == null || r.center[2] > occlusalZ;
    const hint = (r: Region) => {
      if (lat(r) > 30 && depth(r) > 80) return 'provável mastoide/orelha média';
      if (lat(r) < 12) return depth(r) > 55 ? 'provável faringe/nasofaringe' : 'provável cavidade nasal';
      if (lat(r) <= 45 && depth(r) <= 75 && above(r)) return `provável seio maxilar${lat(r) < 18 ? ' (pode incluir a cavidade nasal)' : ''}`;
      return 'outro espaço aéreo';
    };
    for (const r of inp.air.slice(0, 8)) out.push(`- ${cm3(r.volume)} — ${hint(r)}; ${position(r.center)}`);
    const sinus = (sign: number) =>
      inp.air
        .filter((r) => Math.sign(r.center[0] - midX) === sign && hint(r).startsWith('provável seio maxilar'))
        .sort((a, b) => b.volume - a.volume)[0];
    const L = sinus(1);
    const R = sinus(-1);
    if (L && R)
      out.push(
        `- Ar dos prováveis seios maxilares: direita ${cm3(R.volume)}, esquerda ${cm3(L.volume)}. Ar bem menor de um lado sugere velamento (espessamento mucoso, secreção, sangue) ou seio menor; um seio unido à cavidade nasal aparece maior.`,
      );
    else if (L || R) out.push(`- Só um provável seio maxilar com ar (${L ? 'esquerdo' : 'direito'}): o outro pode estar velado (sem ar), unido à cavidade nasal ou fora do campo.`);
    else out.push('- Nenhum espaço aéreo compatível com seio maxilar: velamento bilateral, fora do campo ou limite do método.');
  }

  if (inp.vessels) {
    out.push('', '## Vasos (exame com contraste)');
    out.push(inp.vessels.length ? `- ${inp.vessels.length} grupo(s) realçado(s); maiores: ${inp.vessels.slice(0, 4).map((r) => `${cm3(r.volume)} (${position(r.center)})`).join('; ')}.` : '- Nenhum vaso realçado separado do osso.');
  }

  return { text: out.join('\n'), mandibleSymmetry, mandibleParts, lowDensity, fragments };
}

function centroid(idx: number[], worldOf: (i: number) => Vec3): Vec3 {
  const c: Vec3 = [0, 0, 0];
  const step = Math.max(1, Math.floor(idx.length / 5000));
  let n = 0;
  for (let k = 0; k < idx.length; k += step) {
    const p = worldOf(idx[k]);
    c[0] += p[0];
    c[1] += p[1];
    c[2] += p[2];
    n++;
  }
  return [c[0] / n, c[1] / n, c[2] / n];
}
