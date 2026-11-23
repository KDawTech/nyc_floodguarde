import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base ensures assets resolve both at root (localhost / preview)
  // and on GitHub Pages subpaths (https://kdawtech.github.io/nyc_floodguarde/).
  base: './',
  server: {
    // Disable HMR WebSocket when DISABLE_HMR=true (e.g., preview proxy environments
    // that do not forward Vite's dev HMR WebSocket), while keeping HMR active locally.
    hmr: process.env.DISABLE_HMR !== 'true'
  }
});
