import { describe, expect, it } from 'vitest';
import { clahe, enhance, DEFAULT_ENHANCE, type Gray } from './enhance2d';

const ramp = (w: number, h: number, lo: number, hi: number): Gray => {
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = lo + ((hi - lo) * x) / (w - 1);
  return { width: w, height: h, data };
};

describe('realce 2D', () => {
  it('CLAHE amplia o contraste de uma imagem apagada', () => {
    const dull = ramp(128, 64, 100, 140);
    const out = clahe(dull, 3, 4);
    const range = (g: Gray) => Math.max(...g.data) - Math.min(...g.data);
    // o limite de contraste (clip) segura a amplificação de propósito
    expect(range(out)).toBeGreaterThan(range(dull) * 1.4);
  });

  it('mantém os valores entre 0 e 255 e respeita o negativo', () => {
    const img = ramp(64, 64, 0, 255);
    const out = enhance(img, { ...DEFAULT_ENHANCE, invert: true });
    expect(Math.min(...out.data)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...out.data)).toBeLessThanOrEqual(255);
    expect(out.data[0]).toBeGreaterThan(out.data[63]);
  });
});
