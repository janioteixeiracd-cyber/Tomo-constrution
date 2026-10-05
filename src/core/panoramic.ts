import type { Volume } from './types';

/** Ponto no plano axial, em índices de voxel (x = coluna, y = linha). */
export type Pt = [number, number];

export interface ArchCurve {
  /** amostras ao longo da curva, espaçadas de `step` mm, em índices de voxel */
  points: Pt[];
  /** normal unitária no plano (em mm, eixos x/y do volume), apontando para vestibular/fora do arco */
  normals: Pt[];
  /** espaçamento entre amostras (mm) */
  step: number;
  /** comprimento total (mm) */
  length: number;
}

export interface PanoImage {
  width: number;
  height: number;
  /** tamanho do pixel em mm (igual nos dois eixos) */
  pixel: number;
  data: Float32Array;
}

/** Catmull-Rom centrípeta simples (uniforme) por segmentos. */
function catmull(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const t2 = t * t;
  const t3 = t2 * t;
  const f = (a: number, b: number, c: number, d: number) =>
    0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return [f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])];
}

/**
 * Curva do arco a partir dos pontos tocados pelo usuário.
 * Ordena para começar do lado direito do paciente (esquerda da tela no axial),
 * como numa panorâmica convencional.
 */
export function buildArch(control: Pt[], vol: Volume): ArchCurve | null {
  if (control.length < 2) return null;
  const [sx, sy] = vol.spacing;
  // o sentido +x do volume aponta para o lado esquerdo do paciente quando direction[0] > 0
  const xTowardLeft = vol.direction[0] >= 0;
  let pts = control.map((p) => [p[0], p[1]] as Pt);
  const startX = pts[0][0];
  const endX = pts[pts.length - 1][0];
  if (xTowardLeft ? startX > endX : startX < endX) pts = pts.reverse();

  // densifica com spline e mede em mm
  const dense: Pt[] = [];
  const ext = [pts[0], ...pts, pts[pts.length - 1]];
  for (let i = 1; i < ext.length - 2; i++) {
    const segMm = Math.hypot((ext[i + 1][0] - ext[i][0]) * sx, (ext[i + 1][1] - ext[i][1]) * sy);
    const n = Math.max(2, Math.ceil(segMm * 4));
    for (let k = 0; k < n; k++) dense.push(catmull(ext[i - 1], ext[i], ext[i + 1], ext[i + 2], k / n));
  }
  dense.push(pts[pts.length - 1]);
  const cum = [0];
  for (let i = 1; i < dense.length; i++) {
    cum.push(cum[i - 1] + Math.hypot((dense[i][0] - dense[i - 1][0]) * sx, (dense[i][1] - dense[i - 1][1]) * sy));
  }
  const length = cum[cum.length - 1];
  if (length < 1) return null;

  const step = Math.min(sx, sy);
  const count = Math.max(2, Math.floor(length / step) + 1);
  const points: Pt[] = [];
  let j = 0;
  for (let k = 0; k < count; k++) {
    const s = Math.min(length, k * step);
    while (j < cum.length - 2 && cum[j + 1] < s) j++;
    const t = cum[j + 1] > cum[j] ? (s - cum[j]) / (cum[j + 1] - cum[j]) : 0;
    points.push([dense[j][0] + (dense[j + 1][0] - dense[j][0]) * t, dense[j][1] + (dense[j + 1][1] - dense[j][1]) * t]);
  }

  // centroide para orientar a normal para fora do arco
  const cx = points.reduce((a, p) => a + p[0], 0) / points.length;
  const cy = points.reduce((a, p) => a + p[1], 0) / points.length;
  const normals: Pt[] = points.map((p, i) => {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(points.length - 1, i + 1)];
    const tx = (b[0] - a[0]) * sx;
    const ty = (b[1] - a[1]) * sy;
    const len = Math.hypot(tx, ty) || 1;
    let nx = -ty / len;
    let ny = tx / len;
    if (nx * (p[0] - cx) * sx + ny * (p[1] - cy) * sy < 0) {
      nx = -nx;
      ny = -ny;
    }
    return [nx, ny];
  });
  return { points, normals, step, length };
}

/** Amostragem trilinear (x,y em índice contínuo; z em índice contínuo). */
function sampler(vol: Volume) {
  const [nx, ny, nz] = vol.dims;
  const plane = nx * ny;
  const d = vol.data;
  return (x: number, y: number, z: number): number => {
    if (x < 0 || y < 0 || z < 0 || x > nx - 1 || y > ny - 1 || z > nz - 1) return -1024;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const z0 = Math.floor(z);
    const x1 = Math.min(nx - 1, x0 + 1);
    const y1 = Math.min(ny - 1, y0 + 1);
    const z1 = Math.min(nz - 1, z0 + 1);
    const fx = x - x0;
    const fy = y - y0;
    const fz = z - z0;
    const at = (zz: number, yy: number, xx: number) => d[zz * plane + yy * nx + xx];
    const c00 = at(z0, y0, x0) * (1 - fx) + at(z0, y0, x1) * fx;
    const c01 = at(z0, y1, x0) * (1 - fx) + at(z0, y1, x1) * fx;
    const c10 = at(z1, y0, x0) * (1 - fx) + at(z1, y0, x1) * fx;
    const c11 = at(z1, y1, x0) * (1 - fx) + at(z1, y1, x1) * fx;
    const c0 = c00 * (1 - fy) + c01 * fy;
    const c1 = c10 * (1 - fy) + c11 * fy;
    return c0 * (1 - fz) + c1 * fz;
  };
}

/** Linhas da imagem reformatada: z de cima (superior) para baixo, no mesmo tamanho de pixel. */
function rowsZ(vol: Volume, pixel: number) {
  const nz = vol.dims[2];
  const span = (nz - 1) * vol.spacing[2];
  const height = Math.max(1, Math.round(span / pixel) + 1);
  // z em índice contínuo para cada linha; o sentido +z (normal dos cortes) costuma ser superior
  const superiorIsPlus = vol.direction[8] >= 0;
  return {
    height,
    zAt: (row: number) => {
      const zi = height > 1 ? (row / (height - 1)) * (nz - 1) : 0;
      return superiorIsPlus ? nz - 1 - zi : zi;
    },
  };
}

/**
 * Panorâmica por reformatação curva: para cada ponto do arco, combina as amostras ao longo
 * da normal numa faixa de `thickness` mm (média = aspecto de radiografia; MIP = realça osso/dente).
 */
export function panoramic(vol: Volume, arch: ArchCurve, thickness: number, mode: 'media' | 'mip'): PanoImage {
  const [sx, sy] = vol.spacing;
  const pixel = arch.step;
  const { height, zAt } = rowsZ(vol, pixel);
  const width = arch.points.length;
  const data = new Float32Array(width * height);
  const sample = sampler(vol);
  const half = Math.max(0, thickness / 2);
  const nOff = Math.max(1, Math.round(thickness / pixel) + 1);
  for (let row = 0; row < height; row++) {
    const z = zAt(row);
    for (let col = 0; col < width; col++) {
      const [px, py] = arch.points[col];
      const [nx, ny] = arch.normals[col];
      let acc = mode === 'mip' ? -Infinity : 0;
      for (let k = 0; k < nOff; k++) {
        const o = nOff > 1 ? -half + (k * 2 * half) / (nOff - 1) : 0;
        const v = sample(px + (nx * o) / sx, py + (ny * o) / sy, z);
        if (mode === 'mip') {
          if (v > acc) acc = v;
        } else acc += v;
      }
      data[row * width + col] = mode === 'mip' ? acc : acc / nOff;
    }
  }
  return { width, height, pixel, data };
}

/** Corte transversal (parassagital) perpendicular ao arco no índice `col`. */
export function crossSection(vol: Volume, arch: ArchCurve, col: number, widthMm: number): PanoImage {
  const [sx, sy] = vol.spacing;
  const pixel = arch.step;
  const { height, zAt } = rowsZ(vol, pixel);
  const i = Math.max(0, Math.min(arch.points.length - 1, Math.round(col)));
  const [px, py] = arch.points[i];
  const [nx, ny] = arch.normals[i];
  const width = Math.max(2, Math.round(widthMm / pixel) + 1);
  const data = new Float32Array(width * height);
  const sample = sampler(vol);
  for (let row = 0; row < height; row++) {
    const z = zAt(row);
    for (let c = 0; c < width; c++) {
      // esquerda = lingual/palatino, direita = vestibular
      const o = -widthMm / 2 + c * pixel;
      data[row * width + c] = sample(px + (nx * o) / sx, py + (ny * o) / sy, z);
    }
  }
  return { width, height, pixel, data };
}
