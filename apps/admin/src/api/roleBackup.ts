// Typed client for the role backup cascade (Issue 27). The per-zone CSM-backup share report
// (Operations Head) — how routine ZM backup is becoming, by zone.

import { authHeaders } from './authHeaders';

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';

export interface CsmBackupZoneRow {
  zoneId: string;
  csmActions: number;
  totalActedActions: number;
  sharePct: number;
}

export async function apiCsmApprovalShare(month?: string): Promise<CsmBackupZoneRow[]> {
  const qs = month ? `?month=${encodeURIComponent(month)}` : '';
  const res = await fetch(`${BASE_URL}/reports/csm-approval-share${qs}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as CsmBackupZoneRow[];
}
