// Typed client for the system-triggered intra-day CRITICAL insertion ledger (Issues 29/30, retired to
// direct-assignment by #268). Reads `intraday_insertions` rows: `ASSIGNED_DIRECT` (the sweep assigned
// the ticket directly) and `ESCALATION_REQUIRED` (no capacity-eligible SE — a ZM alert also fired).
// Zone-scoped server-side (ZM own-zone; CSM / Operations Head all zones), same as `/intraday-updates`.
//
// #268 closes a gap #197's audit found: this data source existed and was never bound into the admin
// Intra-day Queue page (FE-13's own docstring said the binding would land "with Issue 29" and it never
// did — zero `intraday-insertions` references in `apps/admin` before this file). `IntradayQueuePage`
// merges these rows with the ZM manual-update rows into one table.

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';
const TOKEN_KEY = 'fsm.accessToken';

function authHeaders(): Record<string, string> {
  const token = sessionStorage.getItem(TOKEN_KEY);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export type IntradayInsertionStatus =
  | 'PENDING_ACCEPTANCE'
  | 'ACCEPTED'
  | 'DECLINED'
  | 'TIMED_OUT'
  | 'ESCALATION_REQUIRED'
  | 'ASSIGNED_DIRECT';

export interface IntradayInsertionRow {
  insertionId: string;
  ticketId: string;
  zoneId: string;
  companyId: string;
  companyTier: string;
  insertionType: string;
  slaBucket: string | null;
  /** null on an ESCALATION_REQUIRED row — no capacity-eligible SE existed to name. */
  offeredSeId: string | null;
  offeredAt: string;
  acceptanceDeadline: string | null;
  status: IntradayInsertionStatus;
  declineReasonCode: string | null;
  retryCount: number;
  whatsappSent: boolean;
  createdAt: string;
}

export async function apiIntradayInsertions(): Promise<IntradayInsertionRow[]> {
  const res = await fetch(`${BASE_URL}/intraday-insertions`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as IntradayInsertionRow[];
}
