// #130 R1 — bake build identity into the compiled dist. Runs after `tsc` (see package.json build
// chain): stamps `dist/build-info.json` from live git so a compiled run can attribute itself WITHOUT
// touching git at runtime (a dist must never resolve its identity from the repo it happens to sit in).
//
// Mirrors `gitBuildInfo` in src/build-info/build-info.ts: committer epoch (%ct) as the monotonic
// version, short SHA as fingerprint (+`-dirty` when the worktree is dirty), package.json appVersion.
// Git unavailable at build time ⇒ {0,'unstamped'} — deliberately refused against a stamped DB.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const backendRoot = join(here, '..');
const outPath = join(backendRoot, 'dist', 'build-info.json');

const git = (args) => {
  try {
    return execFileSync('git', args, { cwd: backendRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};

const appVersion = (() => {
  try {
    return JSON.parse(readFileSync(join(backendRoot, 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

function resolve() {
  const epoch = git(['show', '-s', '--format=%ct', 'HEAD']);
  const sha = git(['rev-parse', '--short', 'HEAD']);
  if (!epoch || !sha) return { version: 0, fingerprint: 'unstamped', dirty: false, appVersion };

  const status = git(['status', '--porcelain']);
  const dirty = status !== null && status.length > 0;
  return { version: Number(epoch), fingerprint: dirty ? `${sha}-dirty` : sha, dirty, appVersion };
}

const info = resolve();
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(info, null, 2)}\n`);
console.log(`[stamp-build-info] wrote ${outPath}: v${info.version} ${info.fingerprint}`);
