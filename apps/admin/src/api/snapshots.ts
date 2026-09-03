import { authHeaders } from './authHeaders';
// Typed client for the snapshot freshness endpoint (Issue 04). Mirrors the backend
// `SnapshotLatestView`; the token comes from the same sessionStorage key AuthProvider writes.
// #300 added the wedged-pipeline state (`ingestion`) and the labelled PARTIAL watermark, so the
// banner can say WHY freshness has stopped advancing instead of just showing an ageing timestamp.

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';

export type SnapshotStatus = 'RUNNING' | 'SUCCESS' | 'FAILED' | 'PARTIAL';

export interface SnapshotRunView {
  runId: string;
  status: SnapshotStatus;
  startedAt: string;
  finishedAt: string | null;
  dataAsOf: string | null;
  /**
   * #348 — why the run ended, when it recorded a reason (`ORPHANED_RUN_ERROR` for a run the heartbeat
   * reaper closed; null for a run that ended on its own, and for every row written before the column
   * existed). Without it a process restart and a real ingestion failure are the same bare FAILED row.
   */
  error: string | null;
}

export interface IngestionFailingChunk {
  runId: string;
  chunkNo: number;
  retryCount: number;
  error: string | null;
}

/** #300 — mirrors the backend `IngestionAlertHealth`; shared by the banner and the health card. */
export interface IngestionAlertHealth {
  /** Consecutive most-recent finalized snapshot runs that did not finalize SUCCESS. */
  streak: number;
  threshold: number;
  alert: boolean;
  latestStatus: SnapshotStatus | null;
  /** The last finalized run was not SUCCESS, so #230 skipped every stage in `gatedStages`. */
  downstreamGated: boolean;
  gatedStages: string[];
  failingChunk: IngestionFailingChunk | null;
  repeatingFailure: boolean;
  rejected: Record<string, number>;
  repaired: Record<string, number>;

  // ---- #348: silence. Everything above counts runs that HAPPENED; a stopped cron produces none. ----

  /** Whole minutes since the newest SUCCESS run; null when there is none on record. */
  silenceMinutes: number | null;
  /** The scheduler's configured interval, derived from its cron. */
  expectedCadenceMinutes: number;
  /** `expectedCadenceMinutes × 2` — the age {@link overdue} is decided at. */
  overdueAfterMinutes: number;
  /** The scheduler master switch is off: stopped on purpose, so nothing alerts — but nothing is fresh. */
  schedulerPaused: boolean;
  /** No SUCCESS run inside {@link overdueAfterMinutes} while the scheduler is meant to be running. */
  overdue: boolean;
}

export interface SnapshotLatestView {
  /** Freshness shown by the banner — from the last SUCCESS run. */
  dataAsOf: string | null;
  lastSuccessAt: string | null;
  /** Most recent run of any status — drives the red alert on FAILED/stuck. */
  latest: SnapshotRunView | null;
  /** #300 / F10 — newest PARTIAL run's watermark when ahead of `dataAsOf`; shown under its own name. */
  partialDataAsOf: string | null;
  /** #300 — the wedged-pipeline state; the banner must never claim freshness while this is gated. */
  ingestion: IngestionAlertHealth;
  /**
   * #348 — ingestion has gone SILENT: no SUCCESS run inside twice the configured cadence while the
   * scheduler is supposed to be running. Top level next to `dataAsOf` because it is a verdict about
   * *this timestamp*, so a consumer can decide "do not present this as freshness" without reading
   * into `ingestion`.
   */
  overdue: boolean;
  /** #348 — the scheduler is deliberately disabled: "paused", never "healthy". */
  schedulerPaused: boolean;
}

export async function apiSnapshotLatest(): Promise<SnapshotLatestView> {
  const res = await fetch(`${BASE_URL}/snapshots/latest`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    throw new Error(`REQUEST_FAILED_${res.status}`);
  }
  return (await res.json()) as SnapshotLatestView;
}

/** Page + status filter for {@link apiSnapshotRuns}; all optional, matching the route's defaults. */
export interface SnapshotRunsQuery {
  limit?: number;
  offset?: number;
  /** One of {@link SnapshotStatus}; anything else is ignored server-side and returns every status. */
  status?: string;
}

/**
 * `GET /api/snapshots/runs` (OPERATIONS_HEAD) — the paged run history.
 *
 * #349: this route has existed, guarded and paged, since Issue 04 slice 7 and had **no consumer at
 * all** until the Integration Health page's run-history table. It returns a bare array — there is no
 * total on the wire — so a caller pages by asking for `limit` and treating a short page as the last
 * one, which is what the table's pager does.
 */
export async function apiSnapshotRuns(query: SnapshotRunsQuery = {}): Promise<SnapshotRunView[]> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.offset !== undefined) params.set('offset', String(query.offset));
  if (query.status) params.set('status', query.status);
  const qs = params.toString();

  const res = await fetch(`${BASE_URL}/snapshots/runs${qs ? `?${qs}` : ''}`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    throw new Error(`REQUEST_FAILED_${res.status}`);
  }
  const body = (await res.json()) as unknown;
  // Defensive for the same reason the health sections are: a shape change on this route must degrade
  // to an empty table, never take the whole page down with `undefined.map`.
  return Array.isArray(body) ? (body as SnapshotRunView[]) : [];
}
