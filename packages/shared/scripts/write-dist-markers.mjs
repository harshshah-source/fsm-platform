// Writes per-directory `package.json` "type" markers into the dual build output. The published
// package root is `"type": "commonjs"`, so without these markers Node would parse the ESM output
// (dist/esm/*.js) as CommonJS and choke on `export` syntax. The markers scope each folder:
//   dist/esm → ESM (real `export const` — what Vite/admin consume via the `import` condition)
//   dist/cjs → CommonJS (`exports.X =` — what the NestJS backend consumes via `require`)
import { mkdirSync, writeFileSync } from 'node:fs';

const targets = [
  ['../dist/esm/package.json', { type: 'module' }],
  ['../dist/cjs/package.json', { type: 'commonjs' }],
];

for (const [rel, body] of targets) {
  const url = new URL(rel, import.meta.url);
  mkdirSync(new URL('.', url), { recursive: true });
  writeFileSync(url, `${JSON.stringify(body, null, 2)}\n`);
}
