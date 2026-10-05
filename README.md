# TomoRecon 3D

Aplicação web para **estudo de casos de cirurgia bucomaxilofacial**: abre tomografias (TC e CBCT) em DICOM, mostra os cortes axial, coronal e sagital, gera a **reconstrução 3D óssea de cabeça e face** e realça radiografias e fotos de baixa qualidade.

> **Uso educacional.** A ferramenta não tem finalidade diagnóstica, não é registrada como dispositivo médico e não substitui o laudo do exame. Confirme sempre qualquer achado nos cortes originais.

## O que faz

| Aba | Recursos |
| --- | --- |
| **Cortes** | Axial, coronal e sagital sincronizados; janelas Osso, Partes moles, Seios/ar e Dentes/metal; ajuste de janela por arraste; régua em mm; leitura de densidade (HU). |
| **3D** | Superfície óssea (malha) ou renderização volumétrica (Osso, Osso + pele, Pele); vistas padrão; corte do modelo por plano; **medidas no modelo** (distância, ângulo, pontos de referência); **segmentação** de crânio/maxila, mandíbula e dentes com STL de cada estrutura; exportação **STL** e PNG. |
| **Panorâmica** | Toque pontos ao longo do arco no axial para gerar a **panorâmica reconstruída** (média ou MIP, espessura ajustável) e **cortes transversais** com régua para altura e espessura óssea. |
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

- **Segmentação** é por regras de densidade e forma, não por rede neural treinada. Os dentes são identificados a partir do esmalte e das restaurações (as densidades mais altas). A mandíbula só é separada quando aparece inteira e se destaca do crânio por erosão. O canal mandibular não é segmentado.
- **Medidas** em exames de cortes espessos herdam a imprecisão da interpolação. O aviso de qualidade indica quando isso acontece.
- **Análise por IA** é educacional e pode errar. Nenhum nome, ID ou data é enviado, mas o contexto digitado pelo usuário vai junto com as imagens.
