/** Classes de tecido para a renderização volumétrica, por faixa de densidade (HU em TC calibrada). */
export interface TissueClass {
  key: string;
  name: string;
  /** faixa de densidade (HU) */
  lo: number;
  hi: number;
  color: [number, number, number];
  /** opacidade por unidade de distância (0–1) */
  opacity: number;
  enabled: boolean;
  /** só faz sentido em exame com contraste */
  needsContrast?: boolean;
  /** observação curta exibida ao lado do nome */
  note?: string;
}

export function defaultTissues(boneThreshold: number, contrast: boolean): TissueClass[] {
  // com contraste, vasos e osso se sobrepõem perto de 200 HU: o osso começa mais alto
  const boneLo = contrast ? Math.max(boneThreshold, 450) : boneThreshold;
  return [
    { key: 'pele', name: 'Pele (superfície)', lo: -500, hi: -150, color: [0.88, 0.66, 0.55], opacity: 0.25, enabled: false },
    { key: 'gordura', name: 'Gordura', lo: -140, hi: -50, color: [0.95, 0.85, 0.45], opacity: 0.03, enabled: false },
    {
      key: 'glandulas',
      name: 'Glândulas',
      lo: -30,
      hi: 25,
      color: [0.95, 0.58, 0.78],
      opacity: 0.04,
      enabled: false,
      note: 'aproximado: parótida e submandibular ficam entre gordura e músculo',
    },
    { key: 'musculo', name: 'Músculos e partes moles', lo: 30, hi: 90, color: [0.78, 0.3, 0.3], opacity: 0.03, enabled: false },
    {
      key: 'vasos',
      name: 'Vasos com contraste',
      lo: 150,
      hi: Math.min(boneLo - 10, 450),
      color: [1, 0.18, 0.2],
      opacity: 0.45,
      enabled: contrast,
      needsContrast: true,
      note: contrast ? 'artérias e veias realçadas pelo contraste' : 'este exame não parece ter contraste',
    },
    { key: 'osso', name: 'Osso', lo: boneLo, hi: 1800, color: [0.93, 0.89, 0.8], opacity: 0.55, enabled: true },
    { key: 'dentes', name: 'Dentes (esmalte)', lo: 1800, hi: 2999, color: [1, 1, 0.97], opacity: 0.85, enabled: true },
    { key: 'metal', name: 'Metal', lo: 3000, hi: 4095, color: [1, 0.74, 0.18], opacity: 1, enabled: true },
  ];
}

export const TISSUE_PRESETS: Record<string, string[]> = {
  osso: ['osso', 'dentes', 'metal'],
  'osso-pele': ['pele', 'osso', 'dentes', 'metal'],
  pele: ['pele'],
  'partes-moles': ['gordura', 'glandulas', 'musculo', 'osso', 'dentes', 'metal'],
  vasos: ['vasos', 'osso', 'dentes', 'metal'],
};

export interface TransferSample {
  hu: number;
  color: [number, number, number];
  opacity: number;
}

/**
 * Amostra a função de transferência a cada 5 HU: em cada densidade vale a classe ativa mais
 * opaca, com bordas suaves de 20 HU para não formar degraus na renderização.
 */
export function sampleTransfer(classes: TissueClass[], step = 5): TransferSample[] {
  const active = classes.filter((c) => c.enabled && c.hi > c.lo);
  const out: TransferSample[] = [];
  const edge = 20;
  for (let hu = -1024; hu <= 4100; hu += step) {
    let best: TissueClass | null = null;
    let bestA = 0;
    for (const c of active) {
      let w = 0;
      if (hu >= c.lo && hu <= c.hi) w = 1;
      else if (hu < c.lo && hu > c.lo - edge) w = 1 - (c.lo - hu) / edge;
      else if (hu > c.hi && hu < c.hi + edge) w = 1 - (hu - c.hi) / edge;
      const a = w * c.opacity;
      if (a > bestA) {
        bestA = a;
        best = c;
      }
    }
    out.push({ hu, color: best ? best.color : [0, 0, 0], opacity: bestA });
  }
  return out;
}
