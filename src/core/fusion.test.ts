import { describe, expect, it } from 'vitest';
import { fuseVolumes } from './fusion';
import { planReconstruction } from './plan';
import type { SeriesSummary, Vec3, Volume } from './types';

/** "Osso" de referência em coordenadas do paciente (mm): casca esférica, placa fina oblíqua e hastes. */
function truth(x: number, y: number, z: number): number {
  const r = Math.hypot(x - 24, y - 24, z - 24);
  if (Math.abs(r - 15) < 1.2) return 1000; // casca de 2,4 mm
  const plate = (x - 24) * 0.6 + (z - 24) * 0.8; // plano oblíquo
  if (Math.abs(plate) < 0.8 && Math.abs(y - 24) < 12 && r < 14) return 1000; // placa de 1,6 mm
  if (Math.hypot(x - 10, z - 38) < 1.5 && y > 5 && y < 43) return 1000; // haste ao longo de y
  return -1000;
}

/** Série sintética: cortes com espaçamento `gap` mm, pixel 0,5 mm, orientação dada. */
function stack(row: Vec3, col: Vec3, normal: Vec3, gap: number, offset = 0): Volume {
  const px = 0.5;
  const n = 97; // 48 mm de lado
  const nz = Math.floor(48 / gap) + 1;
  // origem no canto "mínimo" da caixa ao longo de row/col/normal
  const origin: Vec3 = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    if (row[a] < 0) origin[a] += 48;
    if (col[a] < 0) origin[a] += 48;
    if (normal[a] < 0) origin[a] += 48;
    origin[a] += normal[a] * offset;
  }
  const data = new Int16Array(n * n * nz);
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const p = [0, 1, 2].map((a) => origin[a] + row[a] * i * px + col[a] * j * px + normal[a] * k * gap);
        data[(k * n + j) * n + i] = truth(p[0], p[1], p[2]);
      }
  return { dims: [n, n, nz], spacing: [px, px, gap], origin, direction: [...row, ...col, ...normal], data };
}

function dice(vol: Volume): number {
  let inter = 0;
  let a = 0;
  let b = 0;
  const [nx, ny, nz] = vol.dims;
  const s = vol.spacing[0];
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const p = [0, 1, 2].map((ax) => vol.origin[ax] + vol.direction[ax] * i * s + vol.direction[3 + ax] * j * s + vol.direction[6 + ax] * k * s);
        const t = truth(p[0], p[1], p[2]) > 0;
        const v = vol.data[(k * ny + j) * nx + i] > 0;
        if (t && v) inter++;
        if (t) a++;
        if (v) b++;
      }
  return (2 * inter) / (a + b);
}

describe('fusão de séries', () => {
  const axial = stack([1, 0, 0], [0, 1, 0], [0, 0, 1], 5, 2.5);
  const coronal = stack([1, 0, 0], [0, 0, -1], [0, 1, 0], 5, 1.2);
  const sagittal = stack([0, 1, 0], [0, 0, -1], [-1, 0, 0], 5, 3.7);

  it('três orientações reproduzem o objeto bem melhor que uma série só', () => {
    const single = fuseVolumes([axial], 2e6).volume;
    const fused = fuseVolumes([axial, coronal, sagittal], 2e6).volume;
    const dSingle = dice(single);
    const dFused = dice(fused);
    console.log('dice uma série', dSingle.toFixed(3), 'fusão', dFused.toFixed(3));
    expect(dFused).toBeGreaterThan(dSingle + 0.1);
    expect(dFused).toBeGreaterThan(0.7);
  });

  it('o planejador escolhe fusão quando só há séries espessas em orientações diferentes', () => {
    const summary = (id: string, normal: Vec3, spacing: number, frames: number): SeriesSummary => ({
      id,
      description: id,
      seriesNumber: 1,
      modality: 'CT',
      imageCount: frames,
      frameCount: frames,
      rows: 512,
      cols: 512,
      pixelSpacing: [0.49, 0.49],
      sliceThickness: spacing,
      estimatedSpacing: spacing,
      imageType: 'DERIVED',
      transferSyntax: '',
      geometry: { normal, bounds: [-120, 120, -120, 120, -60, 70], frameOfReference: '1.2.3', colorImages: false },
    });
    const plan = planReconstruction([summary('ax', [0, 0, 1], 5.6, 25), summary('cor', [0, 1, 0], 5.5, 25), summary('ax2', [0, 0, 1], 6, 22)])!;
    expect(plan.strategy).toBe('fusion');
    expect(plan.usedIds).toEqual(['ax', 'cor']);
    expect(plan.roles.find((r) => r.id === 'ax2')!.role).toBe('ignorada');

    const thin = planReconstruction([summary('ax', [0, 0, 1], 5.6, 25), summary('vol', [0, 0, 1], 0.625, 280)])!;
    expect(thin.strategy).toBe('single');
    expect(thin.primaryId).toBe('vol');
  });
});
