/**
 * Vite build for the admin console.
 * - Dev server proxies /api to the local API so cookies stay same-origin.
 * - Production build emits hashed assets with no inline scripts (strict CSP in nginx).
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: process.env.API_URL ?? 'http://127.0.0.1:8080', changeOrigin: false } }
  },
  // `vite preview` serves the production build with the same proxy (used by the e2e tests).
  preview: {
    port: 4173,
    strictPort: true,
    proxy: { '/api': { target: process.env.API_URL ?? 'http://127.0.0.1:8080', changeOrigin: false } }
  },
  build: {
    sourcemap: false,
    // Keep module preload polyfill out: it injects an inline script that a strict CSP would block.
    modulePreload: { polyfill: false }
  }
});
