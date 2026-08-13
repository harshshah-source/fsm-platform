import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Probes — checks that run against the developer's LIVE dev database rather than `fsm_test`.
 *
 * A separate config, and separate on purpose. `vitest.config.ts` exists to guarantee the suite can
 * never touch a live database: it points `DATABASE_URL` at the `_test` suffix, migrates and seeds it,
 * and sanitises the app's env namespace (#182). Everything about that is right and none of it is
 * relaxed here — a probe simply is not a test. It asserts properties of a mutating AutoPlant mirror,
 * so it cannot be a green/red gate and must never be collected by the default run.
 *
 * The two are kept apart by directory and extension: the suite collects `**\/*.{spec,e2e-spec}.ts`
 * and probes are `test/probes/*.probe.ts`, which that glob cannot match.
 *
 *   pnpm --filter backend exec vitest run --config vitest.probe.config.ts
 *
 * Why they exist at all: #232 carried an acceptance criterion to "validate against live `fsm`". It sat
 * unexecuted for three days behind 35 green fixture tests, and when finally run it was the defect
 * report for #233 — a missing operational-fleet predicate that no fixture could have caught, because
 * every fixture device was operational. A probe is the cheap way to keep that criterion executable
 * instead of aspirational.
 *
 * No `globalSetup` (nothing to migrate or seed — the database is already real) and no `setup-env`
 * allowlist (the point is to run against the developer's actual configuration).
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/probes/**/*.probe.ts'],
    setupFiles: ['reflect-metadata', 'dotenv/config'],
    fileParallelism: false,
  },
  plugins: [swc.vite()],
});
