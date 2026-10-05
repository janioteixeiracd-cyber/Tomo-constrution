import { describe, expect, it } from 'vitest';
import { reconstruct, softTissueLevel } from './resample';
import type { Volume } from './types';

describe('paredes finas', () => {
  // partes moles a 40 HU, um bloco ósseo e, encostada nele, uma "parede" fina que o volume
  // parcial deixou em 130 HU (abaixo do limiar de 200); uma mancha igual fica longe do osso
  const N = 48;
  const data = new Int16Array(N * N * N).fill(40);
  const set = (x: number, y: number, z: number, v: number) => (data[z * N * N + y * N + x] = v);
  for (let z = 10; z < 38; z++) for (let y = 10; y < 38; y++) for (let x = 10; x < 18; x++) set(x, y, z, 1000);
  for (let z = 14; z < 34; z++) for (let y = 14; y < 34; y++) set(18, y, z, 130), set(19, y, z, 130);
  for (let z = 20; z < 24; z++) for (let y = 20; y < 24; y++) for (let x = 38; x < 41; x++) set(x, y, z, 130);
  const vol: Volume = { dims: [N, N, N], spacing: [1, 1, 1], origin: [0, 0, 0], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], data };
  const at = (f: Float32Array, x: number, y: number, z: number) => f[z * N * N + y * N + x];
  const base = { threshold: 200, targetSpacing: 1, interpolation: 'cubic' as const, smoothing: 0, removeSmallParts: false };

  it('mede o nível das partes moles do exame', () => {
    expect(softTissueLevel(data, 200)).toBe(40);
  });

  it('mantém a parede fina encostada no osso e ignora a mancha isolada', () => {
    const off = reconstruct(vol, base).surfaceField.data;
    const on = reconstruct(vol, { ...base, preserveThinWalls: true }).surfaceField.data;
    expect(at(off, 18, 24, 24)).toBeLessThan(0);
    expect(at(on, 18, 24, 24)).toBeGreaterThan(0);
    expect(at(on, 39, 22, 22)).toBeLessThan(0);
    expect(at(on, 30, 24, 24)).toBeLessThan(0);
  });
});
