// Typed client for OH raw-data exports (Issue 120, `/api/exports`). The summary drives the card's
// row-count/freshness hint; the download fetches the streamed CSV with auth headers and reuses the
// shared `downloadCsv` trigger (server-generated body, so we pass the text straight through).

import { authHeaders } from './authHeaders';
import { downloadCsv } from '../lib/csv';

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';

export interface EntityMappingSummary {
  rowCount: number;
  /** Freshness of the underlying device snapshot (max computed_at), or null when empty. */
  dataAsOf: string | null;
}

export async function apiEntityMappingSummary(): Promise<EntityMappingSummary> {
  const res = await fetch(`${BASE_URL}/exports/entity-mapping/summary`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as EntityMappingSummary;
}

/** Fetches the streamed CSV (bearer-authed, so a plain <a href> won't do) and triggers the download. */
export async function downloadEntityMappingCsv(): Promise<void> {
  const res = await fetch(`${BASE_URL}/exports/entity-mapping`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  const disposition = res.headers.get('content-disposition') ?? '';
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'entity-mapping.csv';
  downloadCsv(filename, await res.text());
}
