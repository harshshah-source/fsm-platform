import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

/**
 * #130 L1/L3 — build identity. A single struct describing "which build is this process", resolved
 * once at boot and threaded into the version lock (`assertBuildNotStale`) and the run ledger stamps.
 *
 * The resolver (below) is deliberately a checked-in loader + a baked JSON — NOT a generated `.ts`
 * under `src/generated/` (gitignored: would break vitest/tsc/fresh clones). See issue #130 R1.
 */
export interface BuildInfo {
  /**
   * Monotonic high-water key: the git committer epoch of HEAD (`git show -s --format=%ct`). Newer
   * commit ⇒ larger epoch across branches, no hand-editing, no CI. `0` when the build is unstamped.
   */
  version: number;
  /**
   * Commit SHA that produced this build, or a sentinel when git identity is unavailable:
   * `'unstamped'` (a compiled dist with no baked `build-info.json`) or `'dev'` (a source run with no
   * git). A build made from a dirty worktree carries a `-dirty` suffix; see `dirty`.
   */
  fingerprint: string;
  /** True when built from a dirty worktree (source-run `git status --porcelain` was non-empty). */
  dirty: boolean;
  /** package.json version — human-readable only (the stale-build badge), never a comparison key. */
  appVersion: string;
}

/** A compiled dist with no baked stamp — refuses against a stamped (production) DB. */
const UNSTAMPED: Omit<BuildInfo, 'appVersion'> = { version: 0, fingerprint: 'unstamped', dirty: false };

/**
 * Compiled-run resolution: parse the baked `dist/build-info.json`. Any absence/corruption yields
 * `{0,'unstamped'}` — deliberately refused against a stamped DB. We NEVER fall back to live git from
 * a dist: a stale dist running inside the repo would otherwise misattribute itself as HEAD (the exact
 * July-19 process, which ran from the repo). See issue #130 R1.
 */
export function parseBakedBuildInfo(raw: string | null): BuildInfo {
  if (!raw) return { ...UNSTAMPED, appVersion: '0.0.0' };
  try {
    const parsed = JSON.parse(raw) as Partial<BuildInfo>;
    if (typeof parsed.version !== 'number' || typeof parsed.fingerprint !== 'string') {
      return { ...UNSTAMPED, appVersion: '0.0.0' };
    }
    return {
      version: parsed.version,
      fingerprint: parsed.fingerprint,
      dirty: parsed.dirty === true,
      appVersion: typeof parsed.appVersion === 'string' ? parsed.appVersion : '0.0.0',
    };
  } catch {
    return { ...UNSTAMPED, appVersion: '0.0.0' };
  }
}

/** A thin git runner — returns trimmed stdout, or null when git/HEAD is unavailable. */
export type GitRunner = (args: string[]) => string | null;

/**
 * Source-run resolution (ts-node / vitest / tsx): stamp from live git — committer epoch (`%ct`) as
 * the monotonic version, short SHA as fingerprint, `git status --porcelain` for the dirty flag. Git
 * unavailable ⇒ `{0,'dev'}` (a legitimate dev run with no git, not a production dist).
 */
export function gitBuildInfo(run: GitRunner, appVersion: string): BuildInfo {
  const epoch = run(['show', '-s', '--format=%ct', 'HEAD']);
  const sha = run(['rev-parse', '--short', 'HEAD']);
  if (!epoch || !sha) return { version: 0, fingerprint: 'dev', dirty: false, appVersion };

  const status = run(['status', '--porcelain']);
  const dirty = status !== null && status.length > 0;
  return {
    version: Number(epoch),
    fingerprint: dirty ? `${sha}-dirty` : sha,
    dirty,
    appVersion,
  };
}

const execGit: GitRunner = (args) => {
  try {
    return execFileSync('git', args, { cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};

function readAppVersion(): string {
  try {
    const pkg = readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8');
    return (JSON.parse(pkg) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

let cached: BuildInfo | undefined;

/**
 * Resolve this process's build identity once, memoized. Compiled run (`dist/*.js`) reads the baked
 * JSON; source run derives from live git. The compiled/source split is `__filename`'s extension.
 */
export function getBuildInfo(): BuildInfo {
  if (cached) return cached;

  const isCompiled = !__filename.endsWith('.ts');
  if (isCompiled) {
    let raw: string | null = null;
    try {
      raw = readFileSync(path.join(__dirname, '..', 'build-info.json'), 'utf8');
    } catch {
      raw = null; // missing baked JSON ⇒ unstamped (never fall back to git from a dist)
    }
    cached = parseBakedBuildInfo(raw);
  } else {
    cached = gitBuildInfo(execGit, readAppVersion());
  }
  return cached;
}
