import daikon from 'daikon';
import { unzipSync } from 'fflate';
import { assembleVolume, type SliceInput } from './assemble';
import { cross, dot, normalize } from './math';
import { assessQuality } from './quality';
import type { BuiltVolume, SeriesGeometry, SeriesSummary, StudyInfo, Vec3 } from './types';

export interface InputFile {
  name: string;
  buffer: ArrayBuffer;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type DaikonImage = any;

export interface ParsedImage {
  image: DaikonImage;
  fileName: string;
}

export interface ParseResult {
  series: Map<string, ParsedImage[]>;
  skipped: { name: string; reason: string }[];
}

const isZip = (b: ArrayBuffer) => {
  const u = new Uint8Array(b, 0, Math.min(4, b.byteLength));
  return u[0] === 0x50 && u[1] === 0x4b && u[2] === 0x03 && u[3] === 0x04;
};

/** Expande arquivos .zip (inclusive aninhados) em arquivos individuais. */
export function expandArchives(files: InputFile[]): InputFile[] {
  const out: InputFile[] = [];
  for (const f of files) {
    if (f.buffer.byteLength >= 4 && isZip(f.buffer)) {
      const entries = unzipSync(new Uint8Array(f.buffer));
      const inner: InputFile[] = [];
      for (const [name, data] of Object.entries(entries)) {
        if (name.endsWith('/') || !data.byteLength || /(^|\/)(__MACOSX|\.)/.test(name)) continue;
        inner.push({ name, buffer: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer });
      }
      out.push(...expandArchives(inner));
    } else {
      out.push(f);
    }
  }
  return out;
}

const tagValue = (img: DaikonImage, group: number, element: number): any => {
  const t = img.getTag(group, element);
  if (!t || t.value == null) return null;
  return Array.isArray(t.value) ? t.value : [t.value];
};

const tagString = (img: DaikonImage, group: number, element: number): string => {
  const v = tagValue(img, group, element);
  return v ? v.map(String).join('\\').trim() : '';
};

const tagNumber = (img: DaikonImage, group: number, element: number): number | null => {
  const v = tagValue(img, group, element);
  const n = v ? parseFloat(v[0]) : NaN;
  return Number.isFinite(n) ? n : null;
};

export function parseFiles(files: InputFile[]): ParseResult {
  const series = new Map<string, ParsedImage[]>();
  const skipped: ParseResult['skipped'] = [];
  for (const f of expandArchives(files)) {
    let image: DaikonImage = null;
    let failure = '';
    try {
      image = daikon.Series.parseImage(new DataView(f.buffer));
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
    }
    if (!image) {
      skipped.push({ name: f.name, reason: `não é um arquivo DICOM legível${failure ? ` (${failure})` : ''}` });
      continue;
    }
    if (!image.hasPixelData()) {
      skipped.push({ name: f.name, reason: 'DICOM sem imagem (relatório/estrutura)' });
      continue;
    }
    const orientation: number[] | null = image.getImageDirections();
    const key = `${image.getSeriesInstanceUID() || 'serie'}|${image.getRows()}x${image.getCols()}|${
      orientation ? orientation.map((v: number) => v.toFixed(2)).join(',') : ''
    }`;
    if (!series.has(key)) series.set(key, []);
    series.get(key)!.push({ image, fileName: f.name });
  }
  return { series, skipped };
}

/** Contraste: etiqueta Contrast/Bolus Agent (0018,0010) ou descrição como "C/C", "com contraste", "C+". */
export function hasContrast(img: DaikonImage): boolean {
  const agent = tagString(img, 0x0018, 0x0010);
  if (agent && !/^(none|nenhum|sem|no|n\/a)$/i.test(agent)) return true;
  const desc = `${img.getSeriesDescription() ?? ''} ${tagString(img, 0x0008, 0x1030)}`;
  return /\bc\s*\/\s*c\b|com\s+contraste|\bcontraste\b|\bc\+|\bpos[- ]?contraste|\bangio/i.test(desc) && !/sem\s+contraste|\bs\s*\/\s*c\b/i.test(desc);
}

export function studyInfo(img: DaikonImage): StudyInfo {
  const name = String(img.getPatientName() ?? '').replace(/\^/g, ' ').trim();
  const date = String(img.getStudyDate() ?? '');
  return {
    patientName: name,
    patientId: String(img.getPatientID() ?? ''),
    studyDate: date ? new Date(date).toLocaleDateString('pt-BR') : '',
    manufacturer: tagString(img, 0x0008, 0x0070),
    model: tagString(img, 0x0008, 0x1090),
    kvp: tagString(img, 0x0018, 0x0060),
    contrast: hasContrast(img),
  };
}

function estimateSpacing(items: ParsedImage[]): number | null {
  const first = items[0].image;
  const o: number[] | null = first.getImageDirections();
  if (!o || items.length < 2) return null;
  const n = normalize(cross([o[0], o[1], o[2]], [o[3], o[4], o[5]]));
  const zs = items
    .map((it) => it.image.getImagePosition() as number[] | null)
    .filter((p): p is number[] => !!p)
    .map((p) => dot(p, n))
    .sort((a, b) => a - b);
  if (zs.length < 2) return null;
  const gaps = zs.slice(1).map((z, i) => z - zs[i]).filter((g) => g > 1e-3);
  if (!gaps.length) return null;
  gaps.sort((a, b) => a - b);
  return gaps[gaps.length >> 1];
}

function thumbnail(img: DaikonImage, frame?: number): SeriesSummary['thumbnail'] {
  try {
    const d = frame == null ? img.getInterpretedData(false, true) : img.getInterpretedData(false, true, frame);
    const rows = img.getRows();
    const cols = img.getCols();
    const size = 96;
    const scale = Math.max(rows, cols) / size;
    const w = Math.max(1, Math.round(cols / scale));
    const h = Math.max(1, Math.round(rows / scale));
    const px = new Uint8ClampedArray(w * h * 4);
    const lo = 400 - 1300;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const v = d.data[Math.min(rows - 1, Math.floor(y * scale)) * cols + Math.min(cols - 1, Math.floor(x * scale))];
        const g = Math.max(0, Math.min(255, ((v - lo) / 2600) * 255));
        const o = (y * w + x) * 4;
        px[o] = px[o + 1] = px[o + 2] = g;
        px[o + 3] = 255;
      }
    return { width: w, height: h, pixels: px };
  } catch {
    return undefined;
  }
}

export function summarizeSeries(id: string, items: ParsedImage[], withThumb = true): SeriesSummary {
  const img = items[0].image;
  const frames = items.reduce((n, it) => n + (it.image.getNumberOfFrames() || 1), 0);
  const ps = img.getPixelSpacing() as number[] | null;
  const sorted = [...items].sort((a, b) => (a.image.getImageNumber() ?? 0) - (b.image.getImageNumber() ?? 0));
  const mid = sorted[sorted.length >> 1].image;
  const midFrame = items.length === 1 && frames > 1 ? frames >> 1 : undefined;
  return {
    id,
    description: String(img.getSeriesDescription() ?? '').trim() || 'Série sem nome',
    seriesNumber: img.getSeriesNumber() ?? null,
    modality: String(img.getModality() ?? ''),
    imageCount: items.length,
    frameCount: frames,
    rows: img.getRows(),
    cols: img.getCols(),
    pixelSpacing: ps && ps.length >= 2 ? [ps[0], ps[1]] : null,
    sliceThickness: img.getSliceThickness() || null,
    estimatedSpacing: estimateSpacing(items) ?? (items.length === 1 ? tagNumber(img, 0x0018, 0x0088) : null),
    imageType: (img.getImageType() ?? []).join('\\'),
    transferSyntax: String(img.getTransferSyntax() ?? ''),
    thumbnail: withThumb ? thumbnail(mid, midFrame) : undefined,
    geometry: seriesGeometry(items),
  };
}

/** Normal e caixa envolvente da série no espaço do paciente, só com o cabeçalho (sem decodificar). */
function seriesGeometry(items: ParsedImage[]): SeriesGeometry | undefined {
  const img = items[0].image;
  const o = img.getImageDirections() as number[] | null;
  const ps = img.getPixelSpacing() as number[] | null;
  if (!o || o.length !== 6 || !ps) return undefined;
  const row = normalize([o[0], o[1], o[2]]);
  const col = normalize([o[3], o[4], o[5]]);
  const normal = normalize(cross(row, col));
  const w = img.getCols() * ps[1];
  const h = img.getRows() * ps[0];
  const b: SeriesGeometry['bounds'] = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
  const add = (p: number[]) => {
    for (let a = 0; a < 3; a++) {
      b[2 * a] = Math.min(b[2 * a], p[a]);
      b[2 * a + 1] = Math.max(b[2 * a + 1], p[a]);
    }
  };
  let positions = items.map((it) => it.image.getImagePosition() as number[] | null).filter((p): p is number[] => !!p && p.length === 3);
  if (items.length === 1 && img.getNumberOfFrames() > 1 && positions.length === 1) {
    const step = tagNumber(img, 0x0018, 0x0088) ?? img.getSliceThickness() ?? 1;
    const p0 = positions[0];
    const last = p0.map((v, a) => v + normal[a] * step * (img.getNumberOfFrames() - 1));
    positions = [p0, last];
  }
  if (!positions.length) return undefined;
  for (const p of positions)
    for (const [cu, cv] of [
      [0, 0],
      [w, 0],
      [0, h],
      [w, h],
    ])
      add([p[0] + row[0] * cu + col[0] * cv, p[1] + row[1] * cu + col[1] * cv, p[2] + row[2] * cu + col[2] * cv]);
  return {
    normal,
    bounds: b,
    frameOfReference: tagString(img, 0x0020, 0x0052),
    colorImages: img.getNumberOfSamplesPerPixel() > 1,
  };
}

/** Escolhe a série mais adequada para 3D: mais cortes e menor espaçamento. */
export function pickBestSeries(summaries: SeriesSummary[]): SeriesSummary | undefined {
  const rank = (s: SeriesSummary) => {
    if (s.frameCount < 3 || s.rows < 128) return -1;
    const sp = s.estimatedSpacing ?? s.sliceThickness ?? 5;
    return s.frameCount / Math.max(0.3, sp);
  };
  return [...summaries].sort((a, b) => rank(b) - rank(a))[0];
}

const toPixels = (img: DaikonImage, frame?: number) => () => {
  if (img.getNumberOfSamplesPerPixel() > 1) {
    throw new Error('Série colorida (provavelmente captura de tela). Use a aba "Imagem 2D" para esse tipo de arquivo.');
  }
  const d = frame == null ? img.getInterpretedData(false, true) : img.getInterpretedData(false, true, frame);
  if (img.getPhotometricInterpretation?.() === 'MONOCHROME1') {
    const out = new Float32Array(d.data.length);
    for (let i = 0; i < out.length; i++) out[i] = d.max + d.min - d.data[i];
    return out;
  }
  return d.data as ArrayLike<number>;
};

export function buildVolume(id: string, items: ParsedImage[]): BuiltVolume {
  const first = items[0].image;
  const multiFrame = items.length === 1 && first.getNumberOfFrames() > 1;
  let slices: SliceInput[];
  const ps = first.getPixelSpacing() as number[] | null;
  const pixelSpacing: [number, number] | null = ps && ps.length >= 2 ? [ps[0], ps[1]] : null;
  if (multiFrame) {
    const n = first.getNumberOfFrames();
    const o: number[] = first.getImageDirections() ?? [1, 0, 0, 0, 1, 0];
    const normal = normalize(cross([o[0], o[1], o[2]], [o[3], o[4], o[5]]));
    const step = tagNumber(first, 0x0018, 0x0088) ?? first.getSliceThickness() ?? 1;
    const p0: number[] = first.getImagePosition() ?? [0, 0, 0];
    slices = Array.from({ length: n }, (_, f) => ({
      rows: first.getRows(),
      cols: first.getCols(),
      position: [p0[0] + normal[0] * step * f, p0[1] + normal[1] * step * f, p0[2] + normal[2] * step * f] as Vec3,
      orientation: o,
      pixelSpacing,
      thickness: step,
      instance: f,
      pixels: toPixels(first, f),
    }));
  } else {
    slices = items.map(({ image }) => {
      const p = image.getImagePosition() as number[] | null;
      const sp = image.getPixelSpacing() as number[] | null;
      return {
        rows: image.getRows(),
        cols: image.getCols(),
        position: p && p.length === 3 ? ([p[0], p[1], p[2]] as Vec3) : null,
        orientation: image.getImageDirections(),
        pixelSpacing: sp && sp.length >= 2 ? [sp[0], sp[1]] : pixelSpacing,
        thickness: image.getSliceThickness() || null,
        instance: image.getImageNumber() ?? 0,
        pixels: toPixels(image),
      };
    });
  }

  const { volume, geometry } = assembleVolume(slices);
  const summary = summarizeSeries(id, items, false);
  const study = studyInfo(first);
  const quality = assessQuality({
    volume,
    geometry,
    transferSyntax: summary.transferSyntax,
    lossyFlag: tagString(first, 0x0028, 0x2110) === '01',
    imageType: summary.imageType,
    manufacturer: study.manufacturer,
    modality: summary.modality,
    multiFrame,
  });
  const wc = first.getWindowCenter();
  const ww = first.getWindowWidth();
  return {
    volume,
    quality,
    study,
    series: summary,
    window: wc != null && ww ? { center: wc, width: ww } : null,
  };
}
