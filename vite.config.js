import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages project site: https://<user>.github.io/Vibe-Driver/
  base: '/Vibe-Driver/',
  server: {
    host: true,
    port: 5173,
    strictPort: false,
    // allow the Arena preview host (https://{port}-{sandboxId}.e2b.app)
    // Vite matches exact hosts or dot-wildcards (leading dot → subdomain suffix)
    allowedHosts: ['.e2b.app'],
  },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1200,
  },
});
