import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

// Relative base so the static build works under any GitHub Pages project path
// (https://<user>.github.io/<repo>/) as well as at a domain root.
export default defineConfig({
  base: './',
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: { port: 5173, host: true },
  preview: { port: 4173 },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules/three/')) return 'three';
          if (id.includes('node_modules/postprocessing') || id.includes('node_modules/n8ao')) return 'postfx';
          if (id.includes('node_modules/firebase') || id.includes('node_modules/@firebase')) return 'firebase';
          if (id.includes('node_modules/preact') || id.includes('node_modules/@preact')) return 'ui';
          return undefined;
        },
      },
    },
  },
});
