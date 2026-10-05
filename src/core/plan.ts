import { dot } from './math';
import type { SeriesSummary, Vec3 } from './types';

export type SeriesRole = 'principal' | 'complementar' | 'ignorada';

export interface ReconPlan {
  strategy: 'single' | 'fusion';
  primaryId: string;
  /** séries usadas, a principal primeiro */
  usedIds: string[];
  roles: { id: string; description: string; role: SeriesRole; reason: string }[];
  /** melhor resolução disponível (mm) em L-R, A-P e S-I (alguma série é nítida nesse eixo) */
  effective: Vec3;
  /**
   * espaçamento efetivo realista (mm): com n séries espessas em orientações diferentes, a distância
   * típica até um corte real cai ~√n vezes, mas não chega à resolução no plano
   */
  effectiveGap: number;
  /** frases curtas explicando a decisão */
  rationale: string[];
}

const AXES: Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

const orientationName = (n: Vec3) => {
  const a = [Math.abs(n[0]), Math.abs(n[1]), Math.abs(n[2])];
  const i = a.indexOf(Math.max(...a));
  return i === 0 ? 'sagital' : i === 1 ? 'coronal' : 'axial';
};

const spacingOf = (s: SeriesSummary) => s.estimatedSpacing ?? s.sliceThickness ?? 5;
const inPlaneOf = (s: SeriesSummary) => Math.max(s.pixelSpacing?.[0] ?? 1, s.pixelSpacing?.[1] ?? 1);

/** Resolução da série ao longo de um eixo do paciente: fina no plano do corte, grossa na normal. */
function resolutionAlong(s: SeriesSummary, axis: Vec3): number {
  const n = s.geometry!.normal;
  const c = Math.abs(dot(n, axis));
  return c * spacingOf(s) + (1 - c) * inPlaneOf(s);
}

function overlapFraction(a: SeriesSummary, b: SeriesSummary): number {
  const A = a.geometry!.bounds;
  const B = b.geometry!.bounds;
  let inter = 1;
  let volB = 1;
  for (let k = 0; k < 3; k++) {
    const lo = Math.max(A[2 * k], B[2 * k]);
    const hi = Math.min(A[2 * k + 1], B[2 * k + 1]);
    inter *= Math.max(0, hi - lo);
    volB *= Math.max(1e-6, B[2 * k + 1] - B[2 * k]);
  }
  return inter / volB;
}

const fmtMm = (v: number) => `${v.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} mm`;

/**
 * Planeja a reconstrução a partir de todas as séries do exame:
 * - com uma série volumétrica fina, usa só ela;
 * - com séries espessas em orientações diferentes (axial, coronal, sagital) que cobrem a mesma região,
 *   funde as séries: cada uma é nítida no próprio plano e complementa as outras.
 */
export function planReconstruction(summaries: SeriesSummary[]): ReconPlan | null {
  const usable = summaries.filter(
    (s) => s.frameCount >= 8 && s.rows >= 128 && s.geometry && !s.geometry.colorImages && !/^(SR|PR|KO|DOC)$/i.test(s.modality),
  );
  const roles: ReconPlan['roles'] = [];
  for (const s of summaries)
    if (!usable.includes(s))
      roles.push({
        id: s.id,
        description: s.description,
        role: 'ignorada',
        reason: s.geometry?.colorImages
          ? 'imagem colorida (captura/relatório)'
          : s.frameCount < 8
            ? 'poucas imagens (localizador ou relatório)'
            : 'sem geometria utilizável',
      });
  if (!usable.length) return null;

  // melhor série única: a de pior eixo mais fino; diferenças pequenas contam como empate e aí
  // vale a axial (orientação padrão dos cortes) e depois a com mais imagens (20% de tolerância)
  const worst = (s: SeriesSummary) => Math.max(...AXES.map((a) => resolutionAlong(s, a)));
  const isAxial = (s: SeriesSummary) => (orientationName(s.geometry!.normal) === 'axial' ? 1 : 0);
  const ranked = [...usable].sort((a, b) => {
    const wa = worst(a);
    const wb = worst(b);
    if (Math.abs(wa - wb) > 0.2 * Math.min(wa, wb)) return wa - wb;
    return isAxial(b) - isAxial(a) || b.frameCount - a.frameCount;
  });
  const primary = ranked[0];
  const rationale: string[] = [];
  const used = [primary];

  if (spacingOf(primary) <= 1.5) {
    rationale.push(
      `Série volumétrica fina disponível (${primary.description}, ${fmtMm(spacingOf(primary))} entre cortes): reconstrução direta, sem precisar estimar anatomia entre cortes.`,
    );
  } else {
    // complementares: mesma referência espacial, orientação diferente, cobrindo a mesma região
    const fr = primary.geometry!.frameOfReference;
    const candidates = ranked
      .slice(1)
      .filter((s) => (!fr || !s.geometry!.frameOfReference || s.geometry!.frameOfReference === fr) && overlapFraction(s, primary) > 0.3);
    for (const c of candidates) {
      if (used.length >= 3) break;
      const distinct = used.every((u) => Math.abs(dot(u.geometry!.normal, c.geometry!.normal)) < 0.7);
      if (distinct) used.push(c);
    }
    if (used.length > 1) {
      rationale.push(
        `Não há série fina; as séries ${used.map((u) => `${orientationName(u.geometry!.normal)} (${fmtMm(spacingOf(u))})`).join(', ')} cobrem a mesma região em orientações diferentes.`,
        'Cada série é nítida no próprio plano e borrada entre cortes; a fusão usa, em cada ponto, a série cujo corte real passa mais perto.',
      );
    } else {
      rationale.push(
        `Só há uma série utilizável com ${fmtMm(spacingOf(primary))} entre cortes: a anatomia entre cortes será estimada pela forma do osso nos cortes vizinhos.`,
        'Para mais detalhe, exporte também as reformatações coronal e sagital, ou a série volumétrica fina do exame.',
      );
    }
  }

  for (const s of usable) {
    const i = used.indexOf(s);
    const orient = orientationName(s.geometry!.normal);
    roles.push({
      id: s.id,
      description: s.description,
      role: i === 0 ? 'principal' : i > 0 ? 'complementar' : 'ignorada',
      reason:
        i === 0
          ? `${orient}, ${s.frameCount} cortes, ${fmtMm(spacingOf(s))} entre cortes`
          : i > 0
            ? `${orient}, preenche o espaço entre os cortes da principal`
            : spacingOf(s) <= spacingOf(primary) * 1.05 && orient === orientationName(primary.geometry!.normal)
              ? 'mesma orientação da principal (não acrescenta informação)'
              : 'cobre outra região ou tem menos detalhe',
    });
  }

  const effective = AXES.map((a) => Math.min(...used.map((s) => resolutionAlong(s, a)))) as Vec3;
  const geo = Math.pow(
    used.reduce((p, s) => p * spacingOf(s), 1),
    1 / used.length,
  );
  const effectiveGap = Math.max(inPlaneOf(primary), geo / Math.sqrt(used.length));
  return {
    effectiveGap,
    strategy: used.length > 1 ? 'fusion' : 'single',
    primaryId: primary.id,
    usedIds: used.map((s) => s.id),
    roles,
    effective,
    rationale,
  };
}
