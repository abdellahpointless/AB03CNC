import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Keep the big chart library out of the main bundle (only admins see charts).
        manualChunks: {
          motion: ['motion'],
        },
      },
    },
  },
  server: {
    // `npm run dev` serves the UI; API calls go to `npm run dev:api` (wrangler dev on :8787).
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
});
