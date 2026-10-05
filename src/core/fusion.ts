import { toInt16 } from './math';
import type { Vec3, Volume } from './types';

/**
 * Mapeamento afim do índice da grade alvo para o índice contínuo de uma série:
 * idx_s = A · idx_t + b (A 3x3 em ordem de linhas).
 */
function indexMap(target: Volume, src: Volume) {
  const Dt = target.direction;
  const Ds = src.direction;
  const st = target.spacing;
  const ss = src.spacing;
  const A = new Float64Array(9);
  const b = new Float64Array(3);
  // mundo = Ot + Σ_j Dt[:,j] * st[j] * t_j ;  s_i = (Ds[:,i] · (mundo - Os)) / ss[i]
  for (let i = 0; i < 3; i++) {
    const di = [Ds[i * 3], Ds[i * 3 + 1], Ds[i * 3 + 2]];
    for (let j = 0; j < 3; j++) {
      const dj = [Dt[j * 3], Dt[j * 3 + 1], Dt[j * 3 + 2]];
      A[i * 3 + j] = ((di[0] * dj[0] + di[1] * dj[1] + di[2] * dj[2]) * st[j]) / ss[i];
    }
    const d = [target.origin[0] - src.origin[0], target.origin[1] - src.origin[1], target.origin[2] - src.origin[2]];
    b[i] = (di[0] * d[0] + di[1] * d[1] + di[2] * d[2]) / ss[i];
  }
  return { A, b };
}

export interface FusionResult {
  volume: Volume;
  notes: string[];
}

/**
 * Funde séries de orientações diferentes numa grade isotrópica axial que cobre a série principal.
 * Em cada voxel, cada série contribui com sua amostra (interpolação trilinear) e um peso que é
 * máximo quando o ponto está sobre um corte realmente adquirido e cai entre os cortes —
 * assim prevalece, ponto a ponto, a série que de fato "viu" aquele lugar.
 */
export function fuseVolumes(vols: Volume[], maxVoxels: number): FusionResult {
  const primary = vols[0];
  const inPlane = Math.min(...vols.map((v) => Math.min(v.spacing[0], v.spacing[1])));
  // grade axial padrão (L, P, S) cobrindo a caixa da série principal: as vistas de corte
  // continuam nomeadas corretamente mesmo quando a principal é coronal ou sagital
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  const d = primary.direction;
  for (const ci of [0, primary.dims[0] - 1])
    for (const cj of [0, primary.dims[1] - 1])
      for (const ck of [0, primary.dims[2] - 1])
        for (let a = 0; a < 3; a++) {
          const p =
            primary.origin[a] + d[a] * ci * primary.spacing[0] + d[3 + a] * cj * primary.spacing[1] + d[6 + a] * ck * primary.spacing[2];
          lo[a] = Math.min(lo[a], p);
          hi[a] = Math.max(hi[a], p);
        }
  const extent: Vec3 = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  let s = Math.max(inPlane, 0.5);
  const count = (sp: number) => extent.reduce((n, e) => n * (Math.floor(e / sp) + 1), 1);
  while (count(s) > maxVoxels) s *= 1.1;
  const dims = extent.map((e) => Math.floor(e / s) + 1) as Vec3;
  const target: Volume = { dims, spacing: [s, s, s], origin: lo, direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], data: new Int16Array(dims[0] * dims[1] * dims[2]) };

  const maps = vols.map((v) => indexMap(target, v));
  // largura (mm) da faixa de confiança em torno de cada corte adquirido
  const sigma = vols.map((v) => Math.max(0.6, Math.min(v.spacing[0], v.spacing[1]) * 1.5));
  const [tx, ty, tz] = dims;

  for (let k = 0; k < tz; k++)
    for (let j = 0; j < ty; j++)
      for (let i = 0; i < tx; i++) {
        let acc = 0;
        let wacc = 0;
        for (let m = 0; m < vols.length; m++) {
          const v = vols[m];
          const { A, b } = maps[m];
          const u = A[0] * i + A[1] * j + A[2] * k + b[0];
          const w1 = A[3] * i + A[4] * j + A[5] * k + b[1];
          const z = A[6] * i + A[7] * j + A[8] * k + b[2];
          const [nx, ny, nz] = v.dims;
          if (u < 0 || w1 < 0 || z < -0.5 || u > nx - 1 || w1 > ny - 1 || z > nz - 0.5) continue;
          const zc = Math.min(nz - 1, Math.max(0, z));
          const x0 = Math.floor(u);
          const y0 = Math.floor(w1);
          const z0 = Math.floor(zc);
          const x1 = Math.min(nx - 1, x0 + 1);
          const y1 = Math.min(ny - 1, y0 + 1);
          const z1 = Math.min(nz - 1, z0 + 1);
          const fx = u - x0;
          const fy = w1 - y0;
          const fz = zc - z0;
          const plane = nx * ny;
          const d = v.data;
          const c0 =
            (d[z0 * plane + y0 * nx + x0] * (1 - fx) + d[z0 * plane + y0 * nx + x1] * fx) * (1 - fy) +
            (d[z0 * plane + y1 * nx + x0] * (1 - fx) + d[z0 * plane + y1 * nx + x1] * fx) * fy;
          const c1 =
            (d[z1 * plane + y0 * nx + x0] * (1 - fx) + d[z1 * plane + y0 * nx + x1] * fx) * (1 - fy) +
            (d[z1 * plane + y1 * nx + x0] * (1 - fx) + d[z1 * plane + y1 * nx + x1] * fx) * fy;
          const val = c0 * (1 - fz) + c1 * fz;
          // distância (mm) até o corte adquirido mais próximo dessa série
          const dz = Math.abs(zc - Math.round(zc)) * v.spacing[2];
          const conf = Math.exp(-((dz / sigma[m]) ** 2));
          // piso pequeno: entre cortes de todas as séries ainda há uma estimativa ponderada
          const w = 0.02 + conf;
          acc += val * w;
          wacc += w;
        }
        target.data[(k * ty + j) * tx + i] = wacc > 0 ? toInt16(acc / wacc) : -1024;
      }

  const notes = [
    `Volume fundido de ${vols.length} séries numa grade de ${s.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} mm.`,
  ];
  return { volume: target, notes };
}
