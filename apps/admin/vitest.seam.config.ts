import { defineConfig } from 'vitest/config';

/**
 * #107 N3 — the admin→backend seam suite. Separate from `vite.config.ts` on purpose.
 *
 * These tests need a **running backend**, so they must not be part of `pnpm test`: a suite that goes
 * red whenever you have not started one gets ignored, and an ignored suite is worse than none. They
 * run as their own CI step, which boots the backend first (see `.github/workflows/ci.yml` and
 * `docs/ci-pipeline.md`).
 *
 * `environment: 'node'` rather than the default suite's jsdom — this exercises the client's real
 * `fetch` against a real socket, and jsdom's fetch/CORS emulation would be one more thing standing
 * between the test and the seam it is supposed to be measuring.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/seam/**/*.seam.test.ts'],
  },
});
