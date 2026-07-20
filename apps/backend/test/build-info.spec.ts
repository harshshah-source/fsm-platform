import { describe, expect, it } from 'vitest';
import { getBuildInfo, gitBuildInfo, parseBakedBuildInfo, type GitRunner } from '../src/build-info/build-info';

/**
 * #130 R1 — build-identity resolution. The two branches (compiled: baked JSON; source: live git) are
 * factored into pure helpers so they can be tested deterministically regardless of this box's real
 * (routinely dirty) worktree.
 */
describe('parseBakedBuildInfo — compiled-run branch', () => {
  it('treats a missing baked JSON as unstamped (refused against a stamped DB)', () => {
    expect(parseBakedBuildInfo(null)).toMatchObject({ version: 0, fingerprint: 'unstamped', dirty: false });
  });

  it('treats corrupt JSON as unstamped', () => {
    expect(parseBakedBuildInfo('}{ not json')).toMatchObject({ version: 0, fingerprint: 'unstamped' });
  });

  it('treats structurally-wrong JSON (missing keys) as unstamped', () => {
    expect(parseBakedBuildInfo('{"foo":1}')).toMatchObject({ version: 0, fingerprint: 'unstamped' });
  });

  it('parses a valid baked stamp, coercing dirty', () => {
    const raw = JSON.stringify({ version: 1721000000, fingerprint: 'abc1234', dirty: true, appVersion: '0.0.1' });
    expect(parseBakedBuildInfo(raw)).toEqual({
      version: 1721000000,
      fingerprint: 'abc1234',
      dirty: true,
      appVersion: '0.0.1',
    });
  });
});

describe('gitBuildInfo — source-run branch', () => {
  const runnerFor = (map: Record<string, string | null>): GitRunner => (args) => map[args.join(' ')] ?? null;

  it('stamps version=committer-epoch, fingerprint=short-sha on a clean tree', () => {
    const run = runnerFor({
      'show -s --format=%ct HEAD': '1721000000',
      'rev-parse --short HEAD': 'abc1234',
      'status --porcelain': '',
    });
    expect(gitBuildInfo(run, '0.0.1')).toEqual({
      version: 1721000000,
      fingerprint: 'abc1234',
      dirty: false,
      appVersion: '0.0.1',
    });
  });

  it('marks a dirty worktree with a -dirty fingerprint suffix', () => {
    const run = runnerFor({
      'show -s --format=%ct HEAD': '1721000000',
      'rev-parse --short HEAD': 'abc1234',
      'status --porcelain': ' M src/foo.ts',
    });
    expect(gitBuildInfo(run, '0.0.1')).toMatchObject({ fingerprint: 'abc1234-dirty', dirty: true });
  });

  it('falls back to {0,dev} when git/HEAD is unavailable (legit dev run, not a dist)', () => {
    const run: GitRunner = () => null;
    expect(gitBuildInfo(run, '0.0.1')).toEqual({ version: 0, fingerprint: 'dev', dirty: false, appVersion: '0.0.1' });
  });
});

describe('getBuildInfo — end to end under vitest (a source run)', () => {
  it('self-stamps from live git: real epoch version and a sha fingerprint', () => {
    const info = getBuildInfo();
    // Under vitest __filename ends with .ts → source branch → live git of this (dirty) repo.
    expect(info.version).toBeGreaterThan(1_000_000_000);
    expect(info.fingerprint).not.toBe('unstamped');
    expect(info.fingerprint).not.toBe('dev');
  });
});
