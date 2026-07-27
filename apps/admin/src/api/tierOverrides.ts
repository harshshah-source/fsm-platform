// Typed client for the scoped, expiring company tier overrides surface (#157, `/api/org/tier-overrides`).
//
// The CSM/ZM authority extension over the OH-owned global company tier (#46): a zone-scoped override
// with a mandatory reason and an expiry (<= 2 months), auto-reverting at expiry. `isWinning` marks the
// single live effective override per (company, zone) pair — the one the recommender would actually
// apply (newest ACTIVE, unexpired). A ZONAL_MANAGER's reads/writes are clamped to their home zone by
// the backend, so the client never has to enforce that.

import { authHeaders } from './authHeaders';

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';

export interface TierOverrideRow {
  id: string;
  companyId: number;
  companyName: string;
  zoneId: number;
  zoneName: string | null;
  tier: string;
  reason: string;
  expiresAt: string;
  status: string;
  createdBy: string | null;
  createdAt: string;
  /** True for the live effective override of this (company, zone) pair — newest ACTIVE, unexpired (AC-6). */
  isWinning: boolean;
}

export interface CreateTierOverrideBody {
  companyId: number;
  zoneId: number;
  tier: string;
  reason: string;
  /** ISO timestamp; the backend caps it to (now, now + 2 months]. */
  expiresAt: string;
}

export interface ListTierOverridesParams {
  status?: string;
  zoneId?: number;
  /** `YYYY-MM` — the monthly report filter. */
  month?: string;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const listTierOverrides = (params: ListTierOverridesParams = {}) => {
  const q = new URLSearchParams();
  if (params.status) q.set('status', params.status);
  if (params.zoneId !== undefined) q.set('zoneId', String(params.zoneId));
  if (params.month) q.set('month', params.month);
  const qs = q.toString();
  return req<TierOverrideRow[]>(`/org/tier-overrides${qs ? `?${qs}` : ''}`);
};

export const createTierOverride = (body: CreateTierOverrideBody) =>
  req<TierOverrideRow>('/org/tier-overrides', { method: 'POST', body: JSON.stringify(body) });

/** Cancel an ACTIVE override (same role/zone scope as create; ZM own-zone only, enforced server-side). */
export const cancelTierOverride = (id: string) =>
  req<void>(`/org/tier-overrides/${id}`, { method: 'DELETE' });
