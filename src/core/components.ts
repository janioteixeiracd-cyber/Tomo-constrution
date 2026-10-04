import type { Vec3 } from './types';

/**
 * Rotula componentes conexos (vizinhança 6) de field > 0 e descarta os pequenos:
 * menores que 0,5% do maior componente ou que 150 mm³.
 * Altera `field` in-place (voxels removidos ficam levemente negativos).
 */
export function keepLargeComponents(field: Float32Array, dims: Vec3, spacing: Vec3) {
  const [nx, ny, nz] = dims;
  const plane = nx * ny;
  const n = field.length;
  const labels = new Int32Array(n);
  const sizes: number[] = [0];
  const queue = new Int32Array(n);
  for (let start = 0; start < n; start++) {
    if (field[start] <= 0 || labels[start]) continue;
    const label = sizes.length;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    labels[start] = label;
    while (head < tail) {
      const i = queue[head++];
      const x = i % nx;
      const y = ((i / nx) | 0) % ny;
      const z = (i / plane) | 0;
      const visit = (j: number) => {
        if (field[j] > 0 && !labels[j]) {
          labels[j] = label;
          queue[tail++] = j;
        }
      };
      if (x > 0) visit(i - 1);
      if (x < nx - 1) visit(i + 1);
      if (y > 0) visit(i - nx);
      if (y < ny - 1) visit(i + nx);
      if (z > 0) visit(i - plane);
      if (z < nz - 1) visit(i + plane);
    }
    sizes.push(tail);
  }
  const largest = Math.max(0, ...sizes);
  const voxelMm3 = spacing[0] * spacing[1] * spacing[2];
  const minSize = Math.max(largest * 0.005, 150 / voxelMm3);
  const drop = sizes.map((s, l) => l > 0 && s < minSize);
  const mask = new Uint8Array(n);
  let parts = 0;
  for (let l = 1; l < drop.length; l++) if (drop[l]) parts++;
  if (parts) {
    for (let i = 0; i < n; i++) {
      if (labels[i] && drop[labels[i]]) {
        mask[i] = 1;
        field[i] = -0.01;
      }
    }
  }
  return { parts, mask, components: sizes.length - 1 - parts };
}
