import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173 },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    // #107 N3 — the seam suite needs a RUNNING backend, so it is not part of `pnpm test`; it has its
    // own config and CI step (vitest.seam.config.ts). Keeping vitest's own defaults here rather than
    // passing --exclude on the CLI, which REPLACES them and would sweep node_modules back in.
    exclude: ['**/node_modules/**', '**/dist/**', 'test/seam/**'],
    css: true,
  },
});
