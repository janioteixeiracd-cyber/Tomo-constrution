import './style.css';
import { fmt } from './core/math';
import { meshToStl, type Mesh } from './core/mesh';
import { isCbctVendor } from './core/quality';
import { suggestThreshold } from './core/threshold';
import type { BuiltVolume, InterpolationMethod, ReconOptions, SeriesSummary, Vec3 } from './core/types';
import { ProcessingClient, type LayerOut, type ReconResponse } from './ui/client';
import { EnhancePanel } from './ui/enhance-ui';
import { MprState, MprView, type Tool } from './ui/mpr';
import { dataUrlToBlob, saveFile } from './ui/save';
import type { CameraView, ClipAxis, Measurement, MeasureTool, RenderMode, SurfaceLayer, View3D } from './ui/view3d';
import { defaultTissues, sampleTransfer, TISSUE_PRESETS, type TissueClass } from './ui/tissues';
import { PanoPanel } from './ui/pano-ui';
import { planReconstruction, type ReconPlan } from './core/plan';
import { canvasToJpeg, claudeHostSample, describeCase, describeError, type CaseImage } from './ui/ai';

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
let segLayers: SurfaceLayer[] | null = null;
let plan: ReconPlan | null = null;
let summariesById = new Map<string, SeriesSummary>();
const pano = new PanoPanel($('#tab-pano'));
const canalPoints: Record<string, Vec3[]> = {};
pano.onCanalChange = async (side, points) => {
  canalPoints[side] = points;
  if (!view3d && !points.length) return;
  (await ensureView3d()).setCanal(`canal-${side}`, points, side === 'direito' ? [1, 0.3, 0.43] : [1, 0.62, 0.11]);
};

// ---------- abas ----------
function showTab(name: string) {
  $$('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  $$('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== name));
  if (name === 'cortes') views.forEach((v) => v.draw());
  if (name === 'tresd') view3d?.render();
  if (name === 'pano') pano.redraw();
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
    summariesById = new Map(res.summaries.map((x) => [x.id, x]));
    plan = planReconstruction(res.summaries);
    renderPlan();
    if (plan) await loadPlanned();
    else if (res.best) await loadSeries([res.best]);
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
    btn.addEventListener('click', () => loadSeries([s.id]));
    li.append(btn);
    list.append(li);
  }
}

/** Monta o volume conforme o plano (série única ou fusão, se o usuário mantiver a opção). */
function loadPlanned() {
  if (!plan) return Promise.resolve();
  const fuse = plan.strategy === 'fusion' && $<HTMLInputElement>('#plan-fusion').checked;
  return loadSeries(fuse ? plan.usedIds : [plan.primaryId], fuse);
}

async function loadSeries(ids: string[], fused = false) {
  const key = ids.join('+');
  currentSeries = key;
  $$('#series-list button').forEach((b) => b.classList.toggle('on', ids.includes(b.dataset.series!)));
  status(fused ? `Fundindo ${ids.length} séries…` : 'Montando o volume…');
  try {
    built = await client.build(ids, (m) => status(m), {
      effective: fused && plan ? plan.effective : undefined,
      effectiveGap: fused && plan ? plan.effectiveGap : undefined,
      maxVoxels: Number($<HTMLSelectElement>('#detail').value),
    });
  } catch (e) {
    status(`Não foi possível montar o volume: ${(e as Error).message}`, true);
    return;
  }
  if (currentSeries !== key) return;
  status(null);
  document.body.classList.add('has-volume');
  showQuality(built);
  showStudy(built);
  setupMpr(built);
  pano.setVolume(built.volume);
  setupReconDefaults(built);
  tissues = [];
  enableAi();
  runRecon();
}

const ROLE_NAMES = { principal: 'principal', complementar: 'complementar', ignorada: 'não usada' } as const;

function renderPlan() {
  const card = $('#plan-card');
  card.hidden = !plan;
  if (!plan) return;
  $('#plan-strategy').textContent =
    plan.strategy === 'fusion'
      ? `Fusão de ${plan.usedIds.length} séries complementares`
      : `Série única: ${summariesById.get(plan.primaryId)?.description ?? ''}`;
  const list = (sel: string, items: string[]) => {
    const ul = $(sel);
    ul.innerHTML = '';
    for (const t of items) {
      const li = document.createElement('li');
      li.textContent = t;
      ul.append(li);
    }
  };
  list('#plan-rationale', [
    ...plan.rationale,
    `Melhor resolução disponível: ${plan.effective.map((v) => fmt(v)).join(' / ')} mm (L-R / A-P / S-I).`,
  ]);
  $('#plan-fusion-box').hidden = plan.strategy !== 'fusion';
  const roles = $('#plan-roles');
  roles.innerHTML = '';
  const order = { principal: 0, complementar: 1, ignorada: 2 };
  for (const r of [...plan.roles].sort((a, b) => order[a.role] - order[b.role])) {
    const li = document.createElement('li');
    const badge = document.createElement('span');
    badge.className = `role ${r.role}`;
    badge.textContent = ROLE_NAMES[r.role];
    const txt = document.createElement('span');
    txt.textContent = `${r.description} — ${r.reason}`;
    li.append(badge, txt);
    roles.append(li);
  }
}
$('#plan-fusion').addEventListener('change', () => loadPlanned());

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
  $('#metal-toggle').setAttribute('aria-pressed', 'false');
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
else if (((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4) >= 8) $<HTMLSelectElement>('#detail').value = '40000000';

function setupReconDefaults(b: BuiltVolume) {
  const cbct = isCbctVendor(b.study.manufacturer);
  // com contraste, vasos realçados chegam a ~200–400 HU: o limiar do osso sobe para não incluí-los
  const t = b.study.contrast && !cbct ? Math.max(350, suggestThreshold(b.volume, cbct)) : suggestThreshold(b.volume, cbct);
  thresholdInput.min = String(Math.min(-200, t - 500));
  thresholdInput.max = String(Math.max(1500, t + 1500));
  thresholdInput.value = String(t);
  const sz = b.volume.spacing[2];
  smoothingInput.value = b.fusion ? '0.7' : sz > 3 ? '0.8' : sz > 1.25 ? '0.5' : '0.3';
  updateOutputs();
  reconBtn.disabled = false;

  const detail = $<HTMLSelectElement>('#detail');
  const settings = [
    cbct
      ? `Limiar ósseo ${t}: calculado pelo histograma deste exame (CBCT não usa HU calibrado).`
      : b.study.contrast
        ? `Limiar ósseo ${t} HU: exame com contraste, acima da densidade dos vasos realçados para eles não virarem "osso".`
        : `Limiar ósseo ${t} HU: TC calibrada (ar ≈ −1000 HU); separa osso cortical e medular das partes moles.`,
    b.fusion
      ? `Volume fundido em grade de ${fmt(b.volume.spacing[0])} mm; interpolação cúbica e suavização leve (${smoothingInput.value} mm) para unir as séries sem apagar detalhe.`
      : sz > 2
        ? `Cortes de ${fmt(sz)} mm: interpolação baseada em forma (cúbica) e suavização reforçada entre cortes para não formar degraus.`
        : `Cortes de ${fmt(sz)} mm: interpolação cúbica e suavização leve (${smoothingInput.value} mm), preservando detalhe.`,
    'Paredes finas preservadas junto do osso (limiar local calculado a partir das partes moles deste exame).',
    `Qualidade "${detail.selectedOptions[0]?.textContent ?? ''}"${isLikelyPhone() ? ' escolhida para celular; no computador use "Alta" para o máximo de detalhe' : ''}.`,
  ];
  const ul = $('#plan-settings');
  ul.innerHTML = '';
  for (const t2 of settings) {
    const li = document.createElement('li');
    li.textContent = t2;
    ul.append(li);
  }
  $('#plan-card').hidden = false;
  if (!plan) $('#plan-strategy').textContent = `Série escolhida: ${b.series.description}`;
}

function reconOptions(b: BuiltVolume): ReconOptions {
  const [sx, , sz] = b.volume.spacing;
  const choice = $<HTMLSelectElement>('#interp').value;
  const interpolation: InterpolationMethod = choice === 'auto' ? (sz > 2 ? 'shape' : 'cubic') : (choice as InterpolationMethod);
  return {
    threshold: Number(thresholdInput.value),
    // entre cortes espessos não há detalhe real a ganhar: ~1/3,5 do intervalo basta, e a memória
    // economizada vai para a resolução no plano, que é informação verdadeira
    targetSpacing: sz <= 1 ? sz : Math.max(Math.min(1, Math.max(0.5, sx * 2)), Math.min(1.6, sz / 3.5)),
    interpolation,
    smoothing: Number(smoothingInput.value),
    removeSmallParts: $<HTMLInputElement>('#remove-parts').checked,
    preserveThinWalls: $<HTMLInputElement>('#thin-walls').checked,
  };
}

async function ensureView3d() {
  if (!view3d) {
    const { View3D } = await import('./ui/view3d');
    view3d = new View3D($('#view3d'));
    view3d.setMode(renderMode);
    view3d.onMeasurementsChange = renderMeasures;
    view3d.onPick = onPick;
    view3d.onPickMiss = () => {
      if (armedSplit) $('#seg-hint').textContent = 'O toque não acertou nenhuma superfície visível. Toque sobre o osso, do lado que o plano deixa à mostra.';
    };
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
    const iterations = opts.smoothing > 0 ? (built.volume.spacing[2] > 3 ? 30 : 15) : 0;
    const calibrated = !isCbctVendor(built.study.manufacturer);
    const res = await client.recon(opts, Number($<HTMLSelectElement>('#detail').value), iterations, calibrated, (m) => {
      busy.querySelector('span')!.textContent = m;
    });
    if (token !== reconToken) return;
    busy.querySelector('span')!.textContent = 'Desenhando…';
    const v = await ensureView3d();
    v.setVolume(res.intensity, opts.threshold);
    if (!tissues.length) setupTissues(built);
    else applyTissues();
    lastMesh = res.mesh;
    layerVolumes = new Map();
    segLayers = [{ key: 'osso', name: 'Osso', color: COLORS.osso, mesh: res.mesh, visible: true }];
    if (res.metal) segLayers.push({ key: 'metal', name: 'Metal (placas, parafusos, restaurações)', color: COLORS.metal, mesh: res.metal.mesh, visible: true });
    v.setSurfaces(segLayers);
    segmented = false;
    renderLayers();
    renderMetal(res.metal);
    $<HTMLButtonElement>('#segment-btn').disabled = !res.mesh.triangles.length;
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
  const bone = tissues.find((t) => t.key === 'osso');
  if (bone && built) {
    bone.lo = built.study.contrast ? Math.max(Number(thresholdInput.value), 450) : Number(thresholdInput.value);
    applyTissues();
  } else view3d?.setThreshold(Number(thresholdInput.value));
  markDirty();
});
smoothingInput.addEventListener('input', () => {
  updateOutputs();
  markDirty();
});
['#interp', '#detail', '#remove-parts', '#thin-walls'].forEach((s) => $(s).addEventListener('change', markDirty));

$$('[data-mode]').forEach((btn) =>
  btn.addEventListener('click', () => {
    renderMode = btn.dataset.mode as RenderMode;
    $$('[data-mode]').forEach((b) => b.classList.toggle('on', b === btn));
    $('#vr-presets').hidden = renderMode !== 'volume';
    $('#tissue-card').hidden = renderMode !== 'volume' || !tissues.length;
    view3d?.setMode(renderMode);
  }),
);

// ---------- filtro de tecidos (modo Volume) ----------
let tissues: TissueClass[] = [];

function setupTissues(b: BuiltVolume) {
  tissues = defaultTissues(Number(thresholdInput.value), b.study.contrast);
  const cbct = isCbctVendor(b.study.manufacturer);
  $('#tissue-note').textContent =
    (b.study.contrast
      ? 'Exame com contraste: vasos realçados aparecem em vermelho. '
      : 'Exame sem contraste identificado: artérias e veias têm a mesma densidade dos músculos e não se separam. ') +
    'Nervos não aparecem na tomografia; use a aba Panorâmica para traçar o canal mandibular.' +
    (cbct ? ' CBCT: as faixas de partes moles não são confiáveis (valores não calibrados).' : '');
  renderTissues();
  applyTissues();
}

function applyTissues() {
  view3d?.setTransfer(sampleTransfer(tissues));
}

function renderTissues() {
  const ul = $('#tissue-list');
  ul.innerHTML = '';
  $('#tissue-card').hidden = renderMode !== 'volume' || !tissues.length;
  for (const t of tissues) {
    const li = document.createElement('li');
    li.classList.toggle('off', !t.enabled);
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.id = `tissue-${t.key}`;
    box.checked = t.enabled;
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = `rgb(${t.color.map((c) => Math.round(c * 255)).join(',')})`;
    const label = document.createElement('label');
    label.className = 'grow';
    label.htmlFor = box.id;
    label.innerHTML = '<span></span> <small></small>';
    label.querySelector('span')!.textContent = t.name;
    label.querySelector('small')!.textContent = `${t.lo} a ${t.hi} HU${t.note ? ` · ${t.note}` : ''}`;
    const op = document.createElement('label');
    op.className = 'opacity';
    op.innerHTML = 'Opacidade <input type="range" min="0" max="1" step="0.01" />';
    const range = op.querySelector('input')!;
    range.id = `tissue-op-${t.key}`;
    range.value = String(t.opacity);
    range.disabled = !t.enabled;
    box.addEventListener('change', () => {
      t.enabled = box.checked;
      li.classList.toggle('off', !t.enabled);
      range.disabled = !t.enabled;
      $$('[data-preset]').forEach((b) => b.classList.remove('on'));
      applyTissues();
    });
    range.addEventListener('input', () => {
      t.opacity = Number(range.value);
      applyTissues();
    });
    li.append(box, sw, label, op);
    ul.append(li);
  }
}

$$('[data-preset]').forEach((btn) =>
  btn.addEventListener('click', () => {
    $$('[data-preset]').forEach((b) => b.classList.toggle('on', b === btn));
    const keys = TISSUE_PRESETS[btn.dataset.preset!] ?? [];
    for (const t of tissues) t.enabled = keys.includes(t.key);
    renderTissues();
    applyTissues();
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
  const meshes = segLayers ? segLayers.filter((l) => l.visible).map((l) => l.mesh) : lastMesh ? [lastMesh] : [];
  if (!meshes.length) return;
  reportSave(await saveFile(`${baseName()}.stl`, new Blob([meshToStl(mergeMeshes(meshes))], { type: 'model/stl' })));
});

function mergeMeshes(list: Mesh[]): Mesh {
  if (list.length === 1) return list[0];
  const nPts = list.reduce((n, m) => n + m.points.length, 0);
  const nTri = list.reduce((n, m) => n + m.triangles.length, 0);
  const points = new Float32Array(nPts);
  const normals = new Float32Array(nPts);
  const triangles = new Uint32Array(nTri);
  let po = 0;
  let to = 0;
  for (const m of list) {
    points.set(m.points, po);
    normals.set(m.normals, po);
    const base = po / 3;
    for (let i = 0; i < m.triangles.length; i++) triangles[to + i] = m.triangles[i] + base;
    po += m.points.length;
    to += m.triangles.length;
  }
  return { points, normals, triangles };
}

// ---------- medidas no 3D ----------
const MEASURE_HINT: Record<MeasureTool, string> = {
  girar: '',
  distancia: 'Toque em 2 pontos do osso.',
  angulo: 'Toque em 3 pontos; o segundo é o vértice do ângulo.',
  ponto: 'Toque para marcar um ponto de referência.',
  selecionar: '',
};
$$('[data-measure]').forEach((btn) =>
  btn.addEventListener('click', async () => {
    const tool = btn.dataset.measure as MeasureTool;
    $$('[data-measure]').forEach((b) => b.classList.toggle('on', b === btn));
    $('#measure-hint').textContent =
      tool !== 'girar' && renderMode !== 'superficie' ? 'As medidas funcionam no modo Superfície óssea.' : MEASURE_HINT[tool];
    const v = await ensureView3d();
    v.setTool(tool);
  }),
);

function renderMeasures(list: Measurement[], pendingCount: number) {
  const ul = $('#measures-list');
  ul.innerHTML = '';
  $('#measures-card').hidden = !list.length && !pendingCount;
  const names = { distancia: 'Distância', angulo: 'Ângulo', ponto: 'Ponto' } as const;
  for (const m of list) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.className = 'grow';
    span.textContent = `${names[m.kind]}: ${m.label}`;
    const del = document.createElement('button');
    del.className = 'ghost small';
    del.textContent = 'Remover';
    del.addEventListener('click', () => view3d?.removeMeasurement(m.id));
    li.append(span, del);
    ul.append(li);
  }
  if (pendingCount) {
    const li = document.createElement('li');
    li.innerHTML = '<small></small>';
    li.querySelector('small')!.textContent = `${pendingCount} ponto(s) marcado(s)… continue tocando no modelo.`;
    ul.append(li);
  }
}
$('#measures-clear').addEventListener('click', () => view3d?.clearMeasurements());

// ---------- segmentação e metal ----------
const COLORS = {
  osso: [0.93, 0.89, 0.8] as const,
  metal: [1, 0.74, 0.18] as const,
};
const LABEL_COLORS: Record<number, readonly [number, number, number]> = {
  1: [0.93, 0.89, 0.8],
  2: [0.55, 0.75, 0.95],
  3: [1, 0.98, 0.9],
  4: [1, 0.74, 0.18],
  5: [0.55, 0.85, 0.98],
  6: [0.95, 0.22, 0.25],
};
const LABEL_OPACITY: Record<number, number> = { 5: 0.55 };
// cores das estruturas criadas pelo usuário (distintas entre si e do osso, dos dentes e do metal)
const USER_COLORS: (readonly [number, number, number])[] = [
  [0.6, 0.83, 0.55],
  [0.78, 0.62, 0.92],
  [0.95, 0.6, 0.45],
  [0.45, 0.82, 0.78],
  [0.93, 0.55, 0.68],
  [0.9, 0.85, 0.45],
  [0.55, 0.6, 0.95],
  [0.75, 0.75, 0.75],
];
const colorFor = (id: number) => LABEL_COLORS[id] ?? USER_COLORS[(id - 10) % USER_COLORS.length];
let layerVolumes = new Map<string, number>();
let segmented = false;

function applyLayers(list: LayerOut[]) {
  const incoming = list.map((l) => {
    layerVolumes.set(String(l.id), l.volumeMm3);
    return { key: String(l.id), name: l.name, color: colorFor(l.id), mesh: l.mesh, visible: true, opacity: LABEL_OPACITY[l.id] };
  });
  const byKey = new Map((segLayers ?? []).map((l) => [l.key, l]));
  for (const l of incoming) {
    const prev = byKey.get(l.key);
    byKey.set(l.key, prev ? { ...l, visible: prev.visible } : l);
  }
  segLayers = [...byKey.values()].filter((l) => l.mesh.triangles.length);
  return incoming;
}

$('#segment-btn').addEventListener('click', async () => {
  if (!built) return;
  const busy = $('#busy3d');
  busy.hidden = false;
  const btn = $<HTMLButtonElement>('#segment-btn');
  btn.disabled = true;
  try {
    const res = await client.segment(!isCbctVendor(built.study.manufacturer), Number(smoothingInput.value) > 0 ? 12 : 0, built.study.contrast, (m) => {
      busy.querySelector('span')!.textContent = m;
    });
    segLayers = [];
    layerVolumes = new Map();
    applyLayers(res.layers);
    segmented = true;
    const v = await ensureView3d();
    v.setSurfaces(segLayers);
    renderLayers();
    const notes = $('#recon-notes');
    for (const n of res.notes) {
      const li = document.createElement('li');
      li.textContent = n;
      notes.prepend(li);
    }
  } catch (e) {
    reportSave(`Falha na segmentação: ${(e as Error).message}`);
  } finally {
    busy.hidden = true;
    btn.disabled = false;
  }
});

function renderLayers() {
  const ul = $('#layers-list');
  ul.innerHTML = '';
  $('#layers-card').hidden = !segLayers?.length;
  $('#seg-editor').hidden = !segmented;
  for (const layer of segLayers ?? []) {
    const li = document.createElement('li');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = layer.visible;
    box.id = `layer-${layer.key}`;
    box.addEventListener('change', () => {
      layer.visible = box.checked;
      view3d?.setLayerVisible(layer.key, box.checked);
    });
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = `rgb(${layer.color.map((c) => Math.round(c * 255)).join(',')})`;
    const label = document.createElement('label');
    label.className = 'grow';
    label.htmlFor = box.id;
    const vol = layerVolumes.get(layer.key);
    label.innerHTML = '<span></span> <small></small>';
    label.querySelector('span')!.textContent = layer.name;
    label.querySelector('small')!.textContent = vol ? `${fmt(vol / 1000, 1)} cm³` : '';
    const stl = document.createElement('button');
    stl.className = 'ghost small';
    stl.textContent = 'STL';
    const fileKey = layer.name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/gi, '-')
      .toLowerCase();
    stl.addEventListener('click', async () =>
      reportSave(await saveFile(`${baseName()}-${fileKey}.stl`, new Blob([meshToStl(layer.mesh)], { type: 'model/stl' }))),
    );
    const glass = document.createElement('button');
    glass.className = 'ghost small';
    const translucent = (layer.opacity ?? 1) < 0.9;
    glass.textContent = translucent ? 'Opaco' : 'Transparente';
    glass.title = 'Deixa a estrutura translúcida para ver o que está dentro (canal, raízes, seios)';
    glass.addEventListener('click', () => {
      const op = (layer.opacity ?? 1) < 0.9 ? 1 : 0.3;
      layer.opacity = op;
      view3d?.setLayerOpacity(layer.key, op);
      glass.textContent = op < 0.9 ? 'Opaco' : 'Transparente';
    });
    li.append(box, sw, label, glass, stl);
    ul.append(li);
  }
}

// ---- editor de estruturas ----
let armedSplit: 'seed' | 'plane' | null = null;
const segName = $<HTMLSelectElement>('#seg-name');
segName.addEventListener('change', () => ($('#seg-other').hidden = segName.value !== '__outra'));

function disarm(message?: string) {
  armedSplit = null;
  $('#seg-touch').classList.remove('armed');
  $('#seg-plane').classList.remove('armed');
  $('#seg-cancel').hidden = true;
  view3d?.setTool('girar');
  $$('[data-measure]').forEach((b) => b.classList.toggle('on', b.dataset.measure === 'girar'));
  if (message) $('#seg-hint').textContent = message;
}

async function arm(mode: 'seed' | 'plane') {
  const v = await ensureView3d();
  if (renderMode !== 'superficie') $<HTMLButtonElement>('[data-mode="superficie"]').click();
  if (mode === 'plane' && !v.getClipPlane()) {
    $('#seg-hint').textContent = 'Primeiro escolha um "Corte do modelo" (sagital, coronal ou axial) e mova o plano até onde quer cortar. Depois toque em "Cortar pelo plano".';
    return;
  }
  armedSplit = mode;
  $('#seg-touch').classList.toggle('armed', mode === 'seed');
  $('#seg-plane').classList.toggle('armed', mode === 'plane');
  $('#seg-cancel').hidden = false;
  $$('[data-measure]').forEach((b) => b.classList.remove('on'));
  v.setTool('selecionar');
  $('#seg-hint').textContent =
    mode === 'seed' ? 'Toque na estrutura que deseja separar.' : 'Toque na parte visível (do lado do plano) que vai virar a nova estrutura.';
}
$('#seg-touch').addEventListener('click', () => arm('seed'));
$('#seg-plane').addEventListener('click', () => arm('plane'));
$('#seg-cancel').addEventListener('click', () => disarm('Edição cancelada.'));

async function onPick(point: Vec3) {
  if (!armedSplit || !view3d) return;
  const mode = armedSplit;
  const name = segName.value === '__outra' ? $<HTMLInputElement>('#seg-other').value.trim() || 'Estrutura' : segName.value;
  const plane = view3d.getClipPlane();
  disarm();
  const busy = $('#busy3d');
  busy.hidden = false;
  try {
    const res = await client.split(
      { mode, point, planeOrigin: plane?.origin, planeNormal: plane?.normal, name, smoothIterations: Number(smoothingInput.value) > 0 ? 12 : 0 },
      (m) => (busy.querySelector('span')!.textContent = m),
    );
    if (!res.ok) {
      $('#seg-hint').textContent = res.message;
      return;
    }
    applyLayers(res.layers);
    view3d.setSurfaces(segLayers!);
    renderLayers();
    $('#seg-hint').textContent = `"${name}" criada. ${res.message}`;
  } catch (e) {
    $('#seg-hint').textContent = `Falha: ${(e as Error).message}`;
  } finally {
    busy.hidden = true;
  }
}

// ---- metal ----
const KIND_NAMES = { parafuso: 'Parafuso/pino', placa: 'Placa', restauracao: 'Restauração', fragmento: 'Peça metálica' } as const;

function renderMetal(metal: ReconResponse['metal']) {
  const card = $('#metal-card');
  const toggle = $<HTMLButtonElement>('#metal-toggle');
  card.hidden = !metal;
  toggle.disabled = !metal;
  if (mprState) {
    mprState.metalThreshold = metal ? metal.seed : null;
    mprState.emit();
  }
  if (!metal) return;
  const counts = { parafuso: 0, placa: 0, restauracao: 0, fragmento: 0 };
  for (const o of metal.objects) counts[o.kind]++;
  $('#metal-summary').textContent =
    `${metal.objects.length} peça(s): ${counts.parafuso} parafuso(s)/pino(s), ${counts.placa} placa(s), ${counts.restauracao} restauração(ões), ${counts.fragmento} outra(s). ` +
    'Medidas pelos eixos principais de cada peça; o brilho do metal na tomografia aumenta um pouco o tamanho aparente.';
  const ul = $('#metal-list');
  ul.innerHTML = '';
  const order = { parafuso: 0, placa: 1, fragmento: 2, restauracao: 3 };
  for (const o of [...metal.objects].sort((a, b) => order[a.kind] - order[b.kind] || b.length - a.length)) {
    const li = document.createElement('li');
    const kind = document.createElement('span');
    kind.className = 'metal-kind';
    kind.textContent = KIND_NAMES[o.kind];
    const txt = document.createElement('span');
    txt.className = 'grow';
    const size =
      o.kind === 'parafuso'
        ? `${fmt(o.length, 1)} mm de comprimento × ${fmt(o.width, 1)} mm`
        : `${fmt(o.length, 1)} × ${fmt(o.width, 1)} × ${fmt(o.thickness, 1)} mm`;
    txt.innerHTML = '<span></span><br /><small></small>';
    txt.querySelector('span')!.textContent = `${size}`;
    txt.querySelector('small')!.textContent = o.location;
    const see = document.createElement('button');
    see.className = 'ghost small';
    see.textContent = 'Ver';
    see.addEventListener('click', async () => {
      showTab('tresd');
      (await ensureView3d()).focusOn(o.center, o.length);
    });
    li.append(kind, txt, see);
    ul.append(li);
  }
}

$('#metal-toggle').addEventListener('click', () => {
  if (!mprState) return;
  mprState.showMetal = !mprState.showMetal;
  $('#metal-toggle').setAttribute('aria-pressed', String(mprState.showMetal));
  mprState.emit();
});

// ---------- análise por IA ----------
const KEY_STORE = 'tomorecon.anthropicKey';
function readStoredKey() {
  try {
    return localStorage.getItem(KEY_STORE) ?? '';
  } catch {
    return '';
  }
}
$<HTMLInputElement>('#ia-key').value = readStoredKey();
$<HTMLInputElement>('#ia-remember').checked = !!readStoredKey();
claudeHostSample().then((h) => {
  const note = $('#ia-host-note');
  if (!h) {
    note.hidden = false;
    note.textContent = 'Fora do claude.ai (ou sem permissão do Claude nesta página): informe uma chave de API da Anthropic.';
    return;
  }
  note.hidden = false;
  if (h.maxImages > 0) {
    $('#ia-key-box').hidden = true;
    note.textContent = `Usando o Claude da sua conta do claude.ai, sem chave de API (até ${h.maxImages} imagem(ns) por análise). Na primeira vez, o Claude pede sua autorização.`;
  } else {
    $<HTMLInputElement>('#ia-key').placeholder = 'opcional — sk-ant-…';
    note.textContent =
      'Usando o Claude da sua conta do claude.ai, sem chave. Neste aparelho ele recebe só texto (dados técnicos e o seu contexto), sem as imagens. Para analisar as imagens, abra no computador ou informe uma chave de API.';
  }
});

function enableAi() {
  $<HTMLButtonElement>('#ia-run').disabled = false;
  $<HTMLButtonElement>('#ia-preview').disabled = false;
  $('#ia-status').textContent = 'Escolha as imagens, escreva o contexto e toque em Gerar descrição.';
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

async function dataUrlToJpeg(url: string): Promise<Blob> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext('2d')!.drawImage(img, 0, 0);
  return canvasToJpeg(c);
}

/** Captura as imagens escolhidas, sempre sem nome do paciente sobreposto. */
async function collectImages(): Promise<CaseImage[]> {
  const want = new Set($$<HTMLInputElement>('[data-ia-img]').filter((c) => c.checked).map((c) => c.dataset.iaImg!));
  const out: CaseImage[] = [];
  const back = $$('[data-tab]').find((b) => b.getAttribute('aria-selected') === 'true')?.dataset.tab ?? 'ia';
  const planes = [
    ['axial', 'Corte axial'],
    ['coronal', 'Corte coronal'],
    ['sagittal', 'Corte sagital'],
  ] as const;
  if (planes.some(([p]) => want.has(p))) {
    showTab('cortes');
    await nextFrame();
    for (const [plane, label] of planes) {
      const v = views.find((x) => x.plane === plane);
      if (!v || !want.has(plane)) continue;
      const hide = v.hidePatient;
      v.hidePatient = true;
      v.draw();
      out.push({ label: `${label} (janela óssea, cortes de ${fmt(built!.volume.spacing[2])} mm)`, blob: await canvasToJpeg(v.canvas) });
      v.hidePatient = hide;
      v.draw();
    }
  }
  if (view3d && lastMesh && (want.has('3d-frontal') || want.has('3d-lateral'))) {
    showTab('tresd');
    await nextFrame();
    const camSel = $<HTMLSelectElement>('#camera-view');
    for (const [key, cam, label] of [
      ['3d-frontal', 'frontal', 'Reconstrução 3D óssea, vista frontal'],
      ['3d-lateral', 'direita', 'Reconstrução 3D óssea, vista lateral direita'],
    ] as const) {
      if (!want.has(key)) continue;
      view3d.setCamera(cam);
      await nextFrame();
      out.push({ label, blob: await dataUrlToJpeg(await view3d.snapshot()) });
    }
    view3d.setCamera(camSel.value as CameraView);
  }
  if (want.has('pano')) {
    showTab('pano');
    await nextFrame();
    pano.redraw();
    for (const { label, canvas } of pano.snapshotImages()) out.push({ label, blob: await canvasToJpeg(canvas) });
  }
  showTab(back);
  return out;
}

function technicalSummary(): string {
  if (!built) return '';
  const b = built;
  const lines = [
    `Modalidade: ${b.series.modality || 'CT'} — região: cabeça e face`,
    `Aparelho: ${[b.study.manufacturer, b.study.model].filter(Boolean).join(' ') || 'não informado'}`,
    ...b.quality.facts.map((f) => `${f.label}: ${f.value}`),
    `Qualidade para 3D: ${b.quality.level}`,
    ...b.quality.warnings.map((w) => `Aviso: ${w}`),
    `Limiar ósseo usado no 3D: ${thresholdInput.value} HU`,
  ];
  const ms = view3d?.getMeasurements() ?? [];
  if (ms.length) lines.push(`Medidas feitas no 3D: ${ms.map((m) => m.label).join('; ')}`);
  return lines.join('\n');
}

$('#ia-preview').addEventListener('click', async () => {
  const box = $('#ia-sent');
  box.hidden = false;
  box.textContent = 'Capturando imagens…';
  const imgs = await collectImages();
  box.innerHTML = '';
  for (const im of imgs) {
    const fig = document.createElement('figure');
    const img = document.createElement('img');
    img.src = URL.createObjectURL(im.blob);
    img.alt = im.label;
    const cap = document.createElement('figcaption');
    cap.textContent = im.label;
    fig.append(img, cap);
    box.append(fig);
  }
  const pre = document.createElement('pre');
  pre.textContent = `${technicalSummary()}\n\nContexto: ${$<HTMLTextAreaElement>('#ia-question').value || '(vazio)'}\n\nNenhum nome, ID, data de nascimento ou data do exame é enviado.`;
  box.append(pre);
});

let iaAbort: AbortController | null = null;
$('#ia-stop').addEventListener('click', () => iaAbort?.abort());
$('#ia-run').addEventListener('click', async () => {
  if (!built) return;
  const key = $<HTMLInputElement>('#ia-key').value.trim();
  try {
    if ($<HTMLInputElement>('#ia-remember').checked && key) localStorage.setItem(KEY_STORE, key);
    else localStorage.removeItem(KEY_STORE);
  } catch {
    /* armazenamento indisponível: segue sem lembrar */
  }
  const run = $<HTMLButtonElement>('#ia-run');
  const stop = $('#ia-stop');
  const status = $('#ia-status');
  const out = $('#ia-text');
  run.disabled = true;
  stop.hidden = false;
  out.textContent = '';
  status.textContent = 'Capturando imagens anonimizadas…';
  iaAbort = new AbortController();
  try {
    const images = await collectImages();
    const host = await claudeHostSample();
    const sent = host && (host.maxImages > 0 || !key) ? Math.min(images.length, host.maxImages) : images.length;
    status.textContent = `${sent ? `Enviando ${sent} imagem(ns)` : 'Enviando só texto (sem imagens)'}${
      host && (host.maxImages > 0 || !key) ? ' ao Claude da sua conta' : ''
    }. Se aparecer um pedido de autorização, toque em Permitir. O Claude analisa antes de escrever; pode levar até um minuto…`;
    const text = await describeCase({
      images,
      technical: technicalSummary(),
      question: $<HTMLTextAreaElement>('#ia-question').value,
      apiKey: key || undefined,
      signal: iaAbort.signal,
      onText: (t) => {
        status.textContent = 'Escrevendo…';
        out.textContent = t;
      },
    });
    out.textContent = text;
    status.textContent = 'Descrição educacional gerada por IA. Confira nas imagens antes de usar no estudo.';
  } catch (e) {
    status.textContent = describeError(e);
  } finally {
    run.disabled = false;
    stop.hidden = true;
    iaAbort = null;
  }
});
$('#export-png').addEventListener('click', async () => {
  if (!view3d) return;
  reportSave(await saveFile(`${baseName()}.png`, await dataUrlToBlob(await view3d.snapshot())));
});

// ---------- imagem 2D ----------
new EnhancePanel($('#tab-imagem'));
