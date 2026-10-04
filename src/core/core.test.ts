import { describe, expect, it } from 'vitest';
import { assembleVolume, type SliceInput } from './assemble';
import { keepLargeComponents } from './components';
import { signedDistance2D } from './distance';
import { assessQuality } from './quality';
import { reconstruct, resampleZ } from './resample';
import type { Vec3, Volume } from './types';

/** Esfera de "osso" (1000 HU) em fundo de -1000 HU, amostrada em cortes com espaçamento sz. */
function sphereSlices(n: number, sz: number, radius: number, size = 64, px = 1): SliceInput[] {
  const c = (size - 1) / 2;
  const zc = ((n - 1) * sz) / 2;
  return Array.from({ length: n }, (_, k) => ({
    rows: size,
    cols: size,
    position: [0, 0, k * sz] as Vec3,
    orientation: [1, 0, 0, 0, 1, 0],
    pixelSpacing: [px, px] as [number, number],
    thickness: sz,
    instance: k + 1,
    pixels: () => {
      const a = new Float32Array(size * size);
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
          const d = Math.hypot((x - c) * px, (y - c) * px, k * sz - zc);
          a[y * size + x] = d <= radius ? 1000 : -1000;
        }
      return a;
    },
  }));
}

describe('assembleVolume', () => {
  it('ordena cortes pela posição e calcula o espaçamento', () => {
    const slices = sphereSlices(10, 2.5, 10);
    const shuffled = [slices[3], slices[0], ...slices.slice(4), slices[2], slices[1]];
    const { volume, geometry } = assembleVolume(shuffled);
    expect(volume.dims).toEqual([64, 64, 10]);
    expect(volume.spacing[2]).toBeCloseTo(2.5);
    expect(geometry.irregular).toBe(false);
    // o corte central deve ter a maior área de osso
    const area = (k: number) => volume.data.subarray(k * 4096, (k + 1) * 4096).filter((v) => v > 0).length;
    expect(area(4)).toBeGreaterThan(area(0));
  });

  it('preenche cortes ausentes por interpolação', () => {
    const slices = sphereSlices(12, 2, 8).filter((_, i) => i !== 5 && i !== 6);
    const { volume, geometry } = assembleVolume(slices);
    expect(geometry.irregular).toBe(true);
    expect(volume.dims[2]).toBe(12);
    expect(geometry.gapsFilled).toBe(2);
  });

  it('ignora cortes duplicados', () => {
    const s = sphereSlices(5, 1, 3);
    const { geometry } = assembleVolume([...s, s[2]]);
    expect(geometry.duplicatesRemoved).toBe(1);
    expect(geometry.sliceCount).toBe(5);
  });
});

describe('signedDistance2D', () => {
  it('confere com força bruta, inclusive com pixel anisotrópico', () => {
    const nx = 23;
    const ny = 17;
    const mask = new Uint8Array(nx * ny);
    for (let i = 0; i < mask.length; i++) mask[i] = (i * 7919) % 11 === 0 ? 1 : 0;
    const sx = 0.4;
    const sy = 1.3;
    const sdf = signedDistance2D(mask, nx, ny, sx, sy, 1e9);
    const h = 0.5 * Math.min(sx, sy);
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        const i = y * nx + x;
        let best = Infinity;
        for (let yy = 0; yy < ny; yy++)
          for (let xx = 0; xx < nx; xx++) {
            if (mask[yy * nx + xx] === mask[i]) continue;
            best = Math.min(best, Math.hypot((x - xx) * sx, (y - yy) * sy));
          }
        const expected = mask[i] ? best - h : -(best - h);
        expect(sdf[i]).toBeCloseTo(expected, 4);
      }
  });
});

describe('reconstrução com cortes espessos', () => {
  const radius = 14;
  const build = () => assembleVolume(sphereSlices(7, 5, radius, 64, 1)).volume;

  const surfaceRadiusAtZ = (field: Float32Array, dims: Vec3, k: number) => {
    // raio no eixo x a partir do centro, achando o cruzamento de zero
    const [nx, ny] = dims;
    const c = Math.round((ny - 1) / 2);
    const row = k * nx * ny + c * nx;
    for (let x = Math.round((nx - 1) / 2); x < nx - 1; x++) {
      if (field[row + x] > 0 && field[row + x + 1] <= 0) {
        return x + field[row + x] / (field[row + x] - field[row + x + 1]) - (nx - 1) / 2;
      }
    }
    return 0;
  };

  it('a interpolação baseada em forma acompanha a esfera sem degraus entre os cortes', () => {
    const vol = build();
    const opts = { threshold: 0, targetSpacing: 1, smoothing: 0, removeSmallParts: false };
    const shape = reconstruct(vol, { ...opts, interpolation: 'shape' });
    const linear = reconstruct(vol, { ...opts, interpolation: 'linear' });
    const zc = ((vol.dims[2] - 1) * vol.spacing[2]) / 2;
    const profile = (f: ReturnType<typeof reconstruct>) => {
      const out: { z: number; r: number }[] = [];
      for (let k = 0; k < f.surfaceField.dims[2]; k++) {
        const z = k * f.surfaceField.spacing[2] - zc;
        if (Math.abs(z) <= radius * 0.75) out.push({ z, r: surfaceRadiusAtZ(f.surfaceField.data, f.surfaceField.dims, k) });
      }
      return out;
    };
    const maxStep = (p: { r: number }[]) => Math.max(...p.slice(1).map((v, i) => Math.abs(v.r - p[i].r)));
    const ps = profile(shape);
    const meanErr = ps.reduce((s, { z, r }) => s + Math.abs(r - Math.sqrt(radius * radius - z * z)), 0) / ps.length;
    expect(ps.length).toBeGreaterThan(15);
    expect(meanErr).toBeLessThan(0.6);
    expect(maxStep(ps)).toBeLessThan(maxStep(profile(linear)) / 2);
  });

  it('não altera o volume de origem', () => {
    const vol = build();
    const copy = vol.data.slice();
    reconstruct(vol, { threshold: 0, targetSpacing: 10, smoothing: 0, removeSmallParts: true, interpolation: 'linear' });
    expect(vol.data).toEqual(copy);
  });

  it('resampleZ mantém valores dentro do intervalo dos vizinhos (sem overshoot)', () => {
    const vol = build();
    const r = resampleZ(vol, 1, 'cubic');
    let min = Infinity;
    let max = -Infinity;
    for (const v of r.data) {
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    expect(min).toBeGreaterThanOrEqual(-1000);
    expect(max).toBeLessThanOrEqual(1000);
  });
});

describe('keepLargeComponents', () => {
  it('remove fragmentos pequenos e mantém o principal', () => {
    const dims: Vec3 = [40, 40, 40];
    const field = new Float32Array(40 ** 3).fill(-1);
    const set = (x: number, y: number, z: number) => (field[z * 1600 + y * 40 + x] = 1);
    for (let z = 5; z < 30; z++) for (let y = 5; y < 30; y++) for (let x = 5; x < 30; x++) set(x, y, z);
    set(36, 36, 36);
    const r = keepLargeComponents(field, dims, [1, 1, 1]);
    expect(r.parts).toBe(1);
    expect(r.components).toBe(1);
    expect(field[36 * 1600 + 36 * 40 + 36]).toBeLessThan(0);
    expect(field[10 * 1600 + 10 * 40 + 10]).toBeGreaterThan(0);
  });
});

describe('assessQuality', () => {
  const vol = (sz: number, nz: number): Volume => ({
    dims: [512, 512, nz],
    spacing: [0.49, 0.49, sz],
    origin: [0, 0, 0],
    direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    data: new Int16Array(0),
  });
  const geometry = { sliceCount: 0, spacing: 0, minGap: 0, maxGap: 0, duplicatesRemoved: 0, gapsFilled: 0, irregular: false, obliquityDeg: 0, spacingFromPositions: true };
  const base = { transferSyntax: '1.2.840.10008.1.2.1', lossyFlag: false, imageType: 'ORIGINAL\\PRIMARY\\AXIAL', manufacturer: 'GE', modality: 'CT', multiFrame: false };

  it('classifica cortes finos como boa qualidade', () => {
    const r = assessQuality({ ...base, volume: vol(0.625, 300), geometry });
    expect(r.level).toBe('boa');
  });

  it('classifica cortes de 5 mm reformatados e comprimidos como limitada, sempre com aviso', () => {
    const r = assessQuality({ ...base, volume: vol(5.5, 25), geometry, transferSyntax: '1.2.840.10008.1.2.4.51', imageType: 'DERIVED\\SECONDARY\\REFORMATTED' });
    expect(r.level).toBe('limitada');
    expect(r.disclaimer).toMatch(/podem variar/);
    expect(r.warnings.length).toBeGreaterThanOrEqual(3);
  });

  it('avisa sobre HU não calibrado em CBCT', () => {
    const r = assessQuality({ ...base, volume: vol(0.3, 400), geometry, manufacturer: 'Planmeca' });
    expect(r.warnings.join(' ')).toMatch(/CBCT/);
  });
});
