import { defineConfig, type Plugin } from 'vite';

/**
 * O daikon carrega seus submódulos com `typeof require !== 'undefined' ? require(...) : null`.
 * No bundle de produção `require` não existe em tempo de execução, então tudo vira null.
 * Como o empacotador já resolve os require(), a guarda pode ser sempre verdadeira.
 */
function daikonRequireGuard(): Plugin {
  return {
    name: 'daikon-require-guard',
    transform(code, id) {
      if (!/node_modules[\\/]daikon[\\/]src[\\/]/.test(id)) return null;
      return { code: code.replaceAll("(typeof require !== 'undefined')", '(true)'), map: null };
    },
  };
}

export default defineConfig({
  // caminhos relativos permitem publicar em qualquer subpasta (ex.: GitHub Pages)
  base: './',
  plugins: [daikonRequireGuard()],
  worker: {
    format: 'es',
    plugins: () => [daikonRequireGuard()],
  },
  build: {
    chunkSizeWarningLimit: 2000,
  },
});
