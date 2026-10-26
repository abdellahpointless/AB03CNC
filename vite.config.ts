import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';

// The commit being built, shown in the account menu. Workers Builds sets WORKERS_CI_COMMIT_SHA; locally ask git.
function commit(): string {
  if (process.env.WORKERS_CI_COMMIT_SHA) return process.env.WORKERS_CI_COMMIT_SHA;
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'dev';
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { __APP_VERSION__: JSON.stringify(commit().slice(0, 7)) },
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
