import { describe, expect, it } from 'vitest';
import { buildArch, crossSection, panoramic, type Pt } from './panoramic';
import { segmentBone } from './segment';
import type { ReconResult, Vec3, Volume } from './types';

const N = 64;

/** Volume com um "arco" em U de alta densidade (raio 20 mm) entre z=20 e z=40. */
function archVolume(): Volume {
  const data = new Int16Array(N * N * N).fill(-1000);
  const cx = 32;
  const cy = 36;
  for (let z = 20; z < 40; z++)
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const r = Math.hypot(x - cx, y - cy);
        // metade anterior (y < cy) do anel = arco dentário
        if (Math.abs(r - 20) < 2.5 && y <= cy) data[z * N * N + y * N + x] = 2000;
      }
  return { dims: [N, N, N], spacing: [1, 1, 1], origin: [0, 0, 0], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], data };
}

describe('panorâmica', () => {
  const vol = archVolume();
  const control: Pt[] = [
    [52, 36],
    [46, 22],
    [32, 16],
    [18, 22],
    [12, 36],
  ];

  it('começa pelo lado direito do paciente e tem o comprimento do arco', () => {
    const arch = buildArch(control, vol)!;
    // +x aponta para a esquerda do paciente, então o primeiro ponto deve ter x menor
    expect(arch.points[0][0]).toBeLessThan(arch.points[arch.points.length - 1][0]);
    // meia circunferência de raio 20 ≈ 62,8 mm
    expect(arch.length).toBeGreaterThan(55);
    expect(arch.length).toBeLessThan(70);
    // normais apontam para fora do arco (vestibular): no ponto anterior, para -y
    const mid = arch.normals[Math.floor(arch.normals.length / 2)];
    expect(mid[1]).toBeLessThan(-0.9);
  });

  it('mostra o arco claro na faixa de altura certa', () => {
    const arch = buildArch(control, vol)!;
    const img = panoramic(vol, arch, 10, 'mip');
    const col = Math.floor(img.width / 2);
    // linha superior é z máximo (superior); o arco ocupa z 20–39
    const at = (z: number) => img.data[(img.height - 1 - z) * img.width + col];
    expect(at(30)).toBeGreaterThan(1500);
    expect(at(10)).toBeLessThan(-500);
    expect(at(50)).toBeLessThan(-500);
  });

  it('corte transversal tem o osso no centro', () => {
    const arch = buildArch(control, vol)!;
    const img = crossSection(vol, arch, Math.floor(arch.points.length / 2), 30);
    const row = img.height - 1 - 30;
    expect(img.data[row * img.width + Math.floor(img.width / 2)]).toBeGreaterThan(1500);
    expect(img.data[row * img.width + 1]).toBeLessThan(-500);
  });
});

describe('segmentação', () => {
  it('separa uma "mandíbula" inferior e dentes de alta densidade do crânio', () => {
    const dims: Vec3 = [N, N, N];
    const hu = new Int16Array(N ** 3).fill(-1000);
    const set = (x: number, y: number, z: number, v: number) => (hu[z * N * N + y * N + x] = v);
    // "crânio": bloco grande superior
    for (let z = 37; z < 63; z++) for (let y = 8; y < 56; y++) for (let x = 8; x < 56; x++) set(x, y, z, 1000);
    // "mandíbula": bloco largo inferior (~45 cm³, 33 mm de altura), separado por 3 voxels e
    // ligado ao crânio por uma ponte fina (como a ATM)
    for (let z = 1; z < 34; z++) for (let y = 6; y < 33; y++) for (let x = 6; x < 58; x++) set(x, y, z, 900);
    for (let z = 34; z < 37; z++) set(30, 15, z, 900);
    // "dentes": esmalte no topo da mandíbula (plano oclusal acima do corpo da mandíbula)
    for (let z = 29; z < 33; z++) for (let y = 12; y < 18; y++) for (let x = 20; x < 44; x += 6) for (let d = 0; d < 3; d++) set(x + d, y, z, 2800);
    const field = new Float32Array(hu.length);
    for (let i = 0; i < hu.length; i++) field[i] = hu[i] - 200;
    const vol: Volume = { dims, spacing: [1, 1, 1], origin: [0, 0, 0], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], data: hu };
    const rec: ReconResult = { intensity: vol, surfaceField: { ...vol, data: field }, notes: [] };
    const seg = segmentBone(rec, 200, true);
    const keys = seg.stats.map((s) => s.key);
    expect(keys).toEqual(['cranio', 'mandibula', 'dentes']);
    expect(seg.labels[15 * N * N + 15 * N + 10]).toBe(2); // mandíbula
    expect(seg.labels[50 * N * N + 30 * N + 30]).toBe(1); // crânio
    expect(seg.labels[31 * N * N + 15 * N + 21]).toBe(3); // dente
  });

  it('não chama de mandíbula uma peça que não chega ao ponto mais baixo do osso', () => {
    const dims: Vec3 = [N, N, N];
    const hu = new Int16Array(N ** 3).fill(-1000);
    const set = (x: number, y: number, z: number, v: number) => (hu[z * N * N + y * N + x] = v);
    for (let z = 34; z < 62; z++) for (let y = 8; y < 56; y++) for (let x = 8; x < 56; x++) set(x, y, z, 1000);
    // peça larga e grande, solta, no meio da altura (como paredes laterais isoladas pela erosão)
    for (let z = 12; z < 32; z++) for (let y = 6; y < 33; y++) for (let x = 6; x < 58; x++) set(x, y, z, 900);
    // coluna estreita e posterior que desce até a borda inferior
    for (let z = 0; z < 34; z++) for (let y = 44; y < 52; y++) for (let x = 28; x < 36; x++) set(x, y, z, 900);
    const field = new Float32Array(hu.length);
    for (let i = 0; i < hu.length; i++) field[i] = hu[i] - 200;
    const vol: Volume = { dims, spacing: [1, 1, 1], origin: [0, 0, 0], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], data: hu };
    const seg = segmentBone({ intensity: vol, surfaceField: { ...vol, data: field }, notes: [] }, 200, true);
    expect(seg.stats.map((s) => s.key)).not.toContain('mandibula');
  });
});
