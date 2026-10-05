import type { InterpolationMethod, ReconOptions, ReconResult, Vec3, Volume } from './types';
import { fmt, toInt16 } from './math';
import { keepLargeComponents } from './components';
import { signedDistance2D } from './distance';

/** Reduz x/y por média em blocos inteiros (fator ≥ 1). */
export function downsampleXY(vol: Volume, factor: number): Volume {
  if (factor <= 1) return vol;
  const [nx, ny, nz] = vol.dims;
  const ox = Math.floor(nx / factor);
  const oy = Math.floor(ny / factor);
  const out = new Int16Array(ox * oy * nz);
  const inv = 1 / (factor * factor);
  for (let z = 0; z < nz; z++) {
    const zi = z * nx * ny;
    const zo = z * ox * oy;
    for (let y = 0; y < oy; y++)
      for (let x = 0; x < ox; x++) {
        let s = 0;
        for (let dy = 0; dy < factor; dy++) {
          const row = zi + (y * factor + dy) * nx + x * factor;
          for (let dx = 0; dx < factor; dx++) s += vol.data[row + dx];
        }
        out[zo + y * ox + x] = Math.round(s * inv);
      }
  }
  // o centro do novo voxel fica deslocado meio bloco
  const shift = (factor - 1) / 2;
  const d = vol.direction;
  const origin: Vec3 = [
    vol.origin[0] + (d[0] * vol.spacing[0] + d[3] * vol.spacing[1]) * shift,
    vol.origin[1] + (d[1] * vol.spacing[0] + d[4] * vol.spacing[1]) * shift,
    vol.origin[2] + (d[2] * vol.spacing[0] + d[5] * vol.spacing[1]) * shift,
  ];
  return {
    dims: [ox, oy, nz],
    spacing: [vol.spacing[0] * factor, vol.spacing[1] * factor, vol.spacing[2]],
    origin,
    direction: vol.direction,
    data: out,
  };
}

/** Catmull-Rom com pontos extremos repetidos. */
const cubic = (p0: number, p1: number, p2: number, p3: number, t: number) =>
  p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));

/** Reamostra ao longo de z para o espaçamento alvo (interpolação de intensidade). */
export function resampleZ(vol: Volume, targetSpacing: number, method: Exclude<InterpolationMethod, 'shape'>): Volume {
  const [nx, ny, nz] = vol.dims;
  const sz = vol.spacing[2];
  if (nz < 2 || targetSpacing >= sz * 0.95) return vol;
  const span = (nz - 1) * sz;
  const onz = Math.floor(span / targetSpacing) + 1;
  const plane = nx * ny;
  const out = new Int16Array(plane * onz);
  for (let k = 0; k < onz; k++) {
    const zf = (k * targetSpacing) / sz;
    const i1 = Math.min(nz - 1, Math.floor(zf));
    const t = zf - i1;
    const i2 = Math.min(nz - 1, i1 + 1);
    const o = k * plane;
    const a = i1 * plane;
    const b = i2 * plane;
    if (method === 'linear' || t < 1e-4) {
      for (let i = 0; i < plane; i++) out[o + i] = Math.round(vol.data[a + i] + (vol.data[b + i] - vol.data[a + i]) * t);
    } else {
      const p = Math.max(0, i1 - 1) * plane;
      const n = Math.min(nz - 1, i1 + 2) * plane;
      for (let i = 0; i < plane; i++) {
        const v1 = vol.data[a + i];
        const v2 = vol.data[b + i];
        let v = cubic(vol.data[p + i], v1, v2, vol.data[n + i], t);
        // evita "overshoot" (halo escuro/claro) típico do cúbico
        const lo = v1 < v2 ? v1 : v2;
        const hi = v1 < v2 ? v2 : v1;
        v = v < lo ? lo : v > hi ? hi : v;
        out[o + i] = toInt16(v);
      }
    }
  }
  return { ...vol, dims: [nx, ny, onz], spacing: [vol.spacing[0], vol.spacing[1], targetSpacing], data: out };
}

/** Suavização gaussiana separável (sigma em mm) sobre Float32. */
export function gaussian3D(data: Float32Array, dims: Vec3, spacing: Vec3, sigmaMm: number | Vec3): Float32Array {
  const sigmas: Vec3 = typeof sigmaMm === 'number' ? [sigmaMm, sigmaMm, sigmaMm] : sigmaMm;
  if (sigmas.every((v) => v <= 0)) return data;
  const strides = [1, dims[0], dims[0] * dims[1]];
  let cur = data;
  for (let axis = 0; axis < 3; axis++) {
    const sigma = sigmas[axis] / spacing[axis];
    const n = dims[axis];
    if (sigma < 0.3 || n < 2) continue;
    const r = Math.ceil(sigma * 2.5);
    const kernel = new Float32Array(2 * r + 1);
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += kernel[i + r] = Math.exp((-i * i) / (2 * sigma * sigma));
    for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
    const stride = strides[axis];
    const [a1, a2] = [0, 1, 2].filter((a) => a !== axis);
    const next = new Float32Array(cur.length);
    const line = new Float32Array(n);
    for (let u = 0; u < dims[a2]; u++)
      for (let v = 0; v < dims[a1]; v++) {
        const base = u * strides[a2] + v * strides[a1];
        for (let i = 0; i < n; i++) line[i] = cur[base + i * stride];
        for (let i = 0; i < n; i++) {
          let s = 0;
          for (let k = -r; k <= r; k++) {
            const j = i + k < 0 ? 0 : i + k >= n ? n - 1 : i + k;
            s += line[j] * kernel[k + r];
          }
          next[base + i * stride] = s;
        }
      }
    cur = next;
  }
  return cur;
}

/**
 * Interpolação baseada em forma (shape-based): o osso de cada corte vira um mapa de
 * distância com sinal e as distâncias é que são interpoladas entre os cortes.
 * Com cortes espessos isso gera contornos contínuos em vez de "degraus".
 */
export function shapeBasedField(vol: Volume, threshold: number, targetSpacing: number): Float32Array {
  const [nx, ny, nz] = vol.dims;
  const plane = nx * ny;
  const sdf: Float32Array[] = [];
  const mask = new Uint8Array(plane);
  for (let k = 0; k < nz; k++) {
    for (let i = 0; i < plane; i++) mask[i] = vol.data[k * plane + i] >= threshold ? 1 : 0;
    // corte vazio: o osso do vizinho "fecha" em cúpula até a metade do intervalo
    sdf.push(signedDistance2D(mask, nx, ny, vol.spacing[0], vol.spacing[1], 40, -vol.spacing[2] / 2));
  }
  const sz = vol.spacing[2];
  const onz = nz < 2 || targetSpacing >= sz * 0.95 ? nz : Math.floor(((nz - 1) * sz) / targetSpacing) + 1;
  const step = onz === nz ? sz : targetSpacing;
  const out = new Float32Array(plane * onz);
  for (let k = 0; k < onz; k++) {
    const zf = (k * step) / sz;
    const i1 = Math.min(nz - 1, Math.floor(zf));
    const i2 = Math.min(nz - 1, i1 + 1);
    const t = zf - i1;
    const o = k * plane;
    const b = sdf[i1];
    if (t < 1e-4) {
      out.set(b, o);
      continue;
    }
    // Catmull-Rom entre 4 cortes: a forma muda suavemente e não deixa "quinas" em cada corte original
    const a = sdf[Math.max(0, i1 - 1)];
    const c = sdf[i2];
    const d = sdf[Math.min(nz - 1, i1 + 2)];
    for (let i = 0; i < plane; i++) out[o + i] = cubic(a[i], b[i], c[i], d[i], t);
  }
  return out;
}

export function reconstruct(source: Volume, opts: ReconOptions, maxVoxels = 24e6): ReconResult {
  const notes: string[] = [];
  // fator de redução no plano para caber no orçamento de memória/GPU
  const sz = Math.min(source.spacing[2], Math.max(opts.targetSpacing, 0.2));
  const estZ = Math.max(source.dims[2], ((source.dims[2] - 1) * source.spacing[2]) / sz + 1);
  let factor = 1;
  while ((source.dims[0] / factor) * (source.dims[1] / factor) * estZ > maxVoxels) factor++;
  // pixels menores que 0,5 mm não acrescentam detalhe visível ao modelo e custam memória
  while (source.spacing[0] * (factor + 1) <= 0.5) factor++;
  const base = downsampleXY(source, factor);
  if (factor > 1) notes.push(`Resolução no plano reduzida ${factor}× (${fmt(base.spacing[0])} mm por pixel) para caber na memória do aparelho.`);

  const method = opts.interpolation;
  let intensity = resampleZ(base, opts.targetSpacing, method === 'shape' ? 'cubic' : method);
  // nunca altera o volume de origem (usado nos cortes 2D)
  if (intensity.data === source.data) intensity = { ...intensity, data: source.data.slice() };
  if (intensity.dims[2] !== base.dims[2]) {
    notes.push(
      `${intensity.dims[2] - base.dims[2]} cortes intermediários estimados por interpolação ${
        method === 'shape' ? 'baseada em forma' : method === 'cubic' ? 'cúbica' : 'linear'
      } (${fmt(base.spacing[2])} → ${fmt(intensity.spacing[2])} mm).`,
    );
  }

  let field: Float32Array;
  if (method === 'shape') {
    field = shapeBasedField(base, opts.threshold, opts.targetSpacing);
  } else {
    field = new Float32Array(intensity.data.length);
    for (let i = 0; i < field.length; i++) field[i] = intensity.data[i] - opts.threshold;
  }
  if (opts.smoothing > 0) {
    // cortes espessos: suaviza mais entre os cortes (onde não há informação) para apagar os degraus
    const zSigma = source.spacing[2] > 2 * source.spacing[0] ? Math.max(opts.smoothing, 0.25 * source.spacing[2]) : opts.smoothing;
    field = gaussian3D(field, intensity.dims, intensity.spacing, [opts.smoothing, opts.smoothing, zSigma]);
  }

  if (opts.removeSmallParts) {
    const removed = keepLargeComponents(field, intensity.dims, intensity.spacing);
    if (removed.parts > 0) {
      notes.push(`${removed.parts} fragmento(s) pequeno(s) removido(s) (suporte de cabeça, mesa ou ruído).`);
      // aplica a mesma limpeza ao volume de intensidade
      for (let i = 0; i < field.length; i++) {
        if (removed.mask[i] && intensity.data[i] >= opts.threshold) intensity.data[i] = Math.min(intensity.data[i], opts.threshold - 200);
      }
    }
  }

  return {
    intensity,
    surfaceField: {
      dims: intensity.dims,
      spacing: intensity.spacing,
      origin: intensity.origin,
      direction: intensity.direction,
      data: field,
    },
    notes,
  };
}
