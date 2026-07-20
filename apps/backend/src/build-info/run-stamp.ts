import { getBuildInfo } from './build-info';

/**
 * #130 L3 — the build-attribution columns to stamp on a pipeline run (or a recompute ledger row) at
 * creation. `build_version` is the monotonic committer epoch (BIGINT), `build_fingerprint` the SHA
 * sentinel. Later, a run whose `build_version < runtime_lock.version` renders a stale-build badge.
 */
export function buildStampFields(): { buildVersion: bigint; buildFingerprint: string } {
  const info = getBuildInfo();
  return { buildVersion: BigInt(info.version), buildFingerprint: info.fingerprint };
}
