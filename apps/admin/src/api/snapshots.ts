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
