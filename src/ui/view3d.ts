import '@kitware/vtk.js/Rendering/Profiles/Geometry';
import '@kitware/vtk.js/Rendering/Profiles/Volume';
import vtkDataArray from '@kitware/vtk.js/Common/Core/DataArray';
import vtkCellArray from '@kitware/vtk.js/Common/Core/CellArray';
import vtkImageData from '@kitware/vtk.js/Common/DataModel/ImageData';
import vtkPlane from '@kitware/vtk.js/Common/DataModel/Plane';
import vtkPolyData from '@kitware/vtk.js/Common/DataModel/PolyData';
import vtkPiecewiseFunction from '@kitware/vtk.js/Common/DataModel/PiecewiseFunction';
import vtkGenericRenderWindow from '@kitware/vtk.js/Rendering/Misc/GenericRenderWindow';
import vtkActor from '@kitware/vtk.js/Rendering/Core/Actor';
import vtkColorTransferFunction from '@kitware/vtk.js/Rendering/Core/ColorTransferFunction';
import vtkMapper from '@kitware/vtk.js/Rendering/Core/Mapper';
import vtkVolume from '@kitware/vtk.js/Rendering/Core/Volume';
import vtkVolumeMapper from '@kitware/vtk.js/Rendering/Core/VolumeMapper';
import type { Mesh } from '../core/mesh';
import type { Volume } from '../core/types';

export type RenderMode = 'superficie' | 'volume';
export type VolumePreset = 'osso' | 'osso-pele' | 'pele';
export type CameraView = 'frontal' | 'direita' | 'esquerda' | 'superior' | 'inferior' | 'posterior';
export type ClipAxis = 'nenhum' | 'sagital' | 'coronal' | 'axial';

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
  private surfaceActor = vtkActor.newInstance();
  private surfaceMapper = vtkMapper.newInstance();
  private volumeActor = vtkVolume.newInstance();
  private volumeMapper = vtkVolumeMapper.newInstance();
  private clipPlane = vtkPlane.newInstance();
  private mode: RenderMode = 'superficie';
  private hasSurface = false;
  private hasVolume = false;
  private bounds: number[] | null = null;
  private threshold = 200;
  private preset: VolumePreset = 'osso';
  triangleCount = 0;

  constructor(container: HTMLElement) {
    this.grw.setContainer(container);
    this.surfaceActor.setMapper(this.surfaceMapper);
    const prop = this.surfaceActor.getProperty();
    prop.setColor(...BONE);
    prop.setAmbient(0.15);
    prop.setDiffuse(0.8);
    prop.setSpecular(0.25);
    prop.setSpecularPower(20);
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

  setMesh(mesh: Mesh) {
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
    this.surfaceMapper.setInputData(poly);
    this.triangleCount = nTri;
    this.hasSurface = nTri > 0;
    if (nTri) this.bounds = poly.getBounds();
    this.sync();
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
    if (this.mode === 'superficie' && this.hasSurface) this.renderer.addActor(this.surfaceActor);
    if (this.mode === 'volume' && this.hasVolume) this.renderer.addVolume(this.volumeActor);
    this.render();
  }

  setClip(axis: ClipAxis, fraction: number, flip = false) {
    for (const m of [this.surfaceMapper, this.volumeMapper]) m.removeAllClippingPlanes();
    if (axis !== 'nenhum' && this.bounds) {
      const i = axis === 'sagital' ? 0 : axis === 'coronal' ? 1 : 2;
      const b = this.bounds;
      const origin: [number, number, number] = [(b[0] + b[1]) / 2, (b[2] + b[3]) / 2, (b[4] + b[5]) / 2];
      origin[i] = b[2 * i] + (b[2 * i + 1] - b[2 * i]) * fraction;
      const normal: [number, number, number] = [0, 0, 0];
      normal[i] = flip ? -1 : 1;
      this.clipPlane.setOrigin(origin);
      this.clipPlane.setNormal(normal);
      for (const m of [this.surfaceMapper, this.volumeMapper]) m.addClippingPlane(this.clipPlane);
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
    // resetCamera enquadra a esfera envolvente; aproxima para o modelo ocupar a vista
    cam.zoom(1.35);
    this.render();
  }

  render() {
    this.renderWindow.render();
  }

  async snapshot(): Promise<string> {
    this.render();
    const [img] = await Promise.all(this.renderWindow.captureImages());
    return img as string;
  }
}
