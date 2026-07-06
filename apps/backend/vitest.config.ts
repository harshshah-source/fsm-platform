import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.{spec,e2e-spec}.ts'],
    // dotenv/config loads apps/backend/.env (DATABASE_URL) before any PrismaService boots; setup-env
    // then clears AUTOPLANT_MYSQL_* so a developer's live creds never change test behaviour (the
    // integration is designed UNSET in dev/test/CI). Order matters — dotenv loads, then we neutralize.
    setupFiles: ['reflect-metadata', 'dotenv/config', './test/setup-env.ts'],
    // globalSetup runs ONCE before any worker: it migrates + seeds the ISOLATED test database
    // (DATABASE_URL with the db name suffixed `_test`) so the suite never runs against the
    // developer's live DB, which may hold a full AutoPlant production sync (~17.9k devices) that
    // makes full-fleet recompute exceed the per-test timeout. See test/global-setup.ts.
    globalSetup: ['./test/global-setup.ts'],
    // Tests share one local Postgres with global invariants (e.g. the single in-flight
    // snapshot run guard — only one snapshot_runs row may be RUNNING system-wide). Running
    // test files in parallel makes those suites contend on that shared state, so files run
    // serially. Tests within a file already run sequentially.
    fileParallelism: false,
  },
  // SWC transform so NestJS decorators + emitDecoratorMetadata work under Vitest.
  plugins: [swc.vite()],
});
