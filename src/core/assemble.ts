import { cross, dot, median, normalize, toInt16 } from './math';
import type { Vec3, Volume } from './types';

/** Um corte 2D já com metadados geométricos, independente da biblioteca DICOM. */
export interface SliceInput {
  rows: number;
  cols: number;
  position: Vec3 | null;
  orientation: number[] | null;
  pixelSpacing: [number, number] | null;
  thickness: number | null;
  instance: number;
  /** valores já em HU (slope/intercept aplicados), ordem linha a linha */
  pixels: () => ArrayLike<number>;
}

export interface Geometry {
  sliceCount: number;
  /** espaçamento usado no volume (mm) */
  spacing: number;
  minGap: number;
  maxGap: number;
  duplicatesRemoved: number;
  /** cortes sintetizados para preencher falhas/espaçamento irregular */
  gapsFilled: number;
  irregular: boolean;
  /** desvio (graus) entre a normal dos cortes e o eixo mais próximo do paciente */
  obliquityDeg: number;
  spacingFromPositions: boolean;
}

const DEFAULT_ORIENTATION = [1, 0, 0, 0, 1, 0];

export function assembleVolume(input: SliceInput[]): { volume: Volume; geometry: Geometry } {
  if (!input.length) throw new Error('Nenhum corte com imagem nesta série.');
  const first = input[0];
  const sameSize = input.filter((s) => s.rows === first.rows && s.cols === first.cols);
  const orientation = first.orientation?.length === 6 ? first.orientation : DEFAULT_ORIENTATION;
  const rowDir = normalize([orientation[0], orientation[1], orientation[2]]);
  const colDir = normalize([orientation[3], orientation[4], orientation[5]]);
  const normal = normalize(cross(rowDir, colDir));
  const ps = first.pixelSpacing ?? [1, 1];
  // PixelSpacing DICOM = [entre linhas (y), entre colunas (x)]
  const sx = ps[1] || 1;
  const sy = ps[0] || 1;

  const hasPositions = sameSize.every((s) => s.position);
  const thickness = first.thickness && first.thickness > 0 ? first.thickness : 1;
  const keyed = sameSize.map((s) => ({
    s,
    z: hasPositions ? dot(s.position!, normal) : s.instance * thickness,
  }));
  keyed.sort((a, b) => a.z - b.z);

  // remove posições duplicadas (ex.: duas exportações do mesmo corte)
  const unique: typeof keyed = [];
  for (const k of keyed) {
    if (unique.length && Math.abs(k.z - unique[unique.length - 1].z) < 1e-3) continue;
    unique.push(k);
  }
  const duplicatesRemoved = keyed.length - unique.length;

  const gaps = unique.slice(1).map((k, i) => k.z - unique[i].z);
  const medGap = gaps.length ? median(gaps) : thickness;
  const minGap = gaps.length ? Math.min(...gaps) : medGap;
  const maxGap = gaps.length ? Math.max(...gaps) : medGap;
  const irregular = gaps.length > 0 && (maxGap > medGap * 1.15 || minGap < medGap * 0.85);

  const nx = first.cols;
  const ny = first.rows;
  const plane = nx * ny;

  const decoded = new Map<number, ArrayLike<number>>();
  const pixelsOf = (i: number) => {
    let p = decoded.get(i);
    if (!p) {
      p = unique[i].s.pixels();
      decoded.set(i, p);
    }
    return p;
  };

  let nz: number;
  let data: Int16Array;
  let gapsFilled = 0;
  if (!irregular) {
    nz = unique.length;
    data = new Int16Array(plane * nz);
    for (let k = 0; k < nz; k++) {
      const px = pixelsOf(k);
      const off = k * plane;
      for (let i = 0; i < plane; i++) data[off + i] = toInt16(px[i]);
      decoded.delete(k);
    }
  } else {
    // grade uniforme no espaçamento mediano; cortes ausentes são interpolados linearmente
    const z0 = unique[0].z;
    const span = unique[unique.length - 1].z - z0;
    nz = Math.max(1, Math.round(span / medGap) + 1);
    data = new Int16Array(plane * nz);
    let j = 0;
    for (let k = 0; k < nz; k++) {
      const z = z0 + k * medGap;
      while (j < unique.length - 2 && unique[j + 1].z < z) j++;
      const za = unique[j].z;
      const zb = unique[Math.min(j + 1, unique.length - 1)].z;
      const t = zb > za ? Math.min(1, Math.max(0, (z - za) / (zb - za))) : 0;
      const off = k * plane;
      const near = Math.min(Math.abs(z - za), Math.abs(z - zb));
      if (near > medGap * 0.25) gapsFilled++;
      const a = pixelsOf(j);
      if (t < 1e-3) {
        for (let i = 0; i < plane; i++) data[off + i] = toInt16(a[i]);
      } else {
        const b = pixelsOf(Math.min(j + 1, unique.length - 1));
        for (let i = 0; i < plane; i++) data[off + i] = toInt16(a[i] + (b[i] - a[i]) * t);
      }
      for (const key of decoded.keys()) if (key < j) decoded.delete(key);
    }
  }

  const origin: Vec3 = hasPositions ? [...unique[0].s.position!] as Vec3 : [0, 0, 0];
  const maxAxis = Math.max(Math.abs(normal[0]), Math.abs(normal[1]), Math.abs(normal[2]));
  const obliquityDeg = (Math.acos(Math.min(1, maxAxis)) * 180) / Math.PI;

  return {
    volume: {
      dims: [nx, ny, nz],
      spacing: [sx, sy, medGap > 0 ? medGap : thickness],
      origin,
      direction: [...rowDir, ...colDir, ...normal],
      data,
    },
    geometry: {
      sliceCount: unique.length,
      spacing: medGap > 0 ? medGap : thickness,
      minGap,
      maxGap,
      duplicatesRemoved,
      gapsFilled,
      irregular,
      obliquityDeg,
      spacingFromPositions: hasPositions,
    },
  };
}
