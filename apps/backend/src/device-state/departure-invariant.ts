import type { RawSqlClient } from '../build-info/runtime-lock';

/**
 * #130 L2 decision 4 — the recompute invariant, the machine-checkable form of the property hand-
 * verified on 2026-07-19: every device with an ACTIVE `device_departures` row (`restored_at IS NULL`)
 * must, after a recompute, show `is_departed=true` AND be excluded from `is_inactive` /
 * `eligible_for_uptime` / `sla_bucket`. Any device violating this — a departed device somehow still
 * marked operational — is exactly the run-65 corruption shape. Runs inside the same transaction as
 * the recompute UPDATE (`DeviceStateService.recompute`): a nonzero count throws, which rolls back the
 * UPDATE atomically (rollback-and-throw, not log-and-alert — L2 is the hard-fail layer; L5's canary
 * warns on softer swings elsewhere).
 */
export async function assertDepartureInvariant(tx: RawSqlClient): Promise<void> {
  const rows = await tx.$queryRawUnsafe<Array<{ violations: string }>>(`
    SELECT COUNT(*)::text AS violations
    FROM device_states ds
    JOIN device_departures dd ON dd.device_id = ds.device_id AND dd.restored_at IS NULL
    WHERE ds.is_departed = false
       OR ds.is_inactive = true
       OR ds.eligible_for_uptime = true
       OR ds.sla_bucket IS NOT NULL
  `);
  const violations = Number(rows[0]?.violations ?? 0);
  if (violations > 0) {
    throw new Error(
      `FATAL recompute-invariant violated: ${violations} device(s) have an ACTIVE device_departures ` +
        `row yet device_states shows is_departed=false OR is_inactive OR eligible_for_uptime OR a ` +
        `non-null sla_bucket after recompute — the run-65 corruption shape. Rolling back this recompute.`,
    );
  }
}
