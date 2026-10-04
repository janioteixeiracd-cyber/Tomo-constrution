export type Vec3 = [number, number, number];

/** Volume em HU, ordem de memória x (colunas) → y (linhas) → z (cortes). */
export interface Volume {
  dims: Vec3;
  /** mm entre centros de voxels em x, y, z */
  spacing: Vec3;
  /** posição (mm, coordenadas do paciente) do voxel 0,0,0 */
  origin: Vec3;
  /** cossenos diretores: [linha(x)..., coluna(y)..., normal(z)...] */
  direction: number[];
  data: Int16Array;
}

export interface SeriesSummary {
  id: string;
  description: string;
  seriesNumber: number | null;
  modality: string;
  imageCount: number;
  frameCount: number;
  rows: number;
  cols: number;
  pixelSpacing: [number, number] | null;
  sliceThickness: number | null;
  /** espaçamento estimado entre cortes (mm), se calculável */
  estimatedSpacing: number | null;
  imageType: string;
  transferSyntax: string;
  thumbnail?: { width: number; height: number; pixels: Uint8ClampedArray };
}

export interface StudyInfo {
  patientName: string;
  patientId: string;
  studyDate: string;
  manufacturer: string;
  model: string;
  kvp: string;
}

export type QualityLevel = 'boa' | 'moderada' | 'limitada';

export interface QualityReport {
  level: QualityLevel;
  /** 0–100, apenas indicativo */
  score: number;
  facts: { label: string; value: string }[];
  warnings: string[];
  /** Texto de aviso que acompanha toda reconstrução */
  disclaimer: string;
}

export interface BuiltVolume {
  volume: Volume;
  quality: QualityReport;
  study: StudyInfo;
  series: SeriesSummary;
  /** janela sugerida pelo próprio DICOM */
  window: { center: number; width: number } | null;
}

export type InterpolationMethod = 'linear' | 'cubic' | 'shape';

export interface ReconOptions {
  /** limiar ósseo em HU (ou valor do aparelho em CBCT) */
  threshold: number;
  /** espaçamento alvo (mm) do volume reconstruído */
  targetSpacing: number;
  interpolation: InterpolationMethod;
  /** sigma (mm) da suavização gaussiana antes da superfície; 0 = desligado */
  smoothing: number;
  /** remove fragmentos pequenos (suporte de cabeça, mesa, ruído) */
  removeSmallParts: boolean;
}

export interface ReconResult {
  /** volume em HU reamostrado, para renderização volumétrica */
  intensity: Volume;
  /** campo para extração de superfície: isovalor 0 = superfície óssea (positivo = osso) */
  surfaceField: { dims: Vec3; spacing: Vec3; origin: Vec3; direction: number[]; data: Float32Array };
  notes: string[];
}
