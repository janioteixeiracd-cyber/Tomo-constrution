/// <reference lib="webworker" />
import { buildVolume, parseFiles, pickBestSeries, summarizeSeries, type InputFile, type ParsedImage } from './core/dicom';
import { extractSurface } from './core/mesh';
import { reconstruct } from './core/resample';
import { segmentBone } from './core/segment';
import { fuseVolumes } from './core/fusion';
import { assessFusedQuality } from './core/quality';
import type { Vec3 } from './core/types';
import type { BuiltVolume, ReconOptions, ReconResult } from './core/types';

export type WorkerRequest =
  | { id: number; type: 'parse'; files: InputFile[] }
  | { id: number; type: 'build'; seriesIds: string[]; effective?: Vec3; effectiveGap?: number; maxVoxels?: number }
  | { id: number; type: 'recon'; options: ReconOptions; maxVoxels: number; smoothIterations: number }
  | { id: number; type: 'segment'; calibratedHU: boolean; smoothIterations: number };

let series = new Map<string, ParsedImage[]>();
let current: BuiltVolume | null = null;
let lastRecon: { rec: ReconResult; threshold: number } | null = null;

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const progress = (id: number, message: string) => ctx.postMessage({ id, progress: message });

ctx.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  try {
    if (req.type === 'parse') {
      progress(req.id, `Lendo ${req.files.length} arquivo(s)…`);
      const parsed = parseFiles(req.files);
      series = parsed.series;
      current = null;
      const summaries = [...series].map(([id, items]) => summarizeSeries(id, items));
      ctx.postMessage({ id: req.id, result: { summaries, skipped: parsed.skipped, best: pickBestSeries(summaries)?.id ?? null } });
    } else if (req.type === 'build') {
      const groups = req.seriesIds.map((id) => {
        const items = series.get(id);
        if (!items) throw new Error('Série não encontrada.');
        return { id, items };
      });
      progress(req.id, `Decodificando ${groups.reduce((n, g) => n + g.items.length, 0)} imagem(ns)…`);
      const built = groups.map((g) => buildVolume(g.id, g.items));
      current = built[0];
      if (built.length > 1) {
        progress(req.id, `Fundindo ${built.length} séries…`);
        const fused = fuseVolumes(
          built.map((b) => b.volume),
          req.maxVoxels ?? 16e6,
        );
        const eff = req.effective ?? ([1, 1, 1] as Vec3);
        current = {
          ...built[0],
          volume: fused.volume,
          quality: assessFusedQuality(built[0].quality, eff, req.effectiveGap ?? Math.max(...eff), built.length, fused.volume.spacing[0]),
          fusion: { seriesIds: req.seriesIds, descriptions: built.map((b) => b.series.description), notes: fused.notes },
        };
      }
      lastRecon = null;
      // cópia para a thread principal; o worker mantém a original para as reconstruções
      const copy = { ...current, volume: { ...current.volume, data: current.volume.data.slice() } };
      ctx.postMessage({ id: req.id, result: copy }, [copy.volume.data.buffer]);
    } else if (req.type === 'recon') {
      if (!current) throw new Error('Nenhum volume carregado.');
      progress(req.id, 'Interpolando cortes e preparando o volume…');
      const rec = reconstruct(current.volume, req.options, req.maxVoxels);
      progress(req.id, 'Gerando a superfície óssea…');
      const mesh = extractSurface(rec.surfaceField, req.smoothIterations);
      lastRecon = { rec, threshold: req.options.threshold };
      // o worker guarda a reconstrução (para a segmentação) e envia uma cópia
      const intensity = { ...rec.intensity, data: rec.intensity.data.slice() };
      ctx.postMessage(
        { id: req.id, result: { intensity, notes: rec.notes, mesh } },
        [intensity.data.buffer, mesh.points.buffer, mesh.normals.buffer, mesh.triangles.buffer],
      );
    } else if (req.type === 'segment') {
      if (!lastRecon) throw new Error('Reconstrua o 3D antes de segmentar.');
      progress(req.id, 'Separando dentes, mandíbula e crânio…');
      const seg = segmentBone(lastRecon.rec, lastRecon.threshold, req.calibratedHU);
      const meshes = [];
      for (const f of seg.fields) {
        progress(req.id, `Gerando superfície: ${f.key === 'cranio' ? 'crânio/maxila' : f.key === 'mandibula' ? 'mandíbula' : 'dentes'}…`);
        meshes.push({ key: f.key, mesh: extractSurface({ ...lastRecon.rec.surfaceField, data: f.data }, req.smoothIterations) });
      }
      const transfer = meshes.flatMap((m) => [m.mesh.points.buffer, m.mesh.normals.buffer, m.mesh.triangles.buffer]);
      ctx.postMessage({ id: req.id, result: { meshes, notes: seg.notes, stats: seg.stats } }, transfer);
    }
  } catch (e) {
    ctx.postMessage({ id: req.id, error: e instanceof Error ? e.message : String(e) });
  }
};
