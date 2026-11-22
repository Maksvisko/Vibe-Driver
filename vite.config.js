import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages project site: https://<user>.github.io/Vibe-Driver/
  base: '/Vibe-Driver/',
  server: {
    host: true,
    port: 5173,
    strictPort: false,
  },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1200,
  },
});
