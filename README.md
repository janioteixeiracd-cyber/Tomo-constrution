# TomoRecon 3D

Aplicação web para **estudo de casos de cirurgia bucomaxilofacial**: abre tomografias (TC e CBCT) em DICOM, mostra os cortes axial, coronal e sagital, gera a **reconstrução 3D óssea de cabeça e face** e realça radiografias e fotos de baixa qualidade.

> **Uso educacional.** A ferramenta não tem finalidade diagnóstica, não é registrada como dispositivo médico e não substitui o laudo do exame. Confirme sempre qualquer achado nos cortes originais.

## O que faz

| Aba | Recursos |
| --- | --- |
| **Cortes** | Axial, coronal e sagital sincronizados; janelas Osso, Partes moles, Seios/ar e Dentes/metal; ajuste de janela por arraste; régua em mm; leitura de densidade (HU). |
| **3D** | Superfície óssea (malha) ou renderização volumétrica (Osso, Osso + pele, Pele); vistas frontal, laterais, superior, inferior e posterior; corte do modelo por plano; exportação **STL** (impressão 3D/planejamento) e PNG. |
| **Imagem 2D** | Para radiografias, fotos do negatoscópio e capturas de tela: redução de ruído, contraste local (CLAHE), nitidez, brilho/contraste/gama, negativo, comparação antes/depois e download. |

### Reconstrução mesmo com dados limitados

Toda série é avaliada (espaçamento entre cortes, número de cortes, compressão com perdas, série reformatada, espaçamento irregular, CBCT sem HU calibrado). O 3D é **sempre gerado**, junto com uma classificação **boa / moderada / limitada** e um aviso de que forma, espessura e medidas podem variar quando faltam informações.

Para cortes espessos (> 2 mm) a reconstrução usa **interpolação baseada em forma**: o contorno ósseo de cada corte vira um mapa de distância, e são essas distâncias que se interpolam entre os cortes. O resultado são superfícies contínuas em vez de "degraus". Cortes ausentes são preenchidos e fragmentos soltos (suporte de cabeça, ruído) são removidos.

### Privacidade (LGPD)

Todo o processamento acontece **no navegador**. Nenhum exame é enviado a servidor. Os dados do paciente ficam ocultos por padrão na tela e nos arquivos exportados. Arquivos `.dcm`/`.zip` estão no `.gitignore` para que exames nunca sejam enviados ao repositório.

## Como usar

1. Exporte o exame em DICOM (pasta ou `.zip`). Para o melhor 3D, prefira a série volumétrica fina (ex.: "VOL OSSO", 0,6–1,25 mm) e não as séries de reformatação.
2. Abra a aplicação, toque em **Abrir arquivos** (ou arraste a pasta/zip). A melhor série para 3D é escolhida automaticamente; as outras aparecem na lista.
3. Na aba **3D**, ajuste o **limiar ósseo** se necessário e toque em **Reconstruir 3D**.

## Desenvolvimento

```bash
npm install      # também aplica o patch do decodificador (patch-package)
npm run dev      # servidor local
npm test         # testes unitários
npm run build    # versão de produção em dist/
```

O workflow `.github/workflows/pages.yml` publica no GitHub Pages a cada push em `main` (ative em *Settings → Pages → Source: GitHub Actions*).

### Estrutura

- `src/core/`: processamento sem interface (leitura DICOM, montagem do volume, qualidade, interpolação, distância com sinal, componentes conexos, malha/STL, realce 2D), com testes.
- `src/worker.ts`: processamento pesado em Web Worker.
- `src/ui/`: cortes (canvas), 3D (vtk.js) e realce 2D.
- `patches/daikon+1.2.46.patch`: correções no decodificador JPEG de 12 bits (comum em TC): deslocamento de +15 HU nos valores e rejeição de bytes de preenchimento `FF FF` válidos.

## Próximos passos sugeridos

- Medidas e marcações direto no modelo 3D.
- Segmentação automática por IA (mandíbula, maxila, dentes, canal mandibular).
- Descrição assistida por IA das imagens, com anonimização antes do envio.
- Panorâmica reconstruída a partir da TC/CBCT (curva da arcada).
