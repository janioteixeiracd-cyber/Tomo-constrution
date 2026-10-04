import type { Vec3 } from './types';

export const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export const cross = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export const normalize = (a: Vec3): Vec3 => {
  const n = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
};

export function median(values: number[]): number {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export const toInt16 = (v: number) => (v < -32768 ? -32768 : v > 32767 ? 32767 : Math.round(v));

/** Rótulo anatômico (R/L/A/P/S/I) do sentido positivo de um vetor em coordenadas DICOM (LPS). */
export function orientationLabel(v: ArrayLike<number>): string {
  const labels: [string, string][] = [
    ['L', 'R'],
    ['P', 'A'],
    ['S', 'I'],
  ];
  const order = [0, 1, 2].sort((a, b) => Math.abs(v[b]) - Math.abs(v[a]));
  const main = order[0];
  return v[main] >= 0 ? labels[main][0] : labels[main][1];
}

export const fmt = (v: number, digits = 2) => v.toLocaleString('pt-BR', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
