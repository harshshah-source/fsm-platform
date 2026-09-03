import { authHeaders } from './authHeaders';
import { intradayQueryString, type IntradayQuery } from './intradayInsertions';
// Typed client for the Intra-day Queue's ZM manual same-day updates (Issue 31) — MANUAL_ZM_UPDATE
// audit rows (ADD / REMOVE / REORDER), zone-scoped server-side (ZM own-zone; CSM / Operations Head all
// zones). The system-triggered CRITICAL insertions are the other stream (`intradayInsertions.ts`); the
// page merges the two.
//
// #356 — read-only, and bounded. The three same-day write routes this file might once have wrapped
// (`POST /intraday-updates/add|remove|reorder`) never had an admin client at all: #313 made
// `POST /batches/:id/override` the single same-day write surface before anything here needed them, and
// they are deleted server-side by this slice. The read is now a page: the backend loaded every
// MANUAL_ZM_UPDATE row ever written to answer it.

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';

export type IntradayUpdateType = 'ADD' | 'REMOVE' | 'REORDER';

export interface IntradayUpdateRow {
  auditId: string;
  actorId: string;
  actorRole: string;
  updateType: IntradayUpdateType;
  ticketId: string | null;
  seId: string | null;
  createdAt: string;
}

export interface IntradayUpdatePage {
  rows: IntradayUpdateRow[];
  nextCursor: string | null;
  limit: number;
}

/** `status` is meaningless on this stream (an audit row has an update type, not a status). */
export type IntradayUpdateQuery = Omit<IntradayQuery, 'status'>;

export async function apiIntradayUpdates(query: IntradayUpdateQuery = {}): Promise<IntradayUpdatePage> {
  const res = await fetch(`${BASE_URL}/intraday-updates${intradayQueryString(query)}`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as IntradayUpdatePage;
}
