import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url));

// Stamp the service worker's cache name with the build time so every deploy
// invalidates the old cache automatically — no manual version bumping.
// Files in public/ are copied verbatim and bypass the bundle graph, so we
// rewrite the emitted dist/sw.js directly after the build completes.
function swCacheBust() {
  const buildId = Date.now().toString(36);
  return {
    name: 'sw-cache-bust',
    apply: 'build',
    closeBundle() {
      const swPath = resolve(__dirname, 'dist', 'sw.js');
      if (existsSync(swPath)) {
        const src = readFileSync(swPath, 'utf8');
        writeFileSync(swPath, src.replace(/__BUILD_ID__/g, buildId));
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), swCacheBust()],
  base: '/meal-prep-test/',
})
