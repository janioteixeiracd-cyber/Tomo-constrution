import type { Vec3, Volume } from './types';

type Grid = Pick<Volume, 'dims' | 'spacing' | 'origin' | 'direction'>;

/** Índice de voxel mais próximo de um ponto do paciente (mm). */
export function worldToIndex(g: Grid, p: Vec3): Vec3 {
  const d = g.direction;
  const q = [p[0] - g.origin[0], p[1] - g.origin[1], p[2] - g.origin[2]];
  return [0, 1, 2].map((a) => Math.round((d[a * 3] * q[0] + d[a * 3 + 1] * q[1] + d[a * 3 + 2] * q[2]) / g.spacing[a])) as Vec3;
}

/** Rótulo no ponto tocado (procura o voxel rotulado mais próximo, até `radius` voxels). */
export function labelAt(labels: Uint8Array, g: Grid, p: Vec3, radius = 3): { label: number; index: number } | null {
  const [nx, ny, nz] = g.dims;
  const [cx, cy, cz] = worldToIndex(g, p);
  let best: { label: number; index: number; d: number } | null = null;
  for (let dz = -radius; dz <= radius; dz++)
    for (let dy = -radius; dy <= radius; dy++)
      for (let dx = -radius; dx <= radius; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const z = cz + dz;
        if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) continue;
        const i = (z * ny + y) * nx + x;
        const l = labels[i];
        if (!l) continue;
        const d = dx * dx + dy * dy + dz * dz;
        if (!best || d < best.d) best = { label: l, index: i, d };
      }
  return best ? { label: best.label, index: best.index } : null;
}

function erodeWithin(mask: Uint8Array, dims: Vec3): Uint8Array {
  const [nx, ny, nz] = dims;
  const plane = nx * ny;
  const out = new Uint8Array(mask.length);
  for (let z = 1; z < nz - 1; z++)
    for (let y = 1; y < ny - 1; y++)
      for (let x = 1; x < nx - 1; x++) {
        const i = z * plane + y * nx + x;
        if (mask[i] && mask[i - 1] && mask[i + 1] && mask[i - nx] && mask[i + nx] && mask[i - plane] && mask[i + plane]) out[i] = 1;
      }
  return out;
}

/** Componente conexo (6-vizinhança) de mask que contém start. */
function componentOf(mask: Uint8Array, dims: Vec3, start: number): Uint32Array {
  const [nx, ny, nz] = dims;
  const plane = nx * ny;
  const seen = new Uint8Array(mask.length);
  const out: number[] = [];
  const stack = [start];
  seen[start] = 1;
  while (stack.length) {
    const i = stack.pop()!;
    out.push(i);
    const x = i % nx;
    const y = ((i / nx) | 0) % ny;
    const z = (i / plane) | 0;
    const nb = [x > 0 ? i - 1 : -1, x < nx - 1 ? i + 1 : -1, y > 0 ? i - nx : -1, y < ny - 1 ? i + nx : -1, z > 0 ? i - plane : -1, z < nz - 1 ? i + plane : -1];
    for (const j of nb)
      if (j >= 0 && mask[j] && !seen[j]) {
        seen[j] = 1;
        stack.push(j);
      }
  }
  return Uint32Array.from(out);
}

/** Voxel de mask mais próximo de `index` dentro de um raio (em voxels). */
function nearestIn(mask: Uint8Array, dims: Vec3, index: number, radius: number): number {
  const [nx, ny, nz] = dims;
  const x0 = index % nx;
  const y0 = ((index / nx) | 0) % ny;
  const z0 = (index / (nx * ny)) | 0;
  let best = -1;
  let bd = Infinity;
  for (let dz = -radius; dz <= radius; dz++)
    for (let dy = -radius; dy <= radius; dy++)
      for (let dx = -radius; dx <= radius; dx++) {
        const x = x0 + dx;
        const y = y0 + dy;
        const z = z0 + dz;
        if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) continue;
        const i = (z * ny + y) * nx + x;
        const d = dx * dx + dy * dy + dz * dz;
        if (mask[i] && d < bd) {
          bd = d;
          best = i;
        }
      }
  return best;
}

export interface SplitResult {
  ok: boolean;
  message: string;
  /** rótulo de origem (que perdeu voxels) */
  from: number;
  /** quantos voxels passaram para o novo rótulo */
  moved: number;
}

/**
 * Separa por toque: a partir do ponto tocado, aplica erosão progressiva só dentro da estrutura
 * tocada até a parte tocada se soltar do resto (as pontes ósseas mais finas se rompem primeiro);
 * depois devolve a cada parte o osso removido pela erosão, pela proximidade.
 */
export function splitBySeed(labels: Uint8Array, g: Grid, p: Vec3, newLabel: number, maxErosionMm = 5): SplitResult {
  const hit = labelAt(labels, g, p);
  if (!hit) return { ok: false, message: 'Nenhuma estrutura no ponto tocado.', from: 0, moved: 0 };
  const from = hit.label;
  const n = labels.length;
  const dims = g.dims;
  const mask = new Uint8Array(n);
  let total = 0;
  for (let i = 0; i < n; i++)
    if (labels[i] === from) {
      mask[i] = 1;
      total++;
    }
  const maxSteps = Math.max(1, Math.round(maxErosionMm / Math.min(...g.spacing)));
  let eroded: Uint8Array = mask;
  for (let step = 1; step <= maxSteps; step++) {
    eroded = erodeWithin(eroded, dims);
    const seed = nearestIn(eroded, dims, hit.index, step + 3);
    if (seed < 0) break;
    let erodedTotal = 0;
    for (let i = 0; i < n; i++) erodedTotal += eroded[i];
    const comp = componentOf(eroded, dims, seed);
    if (comp.length >= erodedTotal * 0.85) continue; // ainda unido ao restante
    // separou: cresce de volta competindo com o restante da estrutura
    const owner = new Uint8Array(n); // 1 = parte tocada, 2 = restante
    let frontier: number[] = [];
    for (const i of comp) owner[i] = 1;
    for (let i = 0; i < n; i++) {
      if (eroded[i] && !owner[i]) owner[i] = 2;
      if (owner[i]) frontier.push(i);
    }
    const [nx, ny] = dims;
    const plane = nx * ny;
    const nb = [1, -1, nx, -nx, plane, -plane];
    while (frontier.length) {
      const next: number[] = [];
      for (const i of frontier)
        for (const d of nb) {
          const j = i + d;
          if (j < 0 || j >= n || owner[j] || !mask[j]) continue;
          owner[j] = owner[i];
          next.push(j);
        }
      frontier = next;
    }
    let moved = 0;
    for (let i = 0; i < n; i++)
      if (owner[i] === 1) {
        labels[i] = newLabel;
        moved++;
      }
    if (moved > total * 0.95) {
      // pegou quase tudo: não houve separação útil — desfaz
      for (let i = 0; i < n; i++) if (owner[i] === 1) labels[i] = from;
      break;
    }
    return { ok: true, message: `Separada com ${(step * Math.min(...g.spacing)).toFixed(1)} mm de erosão.`, from, moved };
  }
  return {
    ok: false,
    message: 'Esta parte está unida ao restante por osso espesso (ou sutura não visível). Use "Cortar pelo plano" para separá-la.',
    from,
    moved: 0,
  };
}

/**
 * Cortar pelo plano: dentro da estrutura tocada, a parte conectada ao ponto tocado e do mesmo lado
 * do plano vira a nova estrutura.
 */
export function splitByPlane(labels: Uint8Array, g: Grid, p: Vec3, planeOrigin: Vec3, planeNormal: Vec3, newLabel: number): SplitResult {
  const hit = labelAt(labels, g, p);
  if (!hit) return { ok: false, message: 'Nenhuma estrutura no ponto tocado.', from: 0, moved: 0 };
  const from = hit.label;
  const [nx, ny, nz] = g.dims;
  const n = labels.length;
  const d = g.direction;
  const [sx, sy, sz] = g.spacing;
  const side = (x: number, y: number, z: number) => {
    let s = 0;
    for (let a = 0; a < 3; a++) {
      const w = g.origin[a] + d[a] * x * sx + d[3 + a] * y * sy + d[6 + a] * z * sz;
      s += (w - planeOrigin[a]) * planeNormal[a];
    }
    return s >= 0;
  };
  const seedSide = (() => {
    const i = hit.index;
    return side(i % nx, ((i / nx) | 0) % ny, (i / (nx * ny)) | 0);
  })();
  const mask = new Uint8Array(n);
  let total = 0;
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        const i = (z * ny + y) * nx + x;
        if (labels[i] !== from) continue;
        total++;
        if (side(x, y, z) === seedSide) mask[i] = 1;
      }
  const comp = componentOf(mask, g.dims, hit.index);
  if (comp.length >= total * 0.98) return { ok: false, message: 'O plano não corta esta estrutura. Mova o corte do modelo até a estrutura e tente de novo.', from, moved: 0 };
  for (const i of comp) labels[i] = newLabel;
  return { ok: true, message: 'Parte separada pelo plano.', from, moved: comp.length };
}

/** Campo para a superfície de um rótulo (isovalor 0), preservando a forma suave do campo original. */
export function labelField(labels: Uint8Array, id: number, base: Float32Array): Float32Array {
  const out = new Float32Array(labels.length);
  for (let i = 0; i < labels.length; i++) out[i] = labels[i] === id ? Math.max(0.01, base[i]) : -0.01 - Math.abs(base[i]) * 0.05;
  return out;
}
