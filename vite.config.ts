import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';
import { accessDir, fileName, privateChunks, workerAccess } from './vite-private-chunks';

// The commit being built, shown in the account menu. Workers Builds sets WORKERS_CI_COMMIT_SHA; locally ask git.
function commit(): string {
  if (process.env.WORKERS_CI_COMMIT_SHA) return process.env.WORKERS_CI_COMMIT_SHA;
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'dev';
  }
}

const version = commit().slice(0, 7);

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // /version.json: open pages compare it with the version they run and offer to refresh (UpdateBanner).
    // Only the sign-in page is public; the rest of the app is served to signed-in sessions only.
    privateChunks(),
    { name: 'version-file', generateBundle() { this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version }) }); } },
  ],
  define: { __APP_VERSION__: JSON.stringify(version) },
  worker: {
    rollupOptions: {
      output: {
        // Web workers (CAM AI, the toolpath simulation) are private like the code that starts them.
        entryFileNames: (chunk) => fileName(workerAccess(chunk.name)),
        chunkFileNames: (chunk) => fileName(workerAccess(chunk.name)),
        // Their files (the STEP reader's WebAssembly): for everyone who may use CAM AI or the toolpath.
        assetFileNames: `${accessDir('toolpath')}/[name]-[hash][extname]`,
      },
    },
  },
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
