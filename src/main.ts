import './style.css';
import { fmt } from './core/math';
import { meshToStl, type Mesh } from './core/mesh';
import { isCbctVendor } from './core/quality';
import { suggestThreshold } from './core/threshold';
import type { BuiltVolume, InterpolationMethod, ReconOptions, SeriesSummary } from './core/types';
import { ProcessingClient } from './ui/client';
import { EnhancePanel } from './ui/enhance-ui';
import { MprState, MprView, type Tool } from './ui/mpr';
import { dataUrlToBlob, saveFile } from './ui/save';
import type { CameraView, ClipAxis, RenderMode, View3D, VolumePreset } from './ui/view3d';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)];

const client = new ProcessingClient();
let built: BuiltVolume | null = null;
let mprState: MprState | null = null;
let views: MprView[] = [];
let view3d: View3D | null = null;
let lastMesh: Mesh | null = null;
let currentSeries: string | null = null;
let reconToken = 0;
let renderMode: RenderMode = 'superficie';

// ---------- abas ----------
function showTab(name: string) {
  $$('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  $$('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== name));
  if (name === 'cortes') views.forEach((v) => v.draw());
  if (name === 'tresd') view3d?.render();
}
$$('[data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab!)));

// ---------- status ----------
function status(msg: string | null, error = false) {
  const el = $('#status');
  el.hidden = !msg;
  el.textContent = msg ?? '';
  el.classList.toggle('error', error);
}

// ---------- abrir arquivos ----------
async function readFiles(list: FileList | File[]) {
  const files = [...list].filter((f) => !/\.(txt|xml|html?|pdf|exe|ini|inf|jpe?g|png|db)$/i.test(f.name) && f.name !== 'DICOMDIR');
  if (!files.length) return status('Nenhum arquivo compatível selecionado.', true);
  status(`Carregando ${files.length} arquivo(s)…`);
  try {
    const inputs = await Promise.all(files.map(async (f) => ({ name: f.webkitRelativePath || f.name, buffer: await f.arrayBuffer() })));
    const res = await client.parse(inputs, (m) => status(m));
    renderSeries(res.summaries);
    $('#skipped').textContent = res.skipped.length
      ? `${res.skipped.length} arquivo(s) ignorado(s): ${res.skipped[0].name} — ${res.skipped[0].reason}${res.skipped.length > 1 ? '…' : ''}`
      : '';
    if (!res.summaries.length) return status('Nenhuma imagem DICOM encontrada nestes arquivos.', true);
    if (res.best) await loadSeries(res.best);
  } catch (e) {
    status(`Erro ao ler os arquivos: ${(e as Error).message}`, true);
  }
}

$('#file-input').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  if (input.files?.length) readFiles(input.files);
  input.value = '';
});
$('#dir-input').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  if (input.files?.length) readFiles(input.files);
  input.value = '';
});
const drop = $('#drop');
['dragenter', 'dragover'].forEach((t) =>
  document.addEventListener(t, (e) => {
    if ($('#tab-imagem').hidden) {
      e.preventDefault();
      drop.classList.add('over');
    }
  }),
);
document.addEventListener('dragleave', () => drop.classList.remove('over'));
document.addEventListener('drop', async (e) => {
  if (!$('#tab-imagem').hidden) return;
  e.preventDefault();
  drop.classList.remove('over');
  const items = e.dataTransfer?.items;
  if (items && items.length && 'webkitGetAsEntry' in DataTransferItem.prototype) {
    const files = await collectEntries([...items].map((i) => i.webkitGetAsEntry()).filter((x): x is FileSystemEntry => !!x));
    if (files.length) return readFiles(files);
  }
  if (e.dataTransfer?.files.length) readFiles(e.dataTransfer.files);
});

/** Lê pastas arrastadas recursivamente. */
async function collectEntries(entries: FileSystemEntry[]): Promise<File[]> {
  const out: File[] = [];
  for (const entry of entries) {
    if (entry.isFile) {
      out.push(await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej)));
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      let batch: FileSystemEntry[];
      do {
        batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        out.push(...(await collectEntries(batch)));
      } while (batch.length);
    }
  }
  return out;
}

// ---------- séries ----------
function renderSeries(summaries: SeriesSummary[]) {
  const list = $('#series-list');
  list.innerHTML = '';
  $('#series-card').hidden = !summaries.length;
  const sorted = [...summaries].sort((a, b) => (a.seriesNumber ?? 0) - (b.seriesNumber ?? 0));
  for (const s of sorted) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.dataset.series = s.id;
    const canvas = document.createElement('canvas');
    if (s.thumbnail) {
      canvas.width = s.thumbnail.width;
      canvas.height = s.thumbnail.height;
      canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(s.thumbnail.pixels), s.thumbnail.width, s.thumbnail.height), 0, 0);
    }
    const spacing = s.estimatedSpacing ?? s.sliceThickness;
    const info = document.createElement('div');
    info.innerHTML = `<strong></strong><small></small>`;
    info.querySelector('strong')!.textContent = s.description;
    info.querySelector('small')!.textContent = `${s.modality} · ${s.frameCount} imagem(ns)${spacing ? ` · ${fmt(spacing)} mm` : ''}`;
    btn.append(canvas, info);
    btn.addEventListener('click', () => loadSeries(s.id));
    li.append(btn);
    list.append(li);
  }
}

async function loadSeries(id: string) {
  currentSeries = id;
  $$('#series-list button').forEach((b) => b.classList.toggle('on', b.dataset.series === id));
  status('Montando o volume…');
  try {
    built = await client.build(id, (m) => status(m));
  } catch (e) {
    status(`Não foi possível montar esta série: ${(e as Error).message}`, true);
    return;
  }
  if (currentSeries !== id) return;
  status(null);
  document.body.classList.add('has-volume');
  showQuality(built);
  showStudy(built);
  setupMpr(built);
  setupReconDefaults(built);
  runRecon();
}

function showQuality(b: BuiltVolume) {
  const q = b.quality;
  $('#quality-card').hidden = false;
  const badge = $('#quality-badge');
  badge.className = `badge ${q.level}`;
  badge.textContent = q.level;
  $('#quality-facts').innerHTML = '';
  for (const f of q.facts) {
    const dt = document.createElement('dt');
    dt.textContent = f.label;
    const dd = document.createElement('dd');
    dd.textContent = f.value;
    $('#quality-facts').append(dt, dd);
  }
  const ul = $('#quality-warnings');
  ul.innerHTML = '';
  for (const w of q.warnings) {
    const li = document.createElement('li');
    li.textContent = w;
    ul.append(li);
  }
  const disc = $('#recon-disclaimer');
  disc.hidden = false;
  disc.className = `disclaimer ${q.level}`;
  disc.innerHTML = '<strong></strong><span></span>';
  disc.querySelector('strong')!.textContent =
    q.level === 'boa' ? 'Dados de boa qualidade para 3D' : q.level === 'moderada' ? 'Dados com qualidade moderada para 3D' : 'Atenção: dados limitados para 3D';
  disc.querySelector('span')!.textContent = q.disclaimer;
}

function patientHidden() {
  return $<HTMLInputElement>('#hide-patient').checked;
}

function showStudy(b: BuiltVolume) {
  $('#study-card').hidden = false;
  const s = b.study;
  const hide = patientHidden();
  const rows: [string, string][] = [
    ['Nome', hide ? '•••' : s.patientName || '—'],
    ['ID', hide ? '•••' : s.patientId || '—'],
    ['Data', s.studyDate || '—'],
    ['Aparelho', [s.manufacturer, s.model].filter(Boolean).join(' ') || '—'],
    ['Série', b.series.description],
    ['kVp', s.kvp || '—'],
  ];
  const dl = $('#study-info');
  dl.innerHTML = '';
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dl.append(dt, dd);
  }
  for (const v of views) {
    v.hidePatient = hide;
    v.patientLine = s.patientName;
    v.draw();
  }
}
$('#hide-patient').addEventListener('change', () => built && showStudy(built));

// ---------- cortes ----------
function setupMpr(b: BuiltVolume) {
  const grid = $('#mpr-grid');
  grid.innerHTML = '<div id="view-axial"></div><div id="view-coronal"></div><div id="view-sagittal"></div>';
  mprState = new MprState(b.volume);
  mprState.window = b.window && b.window.width > 1000 ? { ...b.window } : { center: 500, width: 2500 };
  mprState.tool = ($('#tools .on') as HTMLElement | null)?.dataset.tool as Tool ?? 'navegar';
  views = (['axial', 'coronal', 'sagittal'] as const).map((p) => new MprView($(`#view-${p}`), p, mprState!));
  views[0].setFocus();
  showStudy(b);
}

$$('#tools button').forEach((btn) =>
  btn.addEventListener('click', () => {
    $$('#tools button').forEach((b) => b.classList.toggle('on', b === btn));
    if (mprState) mprState.tool = btn.dataset.tool as Tool;
  }),
);
$$('#presets button').forEach((btn) =>
  btn.addEventListener('click', () => {
    if (!mprState) return;
    const [c, w] = btn.dataset.wl!.split(',').map(Number);
    mprState.window = { center: c, width: w };
    mprState.emit();
  }),
);
$('#clear-annot').addEventListener('click', () => views.forEach((v) => v.clearAnnotations()));
$('#layout-toggle').addEventListener('click', () => {
  $('#mpr-grid').classList.toggle('single');
  views.forEach((v) => v.draw());
});
$('#mpr-grid').addEventListener('dblclick', (e) => {
  const view = views.find((v) => v.canvas === e.target);
  if (!view) return;
  view.setFocus();
  $('#mpr-grid').classList.toggle('single');
  views.forEach((v) => v.draw());
});
$('#mpr-grid').addEventListener('pointerdown', (e) => views.find((v) => v.canvas === e.target)?.setFocus());

// ---------- 3D ----------
const thresholdInput = $<HTMLInputElement>('#threshold');
const smoothingInput = $<HTMLInputElement>('#smoothing');
const reconBtn = $<HTMLButtonElement>('#recon-btn');

function updateOutputs() {
  $('#thr-out').textContent = `${thresholdInput.value} HU`;
  $('#smooth-out').textContent = Number(smoothingInput.value) ? `${fmt(Number(smoothingInput.value), 1)} mm` : 'desligada';
}
updateOutputs();

function isLikelyPhone() {
  return matchMedia('(max-width: 900px)').matches || (navigator.hardwareConcurrency ?? 8) <= 4;
}
if (isLikelyPhone()) $<HTMLSelectElement>('#detail').value = '6000000';

function setupReconDefaults(b: BuiltVolume) {
  const cbct = isCbctVendor(b.study.manufacturer);
  const t = suggestThreshold(b.volume, cbct);
  thresholdInput.min = String(Math.min(-200, t - 500));
  thresholdInput.max = String(Math.max(1500, t + 1500));
  thresholdInput.value = String(t);
  smoothingInput.value = b.volume.spacing[2] > 3 ? '0.8' : b.volume.spacing[2] > 1.25 ? '0.5' : '0.3';
  updateOutputs();
  reconBtn.disabled = false;
}

function reconOptions(b: BuiltVolume): ReconOptions {
  const [sx, , sz] = b.volume.spacing;
  const choice = $<HTMLSelectElement>('#interp').value;
  const interpolation: InterpolationMethod = choice === 'auto' ? (sz > 2 ? 'shape' : 'cubic') : (choice as InterpolationMethod);
  return {
    threshold: Number(thresholdInput.value),
    targetSpacing: sz <= 1 ? sz : Math.max(0.5, Math.min(1, sx * 2)),
    interpolation,
    smoothing: Number(smoothingInput.value),
    removeSmallParts: $<HTMLInputElement>('#remove-parts').checked,
  };
}

async function ensureView3d() {
  if (!view3d) {
    const { View3D } = await import('./ui/view3d');
    view3d = new View3D($('#view3d'));
    view3d.setMode(renderMode);
  }
  return view3d;
}

async function runRecon() {
  if (!built) return;
  const token = ++reconToken;
  const busy = $('#busy3d');
  busy.hidden = false;
  reconBtn.disabled = true;
  reconBtn.textContent = 'Reconstruir 3D';
  const opts = reconOptions(built);
  try {
    const res = await client.recon(opts, Number($<HTMLSelectElement>('#detail').value), opts.smoothing > 0 ? 15 : 0, (m) => {
      busy.querySelector('span')!.textContent = m;
    });
    if (token !== reconToken) return;
    busy.querySelector('span')!.textContent = 'Desenhando…';
    const v = await ensureView3d();
    v.setVolume(res.intensity, opts.threshold);
    v.setMesh(res.mesh);
    lastMesh = res.mesh;
    v.setCamera($<HTMLSelectElement>('#camera-view').value as CameraView);
    $('#view3d-empty').hidden = true;
    $<HTMLButtonElement>('#export-stl').disabled = !res.mesh.triangles.length;
    $<HTMLButtonElement>('#export-png').disabled = false;
    const notes = $('#recon-notes');
    notes.innerHTML = '';
    const items = [
      ...res.notes,
      `Limiar ${opts.threshold} HU · superfície com ${res.mesh.triangles.length / 3 > 0 ? (res.mesh.triangles.length / 3).toLocaleString('pt-BR') : 0} triângulos.`,
    ];
    if (!res.mesh.triangles.length) items.unshift('Nenhuma superfície encontrada com este limiar. Tente um valor menor.');
    for (const n of items) {
      const li = document.createElement('li');
      li.textContent = n;
      notes.append(li);
    }
  } catch (e) {
    $('#recon-notes').innerHTML = '';
    const li = document.createElement('li');
    li.textContent = `Falha na reconstrução: ${(e as Error).message}`;
    $('#recon-notes').append(li);
  } finally {
    if (token === reconToken) {
      busy.hidden = true;
      reconBtn.disabled = false;
    }
  }
}

reconBtn.addEventListener('click', runRecon);
const markDirty = () => {
  if (!built) return;
  reconBtn.textContent = 'Aplicar e reconstruir';
};
thresholdInput.addEventListener('input', () => {
  updateOutputs();
  view3d?.setThreshold(Number(thresholdInput.value));
  markDirty();
});
smoothingInput.addEventListener('input', () => {
  updateOutputs();
  markDirty();
});
['#interp', '#detail', '#remove-parts'].forEach((s) => $(s).addEventListener('change', markDirty));

$$('[data-mode]').forEach((btn) =>
  btn.addEventListener('click', () => {
    renderMode = btn.dataset.mode as RenderMode;
    $$('[data-mode]').forEach((b) => b.classList.toggle('on', b === btn));
    $('#vr-presets').hidden = renderMode !== 'volume';
    view3d?.setMode(renderMode);
  }),
);
$$('[data-preset]').forEach((btn) =>
  btn.addEventListener('click', () => {
    $$('[data-preset]').forEach((b) => b.classList.toggle('on', b === btn));
    view3d?.setPreset(btn.dataset.preset as VolumePreset);
  }),
);
$('#camera-view').addEventListener('change', (e) => view3d?.setCamera((e.target as HTMLSelectElement).value as CameraView));

const clipAxis = $<HTMLSelectElement>('#clip-axis');
const clipPos = $<HTMLInputElement>('#clip-pos');
const clipFlip = $<HTMLInputElement>('#clip-flip');
const applyClip = () => {
  const axis = clipAxis.value as ClipAxis;
  clipPos.disabled = clipFlip.disabled = axis === 'nenhum';
  view3d?.setClip(axis, Number(clipPos.value) / 100, clipFlip.checked);
};
clipAxis.addEventListener('change', applyClip);
clipPos.addEventListener('input', applyClip);
clipFlip.addEventListener('change', applyClip);

function baseName() {
  const s = built?.study;
  const who = s && !patientHidden() && s.patientName ? s.patientName.replace(/\s+/g, '_') + '-' : '';
  return `${who}reconstrucao-ossea`;
}

function reportSave(err: string | null) {
  if (!err) return;
  const li = document.createElement('li');
  li.textContent = err;
  $('#recon-notes').prepend(li);
}

$('#export-stl').addEventListener('click', async () => {
  if (!lastMesh) return;
  reportSave(await saveFile(`${baseName()}.stl`, new Blob([meshToStl(lastMesh)], { type: 'model/stl' })));
});
$('#export-png').addEventListener('click', async () => {
  if (!view3d) return;
  reportSave(await saveFile(`${baseName()}.png`, await dataUrlToBlob(await view3d.snapshot())));
});

// ---------- imagem 2D ----------
new EnhancePanel($('#tab-imagem'));
