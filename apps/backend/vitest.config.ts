import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.{spec,e2e-spec}.ts'],
    // dotenv/config loads apps/backend/.env (DATABASE_URL) before any PrismaService boots.
    setupFiles: ['reflect-metadata', 'dotenv/config'],
    // Tests share one local Postgres with global invariants (e.g. the single in-flight
    // snapshot run guard — only one snapshot_runs row may be RUNNING system-wide). Running
    // test files in parallel makes those suites contend on that shared state, so files run
    // serially. Tests within a file already run sequentially.
    fileParallelism: false,
  },
  // SWC transform so NestJS decorators + emitDecoratorMetadata work under Vitest.
  plugins: [swc.vite()],
});
