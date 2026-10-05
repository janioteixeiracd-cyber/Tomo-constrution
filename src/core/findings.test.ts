import { describe, expect, it } from 'vitest';
import { examFindings } from './findings';
import type { Volume } from './types';

const N = 64;
const idx = (x: number, y: number, z: number) => (z * N + y) * N + x;

/** Crânio simétrico, mandíbula em ferradura com um "cisto", dentes e um fragmento solto. */
function phantom(cut = false) {
  const hu = new Int16Array(N ** 3).fill(20);
  const labels = new Uint8Array(N ** 3);
  const set = (x: number, y: number, z: number, l: number, v: number) => {
    labels[idx(x, y, z)] = l;
    hu[idx(x, y, z)] = v;
  };
  for (let z = 0; z < N; z++)
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const r = Math.hypot(x - 32, y - 40);
        if (z >= 5 && z <= 20 && y < 40 && r >= 12 && r <= 24) set(x, y, z, 2, 1000);
        if (z >= 21 && z <= 24 && y < 40 && r >= 16 && r <= 20) set(x, y, z, 3, 2000);
        if (x >= 10 && x <= 54 && y >= 10 && y <= 50 && z >= 30 && z <= 55) set(x, y, z, 1, 1000);
        if (x >= 48 && x <= 53 && y >= 10 && y <= 15 && z >= 57 && z <= 62) set(x, y, z, 1, 1000);
        if (Math.hypot(x - 32, y - 22, z - 12) < 3.6) set(x, y, z, 0, 30); // cisto
        if (cut && x >= 18 && x <= 20 && z <= 20) set(x, y, z, 0, 20); // fratura com afastamento
      }
  const vol: Volume = { dims: [N, N, N], spacing: [1, 1, 1], origin: [0, 0, 0], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], data: hu };
  return { vol, labels };
}

describe('leitura automática do exame', () => {
  it('acha o cisto, o fragmento e a mandíbula contínua e simétrica', () => {
    const { vol, labels } = phantom();
    const f = examFindings({ vol, labels, metal: [], air: [], vessels: null, threshold: 200, calibratedHU: true });
    expect(f.mandibleParts).toBe(1);
    expect(f.mandibleSymmetry!).toBeGreaterThan(0.9);
    expect(f.lowDensity).toHaveLength(1);
    expect(f.lowDensity[0].position).toMatch(/^linha média/);
    expect(f.fragments).toHaveLength(1);
    expect(f.fragments[0].position).toMatch(/lado esquerdo/);
    expect(f.text).toContain('Áreas hipodensas');
  });

  it('acusa a descontinuidade e a assimetria da mandíbula cortada', () => {
    const { vol, labels } = phantom(true);
    const f = examFindings({ vol, labels, metal: [], air: [], vessels: null, threshold: 200, calibratedHU: true });
    expect(f.mandibleParts).toBe(2);
    expect(f.mandibleSymmetry!).toBeLessThan(0.95);
    expect(f.text).toContain('2 partes separadas');
  });
});
