import { describe, expect, it } from 'vitest';
import { segmentAirways, segmentVessels } from './softseg';
import type { Volume } from './types';

const N = 64;
const idx = (x: number, y: number, z: number) => (z * N + y) * N + x;

/** "Cabeça": esfera de partes moles no ar, casca óssea, dois seios de ar e um vaso contrastado. */
function head(): Volume {
  const hu = new Int16Array(N ** 3).fill(-1000);
  for (let z = 0; z < N; z++)
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const r = Math.hypot(x - 32, y - 32, z - 32);
        if (r < 28) hu[idx(x, y, z)] = 40;
        if (r >= 24 && r < 27) hu[idx(x, y, z)] = 1000;
        if (Math.hypot(x - 22, y - 26, z - 30) < 5) hu[idx(x, y, z)] = -950; // seio direito
        if (Math.hypot(x - 42, y - 26, z - 30) < 5) hu[idx(x, y, z)] = -950; // seio esquerdo
        if (Math.hypot(x - 32, y - 40) < 2 && z > 12 && z < 52) hu[idx(x, y, z)] = 260; // vaso
      }
  return { dims: [N, N, N], spacing: [1, 1, 1], origin: [0, 0, 0], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], data: hu };
}

describe('seios e vasos', () => {
  const vol = head();

  it('acha os dois seios e ignora o ar de fora', () => {
    const r = segmentAirways(vol);
    expect(r.regions).toHaveLength(2);
    expect(r.regions.map((x) => x.location.split(',')[0]).sort()).toEqual(['lado direito', 'lado esquerdo']);
    expect(r.mask[idx(1, 1, 1)]).toBe(0);
    expect(r.mask[idx(22, 26, 30)]).toBe(1);
  });

  it('acha o vaso contrastado e não a borda do osso', () => {
    const r = segmentVessels(vol);
    expect(r.regions).toHaveLength(1);
    expect(r.regions[0].volume).toBeGreaterThan(300);
    expect(r.mask[idx(32, 40, 32)]).toBe(1);
  });
});
