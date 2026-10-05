/// <reference lib="webworker" />
import { buildVolume, parseFiles, pickBestSeries, summarizeSeries, type InputFile, type ParsedImage } from './core/dicom';
import { fuseVolumes } from './core/fusion';
import { extractSurface, type Mesh } from './core/mesh';
import { detectMetal, enamelNear, type MetalObject } from './core/metal';
import { assessFusedQuality } from './core/quality';
import { keepLargeComponents } from './core/components';
import { reconstruct } from './core/resample';
import { labelField, splitByPlane, splitBySeed } from './core/segedit';
import { segmentBone } from './core/segment';
import { segmentAirways, segmentVessels, type Region } from './core/softseg';
import { examFindings } from './core/findings';
import type { BuiltVolume, ReconOptions, ReconResult, Vec3 } from './core/types';

export type WorkerRequest =
  | { id: number; type: 'parse'; files: InputFile[] }
  | { id: number; type: 'build'; seriesIds: string[]; effective?: Vec3; effectiveGap?: number; maxVoxels?: number }
  | { id: number; type: 'recon'; options: ReconOptions; maxVoxels: number; smoothIterations: number; calibratedHU: boolean }
  | { id: number; type: 'segment'; calibratedHU: boolean; smoothIterations: number; contrast: boolean }
  | { id: number; type: 'analyze'; calibratedHU: boolean; contrast: boolean }
  | {
      id: number;
      type: 'split';
      mode: 'seed' | 'plane';
      point: Vec3;
      planeOrigin?: Vec3;
      planeNormal?: Vec3;
      name: string;
      smoothIterations: number;
    };

type Base = 'bone' | 'teeth' | 'metal' | 'air' | 'vessel';

export interface LayerOut {
  id: number;
  name: string;
  base: Base;
  mesh: Mesh;
  volumeMm3: number;
}

let series = new Map<string, ParsedImage[]>();
let current: BuiltVolume | null = null;
let lastRecon: {
  rec: ReconResult;
  threshold: number;
  metalMask: Uint8Array | null;
  metalBase: Float32Array | null;
} | null = null;
let seg: {
  labels: Uint8Array;
  meta: Map<number, { name: string; base: Base }>;
  teethBase: Float32Array;
  extraBase: Map<Base, Float32Array>;
  nextId: number;
} | null = null;

/** segmentação automática da reconstrução atual (reaproveitada pela leitura do exame) */
let auto: {
  labels: Uint8Array;
  teethLow: number;
  notes: string[];
  air: Region[];
  airCount: number;
  vessels: Region[] | null;
  vesselCount: number;
  metal: MetalObject[];
} | null = null;
let lastMetal: MetalObject[] = [];

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function autoSegment(id: number, calibratedHU: boolean, contrast: boolean) {
  if (auto) return auto;
  if (!lastRecon) throw new Error('Reconstrua o 3D primeiro.');
  progress(id, 'Separando dentes, mandíbula, metal e crânio…');
  const result = segmentBone(lastRecon.rec, lastRecon.threshold, calibratedHU, lastRecon.metalMask ?? undefined);
  const labels = result.labels;
  progress(id, 'Separando seios paranasais e vias aéreas…');
  const air = segmentAirways(lastRecon.rec.intensity);
  let airCount = 0;
  for (let i = 0; i < labels.length; i++)
    if (air.mask[i] && !labels[i]) {
      labels[i] = 5;
      airCount++;
    }
  let vessels: Region[] | null = null;
  let vesselCount = 0;
  if (contrast) {
    progress(id, 'Procurando vasos realçados pelo contraste…');
    const v = segmentVessels(lastRecon.rec.intensity);
    vessels = v.regions;
    for (let i = 0; i < labels.length; i++)
      if (v.mask[i] && !labels[i]) {
        labels[i] = 6;
        vesselCount++;
      }
  }
  auto = { labels, teethLow: result.teethLow, notes: result.notes, air: air.regions, airCount, vessels, vesselCount, metal: lastMetal };
  return auto;
}
const progress = (id: number, message: string) => ctx.postMessage({ id, progress: message });

function baseField(base: Base): Float32Array {
  if (!lastRecon) throw new Error('Reconstrua o 3D primeiro.');
  if (base === 'metal' && lastRecon.metalBase) return lastRecon.metalBase;
  if (base === 'teeth' && seg) return seg.teethBase;
  const extra = seg?.extraBase.get(base);
  if (extra) return extra;
  return lastRecon.rec.surfaceField.data;
}

function layerOut(id: number, smoothIterations: number): LayerOut {
  const meta = seg!.meta.get(id)!;
  const field = labelField(seg!.labels, id, baseField(meta.base));
  const mesh = extractSurface({ ...lastRecon!.rec.surfaceField, data: field }, meta.base === 'metal' || meta.base === 'vessel' ? 6 : smoothIterations);
  let count = 0;
  for (const l of seg!.labels) if (l === id) count++;
  const sp = lastRecon!.rec.intensity.spacing;
  return { id, name: meta.name, base: meta.base, mesh, volumeMm3: count * sp[0] * sp[1] * sp[2] };
}

function transferOf(layers: LayerOut[]) {
  return layers.flatMap((l) => [l.mesh.points.buffer, l.mesh.normals.buffer, l.mesh.triangles.buffer]);
}

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
      seg = null;
      auto = null;
      // cópia para a thread principal; o worker mantém a original para as reconstruções
      const copy = { ...current, volume: { ...current.volume, data: current.volume.data.slice() } };
      ctx.postMessage({ id: req.id, result: copy }, [copy.volume.data.buffer]);
    } else if (req.type === 'recon') {
      if (!current) throw new Error('Nenhum volume carregado.');
      progress(req.id, 'Interpolando cortes e preparando o volume…');
      const rec = reconstruct(current.volume, req.options, req.maxVoxels);
      const hu = rec.intensity.data;
      const field = rec.surfaceField.data;
      const T = req.options.threshold;

      progress(req.id, 'Procurando material metálico (placas, parafusos, restaurações)…');
      const near = enamelNear(rec.intensity, 3000, req.calibratedHU);
      const metal = detectMetal(rec.intensity, req.calibratedHU, near);
      let metalBase: Float32Array | null = null;
      let metalMesh: Mesh | null = null;
      const notes = [...rec.notes];
      if (metal.objects.length) {
        // o osso não cobre o metal, e o "falso osso" dos artefatos em volta é cortado
        const [nx, ny] = rec.intensity.dims;
        const plane = nx * ny;
        const n = hu.length;
        const radius = Math.max(1, Math.round(4 / Math.min(...rec.intensity.spacing)));
        const dist = new Uint8Array(n).fill(255);
        let frontier: number[] = [];
        for (let i = 0; i < n; i++)
          if (metal.mask[i]) {
            dist[i] = 0;
            frontier.push(i);
          }
        for (let s = 1; s <= radius && frontier.length; s++) {
          const next: number[] = [];
          for (const i of frontier)
            for (const d of [1, -1, nx, -nx, plane, -plane]) {
              const j = i + d;
              if (j < 0 || j >= n || dist[j] !== 255) continue;
              dist[j] = s;
              next.push(j);
            }
          frontier = next;
        }
        let cleared = 0;
        for (let i = 0; i < n; i++) {
          if (dist[i] <= 1 || (dist[i] !== 255 && hu[i] < T + 250 && field[i] > 0)) {
            if (field[i] > 0 && dist[i] > 1) cleared++;
            field[i] = Math.min(field[i], -0.05);
          }
        }
        if (req.options.removeSmallParts) keepLargeComponents(field, rec.intensity.dims, rec.intensity.spacing);
        metalBase = new Float32Array(n);
        for (let i = 0; i < n; i++) metalBase[i] = metal.mask[i] ? Math.max(0.05, hu[i] - metal.lowThreshold + 1) : Math.min(-0.05, hu[i] - metal.lowThreshold);
        metalMesh = extractSurface({ ...rec.surfaceField, data: metalBase }, 4);
        const counts = { parafuso: 0, placa: 0, restauracao: 0, fragmento: 0 };
        for (const o of metal.objects) counts[o.kind]++;
        notes.push(
          `Metal identificado: ${metal.objects.length} peça(s) — ${counts.parafuso} parafuso(s)/pino(s), ${counts.placa} placa(s), ${counts.restauracao} restauração(ões), ${counts.fragmento} outra(s). Exibido em dourado, separado do osso.`,
        );
        if (cleared) notes.push('Artefatos de irradiação do metal reduzidos: perto das peças, só osso denso entra no modelo.');
      }
      progress(req.id, 'Gerando a superfície óssea…');
      const mesh = extractSurface(rec.surfaceField, req.smoothIterations);
      lastRecon = { rec, threshold: T, metalMask: metal.objects.length ? metal.mask : null, metalBase };
      lastMetal = metal.objects;
      seg = null;
      auto = null;
      // o worker guarda a reconstrução (para a segmentação) e envia uma cópia
      const intensity = { ...rec.intensity, data: rec.intensity.data.slice() };
      const transfer: Transferable[] = [intensity.data.buffer, mesh.points.buffer, mesh.normals.buffer, mesh.triangles.buffer];
      if (metalMesh) transfer.push(metalMesh.points.buffer, metalMesh.normals.buffer, metalMesh.triangles.buffer);
      const metalOut: { mesh: Mesh; objects: MetalObject[]; seed: number; low: number } | null = metalMesh
        ? { mesh: metalMesh, objects: metal.objects, seed: metal.seedThreshold, low: metal.lowThreshold }
        : null;
      ctx.postMessage({ id: req.id, result: { intensity, notes, mesh, metal: metalOut } }, transfer);
    } else if (req.type === 'segment') {
      if (!lastRecon) throw new Error('Reconstrua o 3D antes de segmentar.');
      const a = autoSegment(req.id, req.calibratedHU, req.contrast);
      const hu = lastRecon.rec.intensity.data;
      const teethBase = new Float32Array(hu.length);
      for (let i = 0; i < hu.length; i++) teethBase[i] = hu[i] - a.teethLow + 1;
      seg = {
        labels: a.labels.slice(),
        teethBase,
        extraBase: new Map(),
        nextId: 10,
        meta: new Map([
          [1, { name: 'Crânio e face', base: 'bone' as Base }],
          [2, { name: 'Mandíbula', base: 'bone' as Base }],
          [3, { name: 'Dentes', base: 'teeth' as Base }],
          [4, { name: 'Metal (placas, parafusos, restaurações)', base: 'metal' as Base }],
          [5, { name: 'Seios e vias aéreas', base: 'air' as Base }],
          [6, { name: 'Vasos (contraste)', base: 'vessel' as Base }],
        ]),
      };
      const notes = [...a.notes];
      const describe = (r: Region[], max: number) =>
        r
          .slice(0, max)
          .map((x) => `${(x.volume / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} cm³ (${x.location})`)
          .join('; ');
      if (a.airCount) {
        const airBase = new Float32Array(hu.length);
        for (let i = 0; i < hu.length; i++) airBase[i] = -400 - hu[i];
        seg.extraBase.set('air', airBase);
        notes.push(`Espaços aéreos (seios, cavidade nasal, faringe): ${describe(a.air, 6)}. Use "Separar por toque" para nomear cada seio.`);
      }
      if (a.vessels) {
        if (a.vesselCount) {
          const vBase = new Float32Array(hu.length);
          for (let i = 0; i < hu.length; i++) vBase[i] = hu[i] - 150;
          seg.extraBase.set('vessel', vBase);
          notes.push(
            `Vasos com contraste: ${a.vessels.length} grupo(s), maiores: ${describe(a.vessels, 4)}. Aproximado: mucosa e glândulas muito realçadas podem entrar; artérias e veias não são diferenciadas.`,
          );
        } else notes.push('Exame marcado com contraste, mas nenhum vaso realçado foi encontrado fora do osso.');
      } else {
        notes.push('Vasos não segmentados: o exame não tem contraste identificado (sem contraste, sangue e músculo têm a mesma densidade).');
      }

      const layers: LayerOut[] = [];
      const present = new Set<number>();
      for (const l of seg.labels) present.add(l);
      for (const id of [1, 2, 3, 4, 5, 6]) {
        if (!present.has(id)) continue;
        progress(req.id, `Gerando superfície: ${seg.meta.get(id)!.name}…`);
        layers.push(layerOut(id, req.smoothIterations));
      }
      ctx.postMessage({ id: req.id, result: { layers, notes } }, transferOf(layers));
    } else if (req.type === 'analyze') {
      if (!lastRecon) throw new Error('Reconstrua o 3D antes da leitura do exame.');
      const a = autoSegment(req.id, req.calibratedHU, req.contrast);
      progress(req.id, 'Lendo o exame: simetria, continuidade, áreas hipodensas, metal e seios…');
      const f = examFindings({
        vol: lastRecon.rec.intensity,
        labels: a.labels,
        metal: a.metal,
        air: a.air,
        vessels: a.vessels,
        threshold: lastRecon.threshold,
        calibratedHU: req.calibratedHU,
      });
      ctx.postMessage({ id: req.id, result: { text: f.text } });
    } else if (req.type === 'split') {
      if (!lastRecon || !seg) throw new Error('Segmente as estruturas primeiro.');
      const g = lastRecon.rec.intensity;
      const newId = seg.nextId;
      if (newId > 250) throw new Error('Limite de estruturas atingido.');
      progress(req.id, req.mode === 'seed' ? 'Separando a estrutura tocada…' : 'Cortando pelo plano…');
      const r =
        req.mode === 'seed'
          ? splitBySeed(seg.labels, g, req.point, newId)
          : splitByPlane(seg.labels, g, req.point, req.planeOrigin!, req.planeNormal!, newId);
      if (!r.ok) {
        ctx.postMessage({ id: req.id, result: { ok: false, message: r.message, layers: [] } });
        return;
      }
      seg.nextId++;
      seg.meta.set(newId, { name: req.name, base: seg.meta.get(r.from)!.base });
      progress(req.id, 'Atualizando as superfícies…');
      const layers = [layerOut(r.from, req.smoothIterations), layerOut(newId, req.smoothIterations)];
      ctx.postMessage({ id: req.id, result: { ok: true, message: r.message, layers } }, transferOf(layers));
    }
  } catch (e) {
    ctx.postMessage({ id: req.id, error: e instanceof Error ? e.message : String(e) });
  }
};
