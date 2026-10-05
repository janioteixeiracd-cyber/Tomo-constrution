# TomoRecon 3D

Aplicação web para **estudo de casos de cirurgia bucomaxilofacial**: abre tomografias (TC e CBCT) em DICOM, mostra os cortes axial, coronal e sagital, gera a **reconstrução 3D óssea de cabeça e face** e realça radiografias e fotos de baixa qualidade.

> **Uso educacional.** A ferramenta não tem finalidade diagnóstica, não é registrada como dispositivo médico e não substitui o laudo do exame. Confirme sempre qualquer achado nos cortes originais.

## O que faz

| Aba | Recursos |
| --- | --- |
| **Cortes** | Axial, coronal e sagital sincronizados; janelas Osso, Partes moles, Seios/ar e Dentes/metal; ajuste de janela por arraste; régua em mm; leitura de densidade (HU). |
| **3D** | Superfície óssea (malha) ou renderização volumétrica (Osso, Osso + pele, Pele); vistas padrão; corte do modelo por plano; **medidas no modelo** (distância, ângulo, pontos de referência); **metal** (placas, parafusos, pinos, restaurações) separado do osso em dourado, com a lista das peças e suas medidas; **segmentação** automática (crânio/face, mandíbula, dentes, metal) e **editor de estruturas** (separar por toque, cortar pelo plano) para maxila, zigomáticos, ossos nasais etc., com STL de cada uma; exportação **STL** e PNG. |
| **Panorâmica** | Toque pontos ao longo do arco no axial para gerar a **panorâmica reconstruída** (média ou MIP, espessura ajustável) e **cortes transversais** com régua para altura e espessura óssea; **traçado do canal mandibular** (direito/esquerdo) nos transversais, mostrado na panorâmica, no axial e em 3D. |
| **Imagem 2D** | Para radiografias, fotos do negatoscópio e capturas de tela: redução de ruído, contraste local (CLAHE), nitidez, brilho/contraste/gama, negativo, comparação antes/depois e download. |
| **Análise IA** | Descrição educacional do caso pelo Claude a partir de imagens **anonimizadas** (cortes, 3D, panorâmica) e dados técnicos, com prévia exata do que é enviado. No claude.ai usa a conta do usuário; no site próprio pede uma chave de API da Anthropic. |

### Reconstrução mesmo com dados limitados

Toda série é avaliada (espaçamento entre cortes, número de cortes, compressão com perdas, série reformatada, espaçamento irregular, CBCT sem HU calibrado). O 3D é **sempre gerado**, junto com uma classificação **boa / moderada / limitada** e um aviso de que forma, espessura e medidas podem variar quando faltam informações.

Para cortes espessos (> 2 mm) a reconstrução usa **interpolação baseada em forma**: o contorno ósseo de cada corte vira um mapa de distância, e são essas distâncias que se interpolam entre os cortes. O resultado são superfícies contínuas em vez de "degraus". Cortes ausentes são preenchidos e fragmentos soltos (suporte de cabeça, ruído) são removidos.

### Reconstrução planejada a partir das imagens disponíveis

Ao abrir o exame, o app analisa **todas as séries** (orientação, espaçamento, área coberta, referencial espacial) e monta um **plano da reconstrução**, visível na barra lateral:

- **Série volumétrica fina** (≤ 1,5 mm): reconstrução direta com ela.
- **Só séries espessas, em orientações diferentes** (axial, coronal, sagital da mesma região): **fusão**. Cada série é nítida no próprio plano; em cada ponto prevalece a série cujo corte real passa mais perto. No fantoma de teste, a sobreposição com o objeto real subiu de 71% (uma série) para 88% (três séries).
- **Uma única série espessa**: interpolação baseada em forma, com aviso.

Os ajustes também saem do exame: o limiar ósseo (HU calibrado ou histograma em CBCT), a interpolação, a suavização e o limiar local de **paredes finas**. Este último fica a meio caminho entre as partes moles daquele exame e o osso, e só vale junto de osso confirmado, para manter assoalho de órbita, paredes de seio e septo sem trazer ruído. Cada escolha aparece com o motivo.

### Partes moles, vasos, nervos e glândulas

- **Filtro de tecidos** (modo Volume): pele, gordura, glândulas (aproximado), músculos, vasos com contraste, osso, dentes e metal, cada um com faixa de densidade, cor e opacidade; predefinições Osso, Osso + pele, Partes moles, Vasos e Pele.
- **Seios e vias aéreas** são segmentados (ar interno à cabeça, corte a corte), com o volume de cada espaço aéreo.
- **Vasos** só se separam em exame **com contraste** (etiqueta DICOM ou descrição como "C/C"); nesse caso o limiar ósseo sobe para 350 HU e os vasos realçados viram uma estrutura própria (aproximada: artérias e veias não são diferenciadas).
- **Nervos não aparecem na tomografia.** O canal mandibular, por onde passa o nervo alveolar inferior, é traçado manualmente na panorâmica.
- Qualquer estrutura pode ficar **transparente** para ver o que está dentro (canal, raízes, seios).

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

Site publicado: https://janioteixeiracd-cyber.github.io/Tomo-constrution/ (branch `gh-pages`, gerado com `npm run build`).

### Estrutura

- `src/core/`: processamento sem interface (leitura DICOM, montagem do volume, qualidade, interpolação, distância com sinal, componentes conexos, malha/STL, panorâmica, segmentação, realce 2D), com testes.
- `src/worker.ts`: processamento pesado em Web Worker.
- `src/ui/`: cortes (canvas), 3D (vtk.js), panorâmica, realce 2D e análise por IA (SDK da Anthropic).
- `patches/daikon+1.2.46.patch`: correções no decodificador JPEG de 12 bits (comum em TC): deslocamento de +15 HU nos valores e rejeição de bytes de preenchimento `FF FF` válidos.

### Limites conhecidos

- **Segmentação automática** é por regras de densidade e forma, não por rede neural treinada. Os dentes partem do esmalte; o metal (≥ 3000 HU em TC) tem camada própria. A mandíbula só é separada quando aparece inteira, se destaca do crânio por erosão e fica abaixo do plano oclusal. Os ossos unidos por suturas (maxila, zigomático, nasais) são separados pelo usuário com **Separar por toque** (erosão local até a parte tocada se soltar) ou **Cortar pelo plano**. O canal mandibular não é segmentado.
- **Metal**: as medidas de cada peça vêm dos eixos principais; o brilho do metal na tomografia aumenta um pouco o tamanho aparente. Perto das peças, só osso denso entra no modelo, para reduzir o "falso osso" dos artefatos. Em CBCT, o metal só é procurado quando há um pico de densidade separado do osso.
- **Medidas** em exames de cortes espessos herdam a imprecisão da interpolação. O aviso de qualidade indica quando isso acontece.
- **Análise por IA** é educacional e pode errar. Nenhum nome, ID ou data é enviado, mas o contexto digitado pelo usuário vai junto com as imagens.
