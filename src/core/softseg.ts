import type { Vec3, Volume } from './types';

export interface Region {
  volume: number;
  center: Vec3;
  location: string;
}

function toWorldFn(vol: Volume) {
  const d = vol.direction;
  const [sx, sy, sz] = vol.spacing;
  return (x: number, y: number, z: number): Vec3 => [
    vol.origin[0] + d[0] * x * sx + d[3] * y * sy + d[6] * z * sz,
    vol.origin[1] + d[1] * x * sx + d[4] * y * sy + d[7] * z * sz,
    vol.origin[2] + d[2] * x * sx + d[5] * y * sy + d[8] * z * sz,
  ];
}

/** Componentes conexos (6-viz.) de mask; remove os menores que minMm3 e descreve os demais. */
function regions(mask: Uint8Array, vol: Volume, minMm3: number): Region[] {
  const [nx, ny, nz] = vol.dims;
  const plane = nx * ny;
  const voxel = vol.spacing[0] * vol.spacing[1] * vol.spacing[2];
  const seen = new Uint8Array(mask.length);
  const toWorld = toWorldFn(vol);
  const out: Region[] = [];
  const stack: number[] = [];
  const lo = toWorld(0, 0, 0);
  const hi = toWorld(nx - 1, ny - 1, nz - 1);
  const mid = [0, 1, 2].map((a) => (lo[a] + hi[a]) / 2);
  const span = [0, 1, 2].map((a) => Math.abs(hi[a] - lo[a]) || 1);
  const minA = [0, 1, 2].map((a) => Math.min(lo[a], hi[a]));
  for (let s0 = 0; s0 < mask.length; s0++) {
    if (!mask[s0] || seen[s0]) continue;
    const idx: number[] = [];
    stack.push(s0);
    seen[s0] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      idx.push(i);
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
    const volume = idx.length * voxel;
    if (volume < minMm3) {
      for (const i of idx) mask[i] = 0;
      continue;
    }
    const c: Vec3 = [0, 0, 0];
    for (const i of idx) {
      const p = toWorld(i % nx, ((i / nx) | 0) % ny, (i / plane) | 0);
      c[0] += p[0] / idx.length;
      c[1] += p[1] / idx.length;
      c[2] += p[2] / idx.length;
    }
    // LPS: +x esquerda, +y posterior, +z superior
    const dx = c[0] - mid[0];
    const side = Math.abs(dx) < 8 ? 'linha média' : dx > 0 ? 'lado esquerdo' : 'lado direito';
    const rz = (c[2] - minA[2]) / span[2];
    const ry = (c[1] - minA[1]) / span[1];
    const location = `${side}, ${rz < 0.33 ? 'terço inferior' : rz < 0.66 ? 'terço médio' : 'terço superior'}, ${ry < 0.4 ? 'anterior' : ry < 0.65 ? 'intermediário' : 'posterior'}`;
    out.push({ volume, center: c, location });
  }
  return out.sort((a, b) => b.volume - a.volume);
}

/**
 * Seios paranasais e vias aéreas: ar dentro da cabeça. Em cada corte axial, o ar ligado à borda
 * da imagem é o ar de fora; o restante (seios, cavidade nasal, faringe, boca fechada) é interno.
 */
export function segmentAirways(vol: Volume, airHU = -400): { mask: Uint8Array; regions: Region[] } {
  const [nx, ny, nz] = vol.dims;
  const plane = nx * ny;
  const mask = new Uint8Array(vol.data.length);
  const external = new Uint8Array(plane);
  const stack: number[] = [];
  for (let z = 0; z < nz; z++) {
    const off = z * plane;
    external.fill(0);
    const push = (i: number) => {
      if (!external[i] && vol.data[off + i] < airHU) {
        external[i] = 1;
        stack.push(i);
      }
    };
    for (let x = 0; x < nx; x++) {
      push(x);
      push((ny - 1) * nx + x);
    }
    for (let y = 0; y < ny; y++) {
      push(y * nx);
      push(y * nx + nx - 1);
    }
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % nx;
      const y = (i / nx) | 0;
      if (x > 0) push(i - 1);
      if (x < nx - 1) push(i + 1);
      if (y > 0) push(i - nx);
      if (y < ny - 1) push(i + nx);
    }
    for (let i = 0; i < plane; i++) if (vol.data[off + i] < airHU && !external[i]) mask[off + i] = 1;
  }
  return { mask, regions: regions(mask, vol, 150) };
}

/**
 * Vasos realçados por contraste: densidade de sangue contrastado (150–500 HU), longe do osso
 * (a borda do osso tem a mesma faixa por volume parcial) e em grupos de tamanho mínimo.
 */
export function segmentVessels(vol: Volume, lo = 150, hi = 500, boneHU = 700): { mask: Uint8Array; regions: Region[] } {
  const [nx, ny] = vol.dims;
  const plane = nx * ny;
  const n = vol.data.length;
  // distância ao osso denso, em passos de voxel (até ~1,5 mm)
  const nearBone = new Uint8Array(n);
  let frontier: number[] = [];
  for (let i = 0; i < n; i++)
    if (vol.data[i] >= boneHU) {
      nearBone[i] = 1;
      frontier.push(i);
    }
  const steps = Math.max(1, Math.round(1.5 / Math.min(...vol.spacing)));
  for (let s = 0; s < steps && frontier.length; s++) {
    const next: number[] = [];
    for (const i of frontier)
      for (const d of [1, -1, nx, -nx, plane, -plane]) {
        const j = i + d;
        if (j < 0 || j >= n || nearBone[j]) continue;
        nearBone[j] = 1;
        next.push(j);
      }
    frontier = next;
  }
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (vol.data[i] >= lo && vol.data[i] < hi && !nearBone[i]) mask[i] = 1;
  return { mask, regions: regions(mask, vol, 60) };
}
