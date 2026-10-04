import vtkDataArray from '@kitware/vtk.js/Common/Core/DataArray';
import vtkImageData from '@kitware/vtk.js/Common/DataModel/ImageData';
import vtkPolyDataNormals from '@kitware/vtk.js/Filters/Core/PolyDataNormals';
import vtkImageMarchingCubes from '@kitware/vtk.js/Filters/General/ImageMarchingCubes';
import vtkWindowedSincPolyDataFilter from '@kitware/vtk.js/Filters/General/WindowedSincPolyDataFilter';
import type { ReconResult } from './types';

export interface Mesh {
  /** vértices em mm, coordenadas do paciente (LPS) */
  points: Float32Array;
  normals: Float32Array;
  /** triângulos: índices de vértices, 3 por face */
  triangles: Uint32Array;
}

/** Extrai a superfície óssea (isovalor 0 do campo) e suaviza a malha. */
export function extractSurface(field: ReconResult['surfaceField'], smoothIterations = 15): Mesh {
  const image = vtkImageData.newInstance();
  image.setDimensions(field.dims);
  image.setSpacing(field.spacing);
  image.setOrigin([0, 0, 0]);
  image.getPointData().setScalars(vtkDataArray.newInstance({ name: 'field', numberOfComponents: 1, values: field.data }));

  const mc = vtkImageMarchingCubes.newInstance({ contourValue: 0, computeNormals: false, mergePoints: true });
  mc.setInputData(image);
  let poly = mc.getOutputData();
  if (!poly.getPoints().getNumberOfPoints()) {
    return { points: new Float32Array(0), normals: new Float32Array(0), triangles: new Uint32Array(0) };
  }
  if (smoothIterations > 0) {
    const smooth = vtkWindowedSincPolyDataFilter.newInstance({
      numberOfIterations: smoothIterations,
      passBand: 0.08,
      nonManifoldSmoothing: true,
      normalizeCoordinates: true,
      boundarySmoothing: false,
    });
    smooth.setInputData(poly);
    poly = smooth.getOutputData();
  }
  const normalsFilter = vtkPolyDataNormals.newInstance({ computePointNormals: true, computeCellNormals: false });
  normalsFilter.setInputData(poly);
  poly = normalsFilter.getOutputData();

  const raw = poly.getPoints().getData() as Float32Array;
  const rawNormals = (poly.getPointData().getNormals()?.getData() as Float32Array | undefined) ?? new Float32Array(raw.length);
  const cells = poly.getPolys().getData() as Uint32Array;

  // índice → paciente: origem + D·p (D ortonormal, colunas = linha, coluna, normal)
  const d = field.direction;
  const o = field.origin;
  const points = new Float32Array(raw.length);
  const normals = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i += 3) {
    const x = raw[i];
    const y = raw[i + 1];
    const z = raw[i + 2];
    points[i] = o[0] + d[0] * x + d[3] * y + d[6] * z;
    points[i + 1] = o[1] + d[1] * x + d[4] * y + d[7] * z;
    points[i + 2] = o[2] + d[2] * x + d[5] * y + d[8] * z;
    const nx = rawNormals[i];
    const ny = rawNormals[i + 1];
    const nz = rawNormals[i + 2];
    normals[i] = d[0] * nx + d[3] * ny + d[6] * nz;
    normals[i + 1] = d[1] * nx + d[4] * ny + d[7] * nz;
    normals[i + 2] = d[2] * nx + d[5] * ny + d[8] * nz;
  }
  // células vtk: [3, a, b, c, 3, ...] → triângulos compactos
  const triangles = new Uint32Array((cells.length / 4) * 3);
  let t = 0;
  for (let i = 0; i < cells.length; ) {
    const n = cells[i];
    if (n === 3) {
      triangles[t++] = cells[i + 1];
      triangles[t++] = cells[i + 2];
      triangles[t++] = cells[i + 3];
    }
    i += n + 1;
  }
  return { points, normals, triangles: t === triangles.length ? triangles : triangles.slice(0, t) };
}

/** STL binário (mm). */
export function meshToStl(mesh: Mesh, header = 'TomoRecon 3D - uso educacional'): ArrayBuffer {
  const nTri = mesh.triangles.length / 3;
  const buf = new ArrayBuffer(84 + nTri * 50);
  const view = new DataView(buf);
  const head = new TextEncoder().encode(header.slice(0, 80));
  new Uint8Array(buf, 0, 80).set(head);
  view.setUint32(80, nTri, true);
  const p = mesh.points;
  let off = 84;
  for (let t = 0; t < nTri; t++) {
    const a = mesh.triangles[t * 3] * 3;
    const b = mesh.triangles[t * 3 + 1] * 3;
    const c = mesh.triangles[t * 3 + 2] * 3;
    const ux = p[b] - p[a];
    const uy = p[b + 1] - p[a + 1];
    const uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a];
    const vy = p[c + 1] - p[a + 1];
    const vz = p[c + 2] - p[a + 2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    view.setFloat32(off, nx, true);
    view.setFloat32(off + 4, ny, true);
    view.setFloat32(off + 8, nz, true);
    off += 12;
    for (const idx of [a, b, c]) {
      view.setFloat32(off, p[idx], true);
      view.setFloat32(off + 4, p[idx + 1], true);
      view.setFloat32(off + 8, p[idx + 2], true);
      off += 12;
    }
    view.setUint16(off, 0, true);
    off += 2;
  }
  return buf;
}
