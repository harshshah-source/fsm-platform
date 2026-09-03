// Typed client for the AutoPlant integration-health surface (`GET /api/integration/health`,
// OPERATIONS_HEAD-only). #130 added build attribution (which build produced each run + a staleBuild
// flag against the current runtime-lock high-water mark) and the last-N device-state recompute
// history with the semantic-canary swing flag. Mirrors the backend `IntegrationHealth`.
//
// #349 — it now mirrors it in full. This type modelled four of the payload's ten sections, and a
// section this file does not name is a section the page cannot render: source connectivity, both
// freshness ages, reconciliation and the #218 lifecycle check were all computed, returned, and
// dropped on the floor here. #348's freshness verdict (`stale` / `staleAfterMinutes`) and the
// scheduler switch land here too, rather than being re-declared inside whichever component needs
// them next — one declaration, so two surfaces cannot read the same payload differently.

import type { IngestionAlertHealth } from './snapshots';
import { authHeaders } from './authHeaders';

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';

export interface RunBuildStamp {
  buildVersion: string | null;
  buildFingerprint: string | null;
  /** This run was produced by a build below the current runtime-lock version (a stale-build run). */
  staleBuild: boolean;
}

export interface RuntimeLockHealth {
  version: string | null;
  fingerprint: string | null;
}

export interface RecomputeLedgerEntry {
  recomputeId: string;
  computedAt: string;
  eligibleCount: number;
  inactiveCount: number;
  departedCount: number;
  totalCount: number;
  buildVersion: string | null;
  buildFingerprint: string | null;
  trigger: string;
  staleBuild: boolean;
  /** Relative eligible swing vs the previous row; null for the oldest row in the window. */
  swingPct: number | null;
  /** |swingPct| exceeded the canary threshold — the row an operator should investigate. */
  swing: boolean;
}

/**
 * The subset of the backend `IntegrationHealth` this client reads (build attribution + canary, and
 * since #300 the wedged-ingestion alert). Re-exported from `snapshots.ts` rather than redeclared —
 * the banner and this card render the same backend derivation, and two copies of the type would be
 * the first step towards two different reads of it.
 */
export type { IngestionAlertHealth, IngestionFailingChunk } from './snapshots';

/** AutoPlant source reachability — the "is the VPN up" half of the page. */
export interface IntegrationSourceHealth {
  /** The two-schema AutoPlant env is set — distinguishes a dev/test "unset" from a live outage. */
  configured: boolean;
  connected: boolean;
  vehicleRows?: number;
  error?: string;
}

/**
 * One feed's freshness. `ageMinutes` was computed by the backend from the start and compared with
 * nothing anywhere, which is how a 21-hour-old snapshot rendered as an ordinary timestamp; #348 added
 * the verdict and the yardstick it is measured against, and both are carried here so a surface can
 * state the number it judged rather than asserting "stale" with no figure.
 */
export interface FreshnessHealth {
  /** High-water instant of the last good run (master: `finishedAt`; snapshot: `dataAsOf`). */
  lastAt: string | null;
  /** Status of the most recent run of any outcome. */
  lastStatus: string | null;
  ageMinutes: number | null;
  /** #348 — twice this feed's configured cron cadence; the age `stale` is decided at. */
  staleAfterMinutes: number;
  /** #348 — past `staleAfterMinutes`, or no good run at all. False while the scheduler is paused. */
  stale: boolean;
  /** #130 L3 — build attribution of the most recent run (null when it predates stamping). */
  build: RunBuildStamp | null;
}

export interface ReconciliationEntity {
  entity: string;
  sourceCount: number;
  fsmCount: number;
  /** `sourceCount - fsmCount` — positive means FSM mirrors less than the source holds. */
  drift: number;
}

export interface ReconciliationHealth {
  entities: ReconciliationEntity[];
  /** `null` when the counts are unavailable (AutoPlant unconfigured / source down). */
  reconciled: boolean | null;
  maxDriftAllowed: number;
  error?: string;
}

/**
 * #129/#349 — one master-sync run's lifecycle churn: what it moved, and what that cost in open work.
 *
 * `entity_stats.departures` has recorded the first two numbers per run since #128 and
 * `device_departures.cancelled_tickets_count` the third; nothing read any of them back out, so a
 * departure that cancelled a technician's open tickets was audited and invisible.
 */
export interface LifecycleRunEntry {
  runId: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  /** Departures opened by this run. */
  departed: number;
  /** Active departures this run closed because the device came back. */
  restored: number;
  /** Open tickets auto-closed by the departures this run detected. */
  ticketsAutoClosed: number;
  /** Itemised no-ops from the lifecycle pass (`ABSENCE_GUARD_TRIPPED`, `RECONCILE_FAILED`). */
  skippedByReason: Record<string, number>;
  /** The pass ran and moved nothing — the #218 signal, per run. */
  quiet: boolean;
}

/**
 * #218 — deployment-lifecycle self-consistency, and #224's missing screen for it. Derived entirely
 * inside Postgres, so it stays readable exactly when the source is unreachable.
 */
export interface LifecycleHealth {
  /**
   * Devices whose last-observed source status and derived departure flag contradict each other.
   * **The correct value is 0** — this is a defect count by construction, never a tolerance band.
   */
  drift: number;
  /** Departed because their source row vanished: knowingly stale, excluded from `drift`, never folded in. */
  missingFromSource: number;
  /** Consecutive most-recent SUCCESS master syncs that recorded neither a departure nor a restore. */
  quietRuns: number;
  quietRunsAlert: boolean;
  quietRunsThreshold: number;
  healthy: boolean;
  /** #349 — per-run churn, newest first. */
  runs: LifecycleRunEntry[];
}

export interface IntegrationHealthView {
  /** Source connectivity — configured, reachable, and the row count the probe read. */
  source: IntegrationSourceHealth;
  masterSync: FreshnessHealth;
  snapshot: FreshnessHealth;
  /** Source-vs-FSM row counts. Drilled into on the OH Ops Explorer's reconciliation panel. */
  reconciliation: ReconciliationHealth;
  /** #218/#224 — lifecycle self-consistency; needs no VPN, so it survives a source outage. */
  lifecycle: LifecycleHealth;
  runtimeLock: RuntimeLockHealth;
  recomputes: RecomputeLedgerEntry[];
  /** #300 — consecutive non-SUCCESS telemetry runs, the failing chunk, and the gated-off stages. */
  ingestion: IngestionAlertHealth;
  /**
   * #348 — the ingestion scheduler master switch. False means the crons are dormant by choice, which
   * is why every `stale` flag above is suppressed: the page says "ingestion paused", never "healthy".
   */
  schedulerEnabled: boolean;
  checkedAt: string;
}

export async function apiIntegrationHealth(): Promise<IntegrationHealthView> {
  const res = await fetch(`${BASE_URL}/integration/health`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as IntegrationHealthView;
}
