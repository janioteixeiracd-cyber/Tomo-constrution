import type { Volume } from './types';

/**
 * Limiar de Otsu entre partes moles e osso, ignorando o ar (< -300).
 * Útil em CBCT, onde os valores não são HU calibrados.
 */
export function otsuBoneThreshold(vol: Volume, maxSamples = 2_000_000): number {
  const d = vol.data;
  const step = Math.max(1, Math.floor(d.length / maxSamples));
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < d.length; i += step) {
    const v = d[i];
    if (v < -300) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo) || hi <= lo) return 300;
  const bins = 512;
  const hist = new Float64Array(bins);
  const scale = (bins - 1) / (hi - lo);
  for (let i = 0; i < d.length; i += step) {
    const v = d[i];
    if (v < -300) continue;
    hist[Math.round((v - lo) * scale)]++;
  }
  let total = 0;
  let sum = 0;
  for (let b = 0; b < bins; b++) {
    total += hist[b];
    sum += b * hist[b];
  }
  let wB = 0;
  let sumB = 0;
  let best = 0;
  let bestT = 0;
  for (let b = 0; b < bins; b++) {
    wB += hist[b];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += b * hist[b];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      bestT = b;
    }
  }
  return Math.round(lo + bestT / scale);
}

/** Limiar inicial sugerido: 200 HU em TC convencional; Otsu quando os valores não são HU confiáveis. */
export function suggestThreshold(vol: Volume, cbct: boolean): number {
  if (!cbct) {
    let min = Infinity;
    const step = Math.max(1, Math.floor(vol.data.length / 500_000));
    for (let i = 0; i < vol.data.length; i += step) if (vol.data[i] < min) min = vol.data[i];
    // TC calibrada tem ar perto de -1000 HU
    if (min < -800) return 200;
  }
  return otsuBoneThreshold(vol);
}
