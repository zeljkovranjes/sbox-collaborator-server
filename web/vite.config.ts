import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { fileURLToPath } from 'node:url';

const target = process.env.COLLAB_DEV_SERVER ?? 'http://localhost:8080';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [preact()],
  build: { outDir: fileURLToPath(new URL('../dist/web', import.meta.url)), emptyOutDir: true, sourcemap: false },
  server: {
    port: 5173,
    proxy: {
      '/api': { target, changeOrigin: false },
      '/auth': { target, changeOrigin: false },
      '/healthz': { target },
    },
  },
});
