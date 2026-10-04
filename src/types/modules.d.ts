declare module 'daikon' {
  // A biblioteca não publica tipos; usamos apenas o subconjunto abaixo.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const daikon: {
    Series: { parseImage(data: DataView): any; parserError?: unknown };
  };
  export default daikon;
}

// Filtros do vtk.js publicados sem declarações de tipo.
declare module '@kitware/vtk.js/Filters/Core/PolyDataNormals';
declare module '@kitware/vtk.js/Filters/General/ImageMarchingCubes';
declare module '@kitware/vtk.js/Filters/General/WindowedSincPolyDataFilter';
