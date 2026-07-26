import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Proxies /api/* to the Express backend in dev so the browser never has to
// deal with CORS during local development — the backend's own CORS
// middleware (see backend/src/app.js) exists for non-proxied deployments
// (a static build served from a different origin than the API).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET || 'http://localhost:4000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
