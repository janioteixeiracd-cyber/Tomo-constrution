import '@kitware/vtk.js/Rendering/Profiles/Geometry';
import '@kitware/vtk.js/Rendering/Profiles/Volume';
import vtkDataArray from '@kitware/vtk.js/Common/Core/DataArray';
import vtkCellArray from '@kitware/vtk.js/Common/Core/CellArray';
import vtkImageData from '@kitware/vtk.js/Common/DataModel/ImageData';
import vtkPlane from '@kitware/vtk.js/Common/DataModel/Plane';
import vtkPolyData from '@kitware/vtk.js/Common/DataModel/PolyData';
import vtkPiecewiseFunction from '@kitware/vtk.js/Common/DataModel/PiecewiseFunction';
import type vtkOpenGLRenderWindow from '@kitware/vtk.js/Rendering/OpenGL/RenderWindow';
import vtkGenericRenderWindow from '@kitware/vtk.js/Rendering/Misc/GenericRenderWindow';
import vtkLineSource from '@kitware/vtk.js/Filters/Sources/LineSource';
import vtkSphereSource from '@kitware/vtk.js/Filters/Sources/SphereSource';
import vtkActor from '@kitware/vtk.js/Rendering/Core/Actor';
import vtkCellPicker from '@kitware/vtk.js/Rendering/Core/CellPicker';
import vtkColorTransferFunction from '@kitware/vtk.js/Rendering/Core/ColorTransferFunction';
import vtkMapper from '@kitware/vtk.js/Rendering/Core/Mapper';
import vtkVolume from '@kitware/vtk.js/Rendering/Core/Volume';
import vtkVolumeMapper from '@kitware/vtk.js/Rendering/Core/VolumeMapper';
import { fmt } from '../core/math';
import type { Mesh } from '../core/mesh';
import type { Vec3, Volume } from '../core/types';

export type RenderMode = 'superficie' | 'volume';
export type VolumePreset = 'osso' | 'osso-pele' | 'pele';
export type CameraView = 'frontal' | 'direita' | 'esquerda' | 'superior' | 'inferior' | 'posterior';
export type ClipAxis = 'nenhum' | 'sagital' | 'coronal' | 'axial';
export type MeasureTool = 'girar' | 'distancia' | 'angulo' | 'ponto';

export interface SurfaceLayer {
  key: string;
  name: string;
  color: readonly [number, number, number];
  mesh: Mesh;
  visible: boolean;
  opacity?: number;
}

export interface Measurement {
  id: number;
  kind: Exclude<MeasureTool, 'girar'>;
  points: Vec3[];
  /** texto do resultado (ex.: "23,4 mm", "112,5°", "P1") */
  label: string;
}

const NEEDED: Record<Measurement['kind'], number> = { distancia: 2, angulo: 3, ponto: 1 };

/** Direção (LPS) de onde a câmera olha e vetor "para cima" de cada vista padrão. */
const VIEWS: Record<CameraView, { from: [number, number, number]; up: [number, number, number] }> = {
  frontal: { from: [0, -1, 0], up: [0, 0, 1] },
  posterior: { from: [0, 1, 0], up: [0, 0, 1] },
  direita: { from: [-1, 0, 0], up: [0, 0, 1] },
  esquerda: { from: [1, 0, 0], up: [0, 0, 1] },
  superior: { from: [0, 0, 1], up: [0, -1, 0] },
  inferior: { from: [0, 0, -1], up: [0, -1, 0] },
};

const BONE = [0.93, 0.89, 0.8] as const;

export class View3D {
  private grw = vtkGenericRenderWindow.newInstance({ background: [0.04, 0.05, 0.07] });
  private renderer = this.grw.getRenderer();
  private renderWindow = this.grw.getRenderWindow();
  private layers: { layer: SurfaceLayer; actor: ReturnType<typeof vtkActor.newInstance>; mapper: ReturnType<typeof vtkMapper.newInstance> }[] = [];
  private picker = vtkCellPicker.newInstance();
  private tool: MeasureTool = 'girar';
  private pending: Vec3[] = [];
  private measurements: Measurement[] = [];
  private measureActors: ReturnType<typeof vtkActor.newInstance>[] = [];
  private labels: HTMLDivElement;
  private nextId = 1;
  private landmarkCount = 0;
  onMeasurementsChange: (list: Measurement[], pendingCount: number) => void = () => {};
  private volumeActor = vtkVolume.newInstance();
  private volumeMapper = vtkVolumeMapper.newInstance();
  private clipPlane = vtkPlane.newInstance();
  private mode: RenderMode = 'superficie';
  private hasVolume = false;
  private bounds: number[] | null = null;
  private threshold = 200;
  private preset: VolumePreset = 'osso';
  triangleCount = 0;

  constructor(private container: HTMLElement) {
    this.grw.setContainer(container);
    this.labels = document.createElement('div');
    this.labels.className = 'measure-labels';
    container.append(this.labels);
    this.picker.setPickFromList(true);
    this.picker.setTolerance(0);
    this.renderer.getActiveCamera().onModified(() => this.updateLabels());
    this.listenForTaps();
    this.volumeActor.setMapper(this.volumeMapper);
    const vp = this.volumeActor.getProperty();
    vp.setInterpolationTypeToLinear();
    vp.setShade(true);
    vp.setAmbient(0.25);
    vp.setDiffuse(0.75);
    vp.setSpecular(0.25);
    vp.setSpecularPower(16);
    new ResizeObserver(() => {
      this.grw.resize();
      this.render();
    }).observe(container);
  }

  /** Uma única superfície óssea. */
  setMesh(mesh: Mesh) {
    this.setSurfaces([{ key: 'osso', name: 'Osso', color: BONE, mesh, visible: true }]);
  }

  /** Várias superfícies (ex.: segmentação) com cor e visibilidade próprias. */
  setSurfaces(list: SurfaceLayer[]) {
    this.layers = list.map((layer) => {
      const mapper = vtkMapper.newInstance();
      mapper.setInputData(toPolyData(layer.mesh));
      const actor = vtkActor.newInstance();
      actor.setMapper(mapper);
      const prop = actor.getProperty();
      prop.setColor(...layer.color);
      prop.setOpacity(layer.opacity ?? 1);
      prop.setAmbient(0.15);
      prop.setDiffuse(0.8);
      prop.setSpecular(0.25);
      prop.setSpecularPower(20);
      actor.setVisibility(layer.visible);
      return { layer, actor, mapper };
    });
    this.triangleCount = list.reduce((n, l) => n + l.mesh.triangles.length / 3, 0);
    const withMesh = this.layers.filter((l) => l.layer.mesh.triangles.length);
    if (withMesh.length) {
      const b = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
      for (const l of withMesh) {
        const lb = l.mapper.getInputData().getBounds();
        for (let i = 0; i < 6; i += 2) {
          b[i] = Math.min(b[i], lb[i]);
          b[i + 1] = Math.max(b[i + 1], lb[i + 1]);
        }
      }
      this.bounds = b;
    }
    this.reapplyClip();
    this.sync();
  }

  setLayerVisible(key: string, visible: boolean) {
    const l = this.layers.find((x) => x.layer.key === key);
    if (!l) return;
    l.layer.visible = visible;
    l.actor.setVisibility(visible);
    this.render();
  }

  setVolume(vol: Volume, threshold: number) {
    const image = vtkImageData.newInstance();
    image.setDimensions(vol.dims);
    image.setSpacing(vol.spacing);
    image.setOrigin(vol.origin);
    image.setDirection(Float32Array.from(vol.direction));
    image.getPointData().setScalars(vtkDataArray.newInstance({ name: 'HU', numberOfComponents: 1, values: vol.data }));
    this.volumeMapper.setInputData(image);
    this.volumeMapper.setSampleDistance(Math.min(...vol.spacing) * 0.7);
    this.volumeMapper.setMaximumSamplesPerRay(2000);
    this.threshold = threshold;
    this.hasVolume = true;
    if (!this.bounds) this.bounds = image.getBounds();
    this.applyPreset();
    this.sync();
  }

  setMode(mode: RenderMode) {
    this.mode = mode;
    this.sync();
  }

  setPreset(preset: VolumePreset) {
    this.preset = preset;
    this.applyPreset();
    this.render();
  }

  setThreshold(t: number) {
    this.threshold = t;
    this.applyPreset();
    this.render();
  }

  private applyPreset() {
    const T = this.threshold;
    const ctf = vtkColorTransferFunction.newInstance();
    const otf = vtkPiecewiseFunction.newInstance();
    const skin = [0.86, 0.62, 0.5] as const;
    if (this.preset === 'pele') {
      ctf.addRGBPoint(-600, ...skin);
      ctf.addRGBPoint(0, 0.9, 0.7, 0.6);
      ctf.addRGBPoint(T, ...BONE);
      otf.addPoint(-750, 0);
      otf.addPoint(-450, 0.5);
      otf.addPoint(-200, 0.9);
      otf.addPoint(3000, 0.9);
    } else {
      ctf.addRGBPoint(T - 150, 0.55, 0.25, 0.15);
      ctf.addRGBPoint(T + 150, 0.88, 0.78, 0.65);
      ctf.addRGBPoint(T + 900, ...BONE);
      ctf.addRGBPoint(T + 2000, 1, 1, 0.97);
      if (this.preset === 'osso-pele') {
        ctf.addRGBPoint(-500, ...skin);
        ctf.addRGBPoint(-100, 0.8, 0.55, 0.45);
        otf.addPoint(-800, 0);
        otf.addPoint(-500, 0);
        otf.addPoint(-350, 0.06);
        otf.addPoint(-100, 0.04);
        otf.addPoint(T - 120, 0.03);
      } else {
        otf.addPoint(-1024, 0);
        otf.addPoint(T - 120, 0);
      }
      otf.addPoint(T + 80, 0.25);
      otf.addPoint(T + 500, 0.65);
      otf.addPoint(T + 1500, 0.9);
    }
    const vp = this.volumeActor.getProperty();
    vp.setRGBTransferFunction(0, ctf);
    vp.setScalarOpacity(0, otf);
    vp.setScalarOpacityUnitDistance(0, 1.2);
  }

  private sync() {
    this.renderer.removeAllViewProps();
    if (this.mode === 'superficie') for (const l of this.layers) this.renderer.addActor(l.actor);
    if (this.mode === 'volume' && this.hasVolume) this.renderer.addVolume(this.volumeActor);
    for (const a of this.measureActors) this.renderer.addActor(a);
    this.render();
  }

  private clip: { axis: ClipAxis; fraction: number; flip: boolean } = { axis: 'nenhum', fraction: 0.5, flip: false };

  private reapplyClip() {
    this.setClip(this.clip.axis, this.clip.fraction, this.clip.flip);
  }

  setClip(axis: ClipAxis, fraction: number, flip = false) {
    this.clip = { axis, fraction, flip };
    const mappers = [...this.layers.map((l) => l.mapper), this.volumeMapper];
    for (const m of mappers) m.removeAllClippingPlanes();
    if (axis !== 'nenhum' && this.bounds) {
      const i = axis === 'sagital' ? 0 : axis === 'coronal' ? 1 : 2;
      const b = this.bounds;
      const origin: [number, number, number] = [(b[0] + b[1]) / 2, (b[2] + b[3]) / 2, (b[4] + b[5]) / 2];
      origin[i] = b[2 * i] + (b[2 * i + 1] - b[2 * i]) * fraction;
      const normal: [number, number, number] = [0, 0, 0];
      normal[i] = flip ? -1 : 1;
      this.clipPlane.setOrigin(origin);
      this.clipPlane.setNormal(normal);
      for (const m of mappers) m.addClippingPlane(this.clipPlane);
    }
    this.render();
  }

  setCamera(view: CameraView) {
    if (!this.bounds) return;
    const b = this.bounds;
    const c = [(b[0] + b[1]) / 2, (b[2] + b[3]) / 2, (b[4] + b[5]) / 2];
    const { from, up } = VIEWS[view];
    const cam = this.renderer.getActiveCamera();
    cam.setFocalPoint(c[0], c[1], c[2]);
    cam.setPosition(c[0] + from[0] * 500, c[1] + from[1] * 500, c[2] + from[2] * 500);
    cam.setViewUp(...up);
    this.renderer.resetCamera(b as [number, number, number, number, number, number]);
    // resetCamera enquadra a esfera envolvente; aproxima para o modelo ocupar a vista.
    // O ângulo de visão é vertical: em tela de pé (celular) a largura limita, então aproxima menos.
    const rect = this.container.getBoundingClientRect();
    const aspect = rect.height ? rect.width / rect.height : 1;
    cam.zoom(Math.max(1, 1.6 * Math.min(1, aspect / 0.95)));
    this.render();
  }

  render() {
    this.renderWindow.render();
    this.updateLabels();
  }

  async snapshot(): Promise<string> {
    this.render();
    const [img] = await Promise.all(this.renderWindow.captureImages());
    return img as string;
  }

  // ---------- medidas ----------

  setTool(tool: MeasureTool) {
    this.tool = tool;
    this.pending = [];
    this.container.classList.toggle('measuring', tool !== 'girar');
    this.rebuildMeasureActors();
  }

  getMeasurements() {
    return this.measurements;
  }

  removeMeasurement(id: number) {
    this.measurements = this.measurements.filter((m) => m.id !== id);
    this.rebuildMeasureActors();
  }

  clearMeasurements() {
    this.measurements = [];
    this.pending = [];
    this.landmarkCount = 0;
    this.rebuildMeasureActors();
  }

  /** Toque curto (sem arrastar) seleciona um ponto; arrastar continua girando o modelo. */
  private listenForTaps() {
    let down: { x: number; y: number; t: number } | null = null;
    this.container.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, t: performance.now() };
    });
    this.container.addEventListener('pointerup', (e) => {
      if (!down || this.tool === 'girar' || this.mode !== 'superficie') return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const quick = performance.now() - down.t < 600;
      down = null;
      if (moved > 6 || !quick) return;
      const p = this.pickAt(e.clientX, e.clientY);
      if (p) this.addPoint(p);
    });
  }

  private pickAt(clientX: number, clientY: number): Vec3 | null {
    const visible = this.layers.filter((l) => l.layer.visible && l.layer.mesh.triangles.length);
    if (!visible.length) return null;
    const rect = this.container.getBoundingClientRect();
    const size = this.grw.getApiSpecificRenderWindow().getSize();
    const x = ((clientX - rect.left) * size[0]) / rect.width;
    const y = size[1] - ((clientY - rect.top) * size[1]) / rect.height;
    this.picker.initializePickList();
    for (const l of visible) this.picker.addPickList(l.actor);
    this.picker.pick([x, y, 0], this.renderer);
    if (!this.picker.getActors().length) return null;
    const p = this.picker.getPickPosition();
    return [p[0], p[1], p[2]];
  }

  private addPoint(p: Vec3) {
    const kind = this.tool as Measurement['kind'];
    this.pending.push(p);
    if (this.pending.length >= NEEDED[kind]) {
      const pts = this.pending;
      this.pending = [];
      let label: string;
      if (kind === 'distancia') {
        label = `${fmt(dist(pts[0], pts[1]), 1)} mm`;
      } else if (kind === 'angulo') {
        const a: Vec3 = [pts[0][0] - pts[1][0], pts[0][1] - pts[1][1], pts[0][2] - pts[1][2]];
        const b: Vec3 = [pts[2][0] - pts[1][0], pts[2][1] - pts[1][1], pts[2][2] - pts[1][2]];
        const cos = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / ((Math.hypot(...a) * Math.hypot(...b)) || 1);
        label = `${fmt((Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI, 1)}°`;
      } else {
        label = `P${++this.landmarkCount}`;
      }
      this.measurements.push({ id: this.nextId++, kind, points: pts, label });
    }
    this.rebuildMeasureActors();
  }

  private markerRadius() {
    const b = this.bounds;
    if (!b) return 1;
    return Math.max(0.6, Math.hypot(b[1] - b[0], b[3] - b[2], b[5] - b[4]) * 0.004);
  }

  private rebuildMeasureActors() {
    for (const a of this.measureActors) this.renderer.removeActor(a);
    this.measureActors = [];
    const r = this.markerRadius();
    const sphere = (p: Vec3, color: readonly [number, number, number]) => {
      const src = vtkSphereSource.newInstance({ center: p, radius: r, thetaResolution: 16, phiResolution: 12 });
      const m = vtkMapper.newInstance();
      m.setInputConnection(src.getOutputPort());
      const a = vtkActor.newInstance();
      a.setMapper(m);
      a.getProperty().setColor(...color);
      a.getProperty().setAmbient(0.4);
      this.measureActors.push(a);
    };
    const line = (p1: Vec3, p2: Vec3) => {
      const src = vtkLineSource.newInstance({ point1: p1, point2: p2 });
      const m = vtkMapper.newInstance();
      m.setInputConnection(src.getOutputPort());
      const a = vtkActor.newInstance();
      a.setMapper(m);
      a.getProperty().setColor(1, 0.83, 0);
      a.getProperty().setLineWidth(3);
      this.measureActors.push(a);
    };
    const YELLOW = [1, 0.83, 0] as const;
    for (const m of this.measurements) {
      m.points.forEach((p) => sphere(p, m.kind === 'ponto' ? ([1, 0.42, 0.42] as const) : YELLOW));
      for (let i = 1; i < m.points.length; i++) line(m.points[i - 1], m.points[i]);
    }
    this.pending.forEach((p) => sphere(p, [0.3, 0.76, 1]));
    for (let i = 1; i < this.pending.length; i++) line(this.pending[i - 1], this.pending[i]);
    this.sync();
    this.onMeasurementsChange(this.measurements, this.pending.length);
  }

  private updateLabels() {
    if (!this.labels) return;
    // o perfil carregado usa WebGL (OpenGL), que tem worldToDisplay
    const api = this.grw.getApiSpecificRenderWindow() as vtkOpenGLRenderWindow;
    const size = api.getSize();
    const rect = this.container.getBoundingClientRect();
    if (!size[0] || !rect.width) return;
    const toCss = (p: Vec3) => {
      const d = api.worldToDisplay(p[0], p[1], p[2], this.renderer);
      return [(d[0] * rect.width) / size[0], rect.height - (d[1] * rect.height) / size[1]];
    };
    const html: string[] = [];
    for (const m of this.measurements) {
      const anchor =
        m.kind === 'distancia'
          ? ([0, 1, 2].map((i) => (m.points[0][i] + m.points[1][i]) / 2) as Vec3)
          : m.kind === 'angulo'
            ? m.points[1]
            : m.points[0];
      const [x, y] = toCss(anchor);
      html.push(`<span class="mlabel ${m.kind}" style="left:${x.toFixed(1)}px;top:${y.toFixed(1)}px">${m.label}</span>`);
    }
    this.labels.innerHTML = html.join('');
  }
}

function dist(a: Vec3, b: Vec3) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function toPolyData(mesh: Mesh) {
  const poly = vtkPolyData.newInstance();
  poly.getPoints().setData(mesh.points, 3);
  const nTri = mesh.triangles.length / 3;
  const cells = new Uint32Array(nTri * 4);
  for (let t = 0; t < nTri; t++) {
    cells[t * 4] = 3;
    cells[t * 4 + 1] = mesh.triangles[t * 3];
    cells[t * 4 + 2] = mesh.triangles[t * 3 + 1];
    cells[t * 4 + 3] = mesh.triangles[t * 3 + 2];
  }
  poly.setPolys(vtkCellArray.newInstance({ values: cells }));
  poly.getPointData().setNormals(vtkDataArray.newInstance({ name: 'Normals', numberOfComponents: 3, values: mesh.normals }));
  return poly;
}
