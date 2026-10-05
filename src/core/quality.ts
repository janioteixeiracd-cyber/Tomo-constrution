import type { Geometry } from './assemble';
import { fmt } from './math';
import type { QualityLevel, QualityReport, Volume } from './types';

export interface QualityInput {
  volume: Volume;
  geometry: Geometry;
  transferSyntax: string;
  lossyFlag: boolean;
  imageType: string;
  manufacturer: string;
  modality: string;
  multiFrame: boolean;
}

const LOSSY_SYNTAXES = new Set([
  '1.2.840.10008.1.2.4.50', // JPEG Baseline
  '1.2.840.10008.1.2.4.51', // JPEG Extended (12 bits)
  '1.2.840.10008.1.2.4.81', // JPEG-LS near-lossless
  '1.2.840.10008.1.2.4.91', // JPEG 2000 com perdas
  '1.2.840.10008.1.2.4.203',
]);

/** Fabricantes cujo equipamento costuma ser tomografia de feixe cônico (CBCT). */
const CBCT_VENDORS = /planmeca|carestream|kodak|sirona|dentsply|vatech|imaging sciences|i-?cat|newtom|qr srl|kavo|morita|gendex|soredex|instrumentarium|myray|cefla|prexion|acteon|owandy|hdx|genoray|ray co/i;


export const isLossySyntax = (ts: string) => LOSSY_SYNTAXES.has(ts);

export function assessQuality(q: QualityInput): QualityReport {
  const { volume, geometry } = q;
  const [nx, ny, nz] = volume.dims;
  const [sx, sy, sz] = volume.spacing;
  const inPlane = Math.max(sx, sy);
  const anisotropy = sz / Math.min(sx, sy);
  const coverage = (nz - 1) * sz;
  const warnings: string[] = [];
  let score = 100;

  if (sz > 3) {
    score -= 45;
    warnings.push(
      `Espaçamento entre cortes de ${fmt(sz)} mm (ideal ≤ 1 mm). Entre um corte e outro a anatomia é estimada por interpolação: paredes finas (assoalho de órbita, seios, processo alveolar, côndilo) podem aparecer com degraus, buracos ou espessura alterada.`,
    );
  } else if (sz > 1.25) {
    score -= 20;
    warnings.push(
      `Espaçamento entre cortes de ${fmt(sz)} mm. Estruturas ósseas finas podem ficar serrilhadas ou incompletas no 3D.`,
    );
  }
  if (nz < 40) {
    score -= 15;
    warnings.push(`Apenas ${nz} cortes na série. Pode ser uma série de reformatação/resumo e não o volume completo do exame.`);
  }
  if (inPlane > 0.8) {
    score -= 10;
    warnings.push(`Resolução no plano de ${fmt(inPlane)} mm por pixel; detalhes dentários e corticais finas ficam menos definidos.`);
  }
  if (geometry.irregular) {
    score -= 10;
    warnings.push(
      `Espaçamento irregular entre cortes (de ${fmt(geometry.minGap)} a ${fmt(geometry.maxGap)} mm)` +
        (geometry.gapsFilled ? `; ${geometry.gapsFilled} posição(ões) foram preenchidas por interpolação.` : '.'),
    );
  }
  if (geometry.duplicatesRemoved) {
    warnings.push(`${geometry.duplicatesRemoved} corte(s) duplicado(s) ignorado(s).`);
  }
  if (!geometry.spacingFromPositions) {
    score -= 10;
    warnings.push('O arquivo não traz a posição de cada corte; a ordem e o espaçamento foram deduzidos e podem estar incorretos.');
  }
  if (q.lossyFlag || isLossySyntax(q.transferSyntax)) {
    score -= 5;
    warnings.push('Imagens com compressão com perdas (JPEG). Pode haver pequenos artefatos e variação de densidade.');
  }
  if (/DERIVED|SECONDARY|REFORMATTED/i.test(q.imageType)) {
    score -= 5;
    warnings.push('Série derivada/reformatada pelo aparelho (não é a aquisição original). Se houver uma série volumétrica fina (ex.: "VOL OSSO", 0,6–1,25 mm), prefira exportá-la.');
  }
  if (geometry.obliquityDeg > 2) {
    warnings.push(`Cortes inclinados ${fmt(geometry.obliquityDeg, 1)}° (gantry/reformatação). A geometria foi respeitada no 3D.`);
  }
  if (CBCT_VENDORS.test(q.manufacturer)) {
    warnings.push('Aparelho de feixe cônico (CBCT): os valores de densidade não são HU calibrados. Ajuste o limiar ósseo manualmente se o 3D ficar incompleto ou com excesso.');
  }
  if (q.multiFrame) {
    warnings.push('Arquivo multiframe: posição dos cortes estimada pelo espaçamento informado no cabeçalho.');
  }
  if (q.modality && !/^(CT|CBCT|DX|CR|PX|IO)$/i.test(q.modality)) {
    warnings.push(`Modalidade "${q.modality}": a reconstrução óssea é pensada para tomografia.`);
  }

  score = Math.max(0, Math.min(100, score));
  const level: QualityLevel = score >= 75 ? 'boa' : score >= 45 ? 'moderada' : 'limitada';

  const disclaimer =
    level === 'boa'
      ? 'Reconstrução gerada a partir dos dados disponíveis. Mesmo com boa qualidade de origem, o modelo depende do limiar e do processamento escolhidos — confira sempre nos cortes originais.'
      : 'Reconstrução gerada mesmo com dados limitados. Os dados de origem não têm toda a informação necessária, então forma, espessura e medidas no 3D podem variar em relação à anatomia real. Use para estudo e visualização geral e confirme qualquer achado nos cortes originais.';

  return {
    level,
    score,
    facts: [
      { label: 'Cortes', value: String(nz) },
      { label: 'Matriz', value: `${nx} × ${ny}` },
      { label: 'Pixel', value: `${fmt(sx, 3)} × ${fmt(sy, 3)} mm` },
      { label: 'Entre cortes', value: `${fmt(sz)} mm` },
      { label: 'Anisotropia', value: `${fmt(anisotropy, 1)}×` },
      { label: 'Cobertura', value: `${fmt(coverage, 0)} mm` },
    ],
    warnings,
    disclaimer,
  };
}

export const isCbctVendor = (manufacturer: string) => CBCT_VENDORS.test(manufacturer);

/**
 * Qualidade de um volume fundido: avalia pela resolução efetiva por eixo (a melhor que alguma série
 * oferece) e mantém os avisos da série principal que continuam valendo.
 */
export function assessFusedQuality(
  primary: QualityReport,
  effective: [number, number, number],
  effectiveGap: number,
  seriesCount: number,
  gridMm: number,
): QualityReport {
  // avalia pelo espaçamento efetivo realista, não pela melhor resolução de cada eixo
  const score = effectiveGap <= 1.25 ? 80 : effectiveGap <= 4 ? 60 : 40;
  const level: QualityLevel = score >= 75 ? 'boa' : score >= 45 ? 'moderada' : 'limitada';
  const kept = primary.warnings.filter((w) => !/^Espaçamento entre cortes|^Apenas \d+ cortes/.test(w));
  return {
    level,
    score,
    facts: [
      { label: 'Séries fundidas', value: String(seriesCount) },
      { label: 'Grade', value: `${fmt(gridMm)} mm` },
      { label: 'Espaçamento efetivo', value: `≈ ${fmt(effectiveGap, 1)} mm` },
      { label: 'Melhor L-R / A-P / S-I', value: effective.map((v) => fmt(v, 1)).join(' / ') + ' mm' },
    ],
    warnings: [
      `Volume montado pela fusão de ${seriesCount} séries em orientações diferentes. O detalhe é máximo onde passam cortes reais de alguma série; longe deles (≈ ${fmt(effectiveGap, 1)} mm em média) a anatomia ainda é estimada.`,
      ...kept,
    ],
    disclaimer:
      level === 'boa'
        ? 'Reconstrução gerada pela fusão das séries disponíveis. Confira sempre nos cortes originais.'
        : 'Reconstrução gerada pela fusão das séries disponíveis, mas os dados de origem ainda não têm todo o detalhe necessário: forma, espessura e medidas podem variar em relação à anatomia real. Confirme nos cortes originais.',
  };
}
