const INF = 1e20;

/** Transformada de distância 1D (Felzenszwalb & Huttenlocher) com espaçamento s; f e d em mm². */
function dt1d(f: Float64Array, n: number, s: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  const meet = (q: number, p: number) => (f[q] + (q * s) ** 2 - (f[p] + (p * s) ** 2)) / (2 * s * (q - p));
  for (let q = 1; q < n; q++) {
    let sq = meet(q, v[k]);
    // z[0] = -Infinity garante que k nunca fica negativo
    while (sq <= z[k]) sq = meet(q, v[--k]);
    k++;
    v[k] = q;
    z[k] = sq;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q * s) k++;
    const p = v[k];
    d[q] = ((q - p) * s) ** 2 + f[p];
  }
}

/** Distância euclidiana (mm) de cada pixel ao pixel mais próximo com target=1. */
function edt(target: (i: number) => boolean, nx: number, ny: number, sx: number, sy: number): Float32Array {
  const n = Math.max(nx, ny);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const tmp = new Float64Array(nx * ny);
  // colunas (y)
  for (let x = 0; x < nx; x++) {
    for (let y = 0; y < ny; y++) f[y] = target(y * nx + x) ? 0 : INF;
    dt1d(f, ny, sy, d, v, z);
    for (let y = 0; y < ny; y++) tmp[y * nx + x] = d[y];
  }
  // linhas (x)
  const out = new Float32Array(nx * ny);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) f[x] = tmp[y * nx + x];
    dt1d(f, nx, sx, d, v, z);
    for (let x = 0; x < nx; x++) out[y * nx + x] = Math.sqrt(d[x]);
  }
  return out;
}

/**
 * Distância com sinal em mm: positiva dentro da máscara, negativa fora.
 * Distâncias são limitadas a ±`cap`; um corte sem nenhum osso recebe `emptyValue`.
 */
export function signedDistance2D(
  mask: Uint8Array,
  nx: number,
  ny: number,
  sx: number,
  sy: number,
  cap = 40,
  emptyValue = -cap,
): Float32Array {
  let any = false;
  let all = true;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) any = true;
    else all = false;
  }
  const out = new Float32Array(nx * ny);
  if (!any) return out.fill(emptyValue);
  if (all) return out.fill(cap);
  const toFg = edt((i) => mask[i] === 1, nx, ny, sx, sy);
  const toBg = edt((i) => mask[i] === 0, nx, ny, sx, sy);
  // meio pixel de deslocamento para o zero ficar na borda entre pixels
  const h = 0.5 * Math.min(sx, sy);
  for (let i = 0; i < out.length; i++) {
    const v = mask[i] ? toBg[i] - h : -(toFg[i] - h);
    out[i] = v > cap ? cap : v < -cap ? -cap : v;
  }
  return out;
}
