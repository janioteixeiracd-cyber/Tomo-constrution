/** Imagem em tons de cinza 0–255 (Float32 para não perder precisão entre etapas). */
export interface Gray {
  width: number;
  height: number;
  data: Float32Array;
}

export interface EnhanceOptions {
  /** redução de ruído: 0 = desligado, 1–3 = intensidade (mediana + suavização) */
  denoise: number;
  /** CLAHE: limite de contraste (0 = desligado; típico 2–4) */
  clahe: number;
  /** blocos por lado no CLAHE */
  claheTiles: number;
  /** nitidez (unsharp mask): 0 = desligado, típico 0,5–2 */
  sharpen: number;
  brightness: number; // -100..100
  contrast: number; // -100..100
  gamma: number; // 0,3..3
  invert: boolean;
}

export const DEFAULT_ENHANCE: EnhanceOptions = {
  denoise: 1,
  clahe: 2.5,
  claheTiles: 8,
  sharpen: 0.8,
  brightness: 0,
  contrast: 0,
  gamma: 1,
  invert: false,
};

export function toGray(rgba: Uint8ClampedArray, width: number, height: number): Gray {
  const data = new Float32Array(width * height);
  for (let i = 0; i < data.length; i++) {
    data[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  }
  return { width, height, data };
}

export function median3(img: Gray): Gray {
  const { width: w, height: h, data } = img;
  const out = new Float32Array(data.length);
  const win = new Float32Array(9);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          const yy = Math.min(h - 1, Math.max(0, y + dy));
          win[n++] = data[yy * w + xx];
        }
      win.sort();
      out[y * w + x] = win[4];
    }
  return { width: w, height: h, data: out };
}

export function boxBlur(img: Gray, r: number): Gray {
  const { width: w, height: h, data } = img;
  const tmp = new Float32Array(data.length);
  const out = new Float32Array(data.length);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let k = -r; k <= r; k++) s += data[y * w + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = s / n;
      s += data[y * w + Math.min(w - 1, x + r + 1)] - data[y * w + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let k = -r; k <= r; k++) s += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s / n;
      s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return { width: w, height: h, data: out };
}

/** CLAHE (equalização adaptativa com limite de contraste) e interpolação bilinear entre blocos. */
export function clahe(img: Gray, clipLimit: number, tiles: number): Gray {
  const { width: w, height: h, data } = img;
  const bins = 256;
  const tx = Math.max(1, Math.min(tiles, Math.floor(w / 8)));
  const ty = Math.max(1, Math.min(tiles, Math.floor(h / 8)));
  const luts: Float32Array[] = [];
  for (let j = 0; j < ty; j++)
    for (let i = 0; i < tx; i++) {
      const x0 = Math.floor((i * w) / tx);
      const x1 = Math.floor(((i + 1) * w) / tx);
      const y0 = Math.floor((j * h) / ty);
      const y1 = Math.floor(((j + 1) * h) / ty);
      const hist = new Float32Array(bins);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) hist[Math.min(255, Math.max(0, data[y * w + x] | 0))]++;
      const count = (x1 - x0) * (y1 - y0);
      const limit = Math.max(1, (clipLimit * count) / bins);
      let excess = 0;
      for (let b = 0; b < bins; b++)
        if (hist[b] > limit) {
          excess += hist[b] - limit;
          hist[b] = limit;
        }
      const add = excess / bins;
      const lut = new Float32Array(bins);
      let cum = 0;
      for (let b = 0; b < bins; b++) {
        cum += hist[b] + add;
        lut[b] = (cum / count) * 255;
      }
      luts.push(lut);
    }
  const out = new Float32Array(data.length);
  for (let y = 0; y < h; y++) {
    const fy = (y + 0.5) / (h / ty) - 0.5;
    const j0 = Math.max(0, Math.min(ty - 1, Math.floor(fy)));
    const j1 = Math.min(ty - 1, j0 + 1);
    const wy = Math.max(0, Math.min(1, fy - j0));
    for (let x = 0; x < w; x++) {
      const fx = (x + 0.5) / (w / tx) - 0.5;
      const i0 = Math.max(0, Math.min(tx - 1, Math.floor(fx)));
      const i1 = Math.min(tx - 1, i0 + 1);
      const wx = Math.max(0, Math.min(1, fx - i0));
      const b = Math.min(255, Math.max(0, data[y * w + x] | 0));
      const top = luts[j0 * tx + i0][b] * (1 - wx) + luts[j0 * tx + i1][b] * wx;
      const bot = luts[j1 * tx + i0][b] * (1 - wx) + luts[j1 * tx + i1][b] * wx;
      out[y * w + x] = top * (1 - wy) + bot * wy;
    }
  }
  return { width: w, height: h, data: out };
}

export function enhance(src: Gray, o: EnhanceOptions): Gray {
  let img = src;
  if (o.denoise > 0) {
    img = median3(img);
    if (o.denoise > 1) {
      const blur = boxBlur(img, o.denoise - 1);
      // mistura parcial para não apagar bordas finas
      const a = 0.5;
      const d = new Float32Array(img.data.length);
      for (let i = 0; i < d.length; i++) d[i] = img.data[i] * (1 - a) + blur.data[i] * a;
      img = { ...img, data: d };
    }
  }
  if (o.clahe > 0) img = clahe(img, o.clahe, o.claheTiles);
  if (o.sharpen > 0) {
    const blur = boxBlur(img, 2);
    const d = new Float32Array(img.data.length);
    for (let i = 0; i < d.length; i++) d[i] = img.data[i] + (img.data[i] - blur.data[i]) * o.sharpen;
    img = { ...img, data: d };
  }
  const c = (100 + o.contrast) / 100;
  const out = new Float32Array(img.data.length);
  for (let i = 0; i < out.length; i++) {
    let v = (img.data[i] - 128) * c + 128 + o.brightness * 1.28;
    v = Math.max(0, Math.min(255, v));
    if (o.gamma !== 1) v = 255 * Math.pow(v / 255, 1 / o.gamma);
    out[i] = o.invert ? 255 - v : v;
  }
  return { width: img.width, height: img.height, data: out };
}

export function grayToRgba(img: Gray, rgba: Uint8ClampedArray) {
  for (let i = 0; i < img.data.length; i++) {
    const v = img.data[i];
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
}
