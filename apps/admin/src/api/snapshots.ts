// Typed client for the snapshot freshness endpoint (Issue 04). Mirrors the backend
// `SnapshotLatestView`; the token comes from the same sessionStorage key AuthProvider writes.

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';
const TOKEN_KEY = 'fsm.accessToken';

export type SnapshotStatus = 'RUNNING' | 'SUCCESS' | 'FAILED' | 'PARTIAL';

export interface SnapshotRunView {
  runId: string;
  status: SnapshotStatus;
  startedAt: string;
  finishedAt: string | null;
  dataAsOf: string | null;
}

export interface SnapshotLatestView {
  /** Freshness shown by the banner — from the last SUCCESS run. */
  dataAsOf: string | null;
  lastSuccessAt: string | null;
  /** Most recent run of any status — drives the red alert on FAILED/stuck. */
  latest: SnapshotRunView | null;
}

export async function apiSnapshotLatest(): Promise<SnapshotLatestView> {
  const token = sessionStorage.getItem(TOKEN_KEY);
  const res = await fetch(`${BASE_URL}/snapshots/latest`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    throw new Error(`REQUEST_FAILED_${res.status}`);
  }
  return (await res.json()) as SnapshotLatestView;
}
