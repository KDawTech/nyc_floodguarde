import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base ensures assets resolve both at root (localhost / preview)
  // and on GitHub Pages subpaths (https://kdawtech.github.io/nyc_floodguarde/).
  base: './'
});
