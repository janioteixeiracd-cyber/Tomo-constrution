import { describe, expect, it } from 'vitest';
import { detectMetal } from './metal';
import { labelAt, splitByPlane, splitBySeed } from './segedit';
import type { Vec3, Volume } from './types';

const N = 64;
const grid = (data: Int16Array | Uint8Array): Volume => ({
  dims: [N, N, N],
  spacing: [0.5, 0.5, 0.5],
  origin: [0, 0, 0],
  direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  data: data as Int16Array,
});
const idx = (x: number, y: number, z: number) => (z * N + y) * N + x;

describe('metal', () => {
  it('separa parafuso e placa do osso e mede cada peça', () => {
    const hu = new Int16Array(N ** 3).fill(30);
    // osso
    for (let z = 4; z < 60; z++) for (let y = 30; y < 50; y++) for (let x = 4; x < 60; x++) hu[idx(x, y, z)] = 1200;
    // placa de titânio 20 × 6 × 1 mm sobre o osso
    for (let z = 20; z < 32; z++) for (let y = 27; y < 29; y++) for (let x = 12; x < 52; x++) hu[idx(x, y, z)] = 3071;
    // parafuso de 2 mm de diâmetro e 10 mm, atravessando a placa para dentro do osso
    for (let y = 26; y < 46; y++) for (let z = 40; z < 44; z++) for (let x = 30; x < 34; x++) if (Math.hypot(x - 31.5, z - 41.5) <= 2) hu[idx(x, y, z)] = 3071;
    const r = detectMetal(grid(hu), true);
    const kinds = r.objects.map((o) => o.kind).sort();
    expect(kinds).toEqual(['parafuso', 'placa']);
    const screw = r.objects.find((o) => o.kind === 'parafuso')!;
    const plate = r.objects.find((o) => o.kind === 'placa')!;
    expect(screw.length).toBeGreaterThan(9);
    expect(screw.length).toBeLessThan(11.5);
    expect(plate.length).toBeGreaterThan(19);
    expect(plate.length).toBeLessThan(21.5);
    expect(r.mask[idx(30, 40, 30)]).toBe(0); // osso não é metal
  });

  it('não acha metal num exame só com osso e esmalte', () => {
    const hu = new Int16Array(N ** 3).fill(30);
    for (let z = 4; z < 60; z++) for (let y = 4; y < 60; y++) for (let x = 4; x < 20; x++) hu[idx(x, y, z)] = 1800;
    for (let z = 10; z < 20; z++) for (let y = 10; y < 20; y++) for (let x = 30; x < 36; x++) hu[idx(x, y, z)] = 2700;
    expect(detectMetal(grid(hu), true).objects).toHaveLength(0);
  });
});

describe('edição de estruturas', () => {
  const point = (x: number, y: number, z: number): Vec3 => [x * 0.5, y * 0.5, z * 0.5];

  it('separa por toque uma peça ligada por uma ponte fina', () => {
    const labels = new Uint8Array(N ** 3);
    for (let z = 8; z < 56; z++) for (let y = 8; y < 56; y++) for (let x = 6; x < 28; x++) labels[idx(x, y, z)] = 1;
    for (let z = 20; z < 44; z++) for (let y = 20; y < 44; y++) for (let x = 36; x < 58; x++) labels[idx(x, y, z)] = 1;
    // ponte de 1 mm ligando os dois blocos
    for (let x = 28; x < 36; x++) for (let z = 31; z < 33; z++) labels[idx(x, 31, z)] = labels[idx(x, 32, z)] = 1;
    const r = splitBySeed(labels, grid(labels), point(47, 32, 32), 10);
    expect(r.ok).toBe(true);
    expect(labels[idx(47, 32, 32)]).toBe(10);
    expect(labels[idx(15, 32, 32)]).toBe(1);
  });

  it('avisa quando a peça não se solta e corta pelo plano', () => {
    const labels = new Uint8Array(N ** 3);
    for (let z = 8; z < 56; z++) for (let y = 8; y < 56; y++) for (let x = 6; x < 58; x++) labels[idx(x, y, z)] = 1;
    const seed = splitBySeed(labels, grid(labels), point(50, 32, 32), 10);
    expect(seed.ok).toBe(false);
    const plane = splitByPlane(labels, grid(labels), point(50, 32, 32), [20, 0, 0], [1, 0, 0], 11);
    expect(plane.ok).toBe(true);
    expect(labelAt(labels, grid(labels), point(50, 32, 32))!.label).toBe(11);
    expect(labelAt(labels, grid(labels), point(20, 32, 32))!.label).toBe(1);
  });
});
