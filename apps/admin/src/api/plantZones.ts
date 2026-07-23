// Typed client for the Operations-Head plant zone-reassignment surface (#158, `/api/org`).
//
// The important contract here is that setting or clearing an override is only HALF the operation.
// Master sync is insert-only on `plants.zone_id` (anti-drift), so an override does NOT move an
// already-synced plant until `reapply` recomputes every plant's zone from the current overrides +
// crosswalk. Callers must run both — `reapplyZoneMappings` returns the counts that prove it landed.

import { authHeaders } from './authHeaders';

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';

export interface PlantZoneOverrideRow {
  sourcePlantId: string;
  fsmZoneId: string;
  fsmZoneName: string | null;
  reason: string | null;
}

export interface ZoneChangeImpact {
  plantName: string;
  currentZoneName: string | null;
  deviceCount: number;
  openTicketCount: number;
  /** Tickets already on a live day plan today. These re-scope, but the PLAN stays under the old zone. */
  dispatchedTodayCount: number;
}

export interface ReapplyResult {
  plantsConsidered: number;
  updated: number;
  unchanged: number;
  landedUnzoned: number;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const listPlantZoneOverrides = () =>
  req<PlantZoneOverrideRow[]>('/org/plant-zone-overrides');

/** What a pending zone change will re-scope — shown before the admin confirms. */
export const getZoneChangeImpact = (sourcePlantId: string) =>
  req<ZoneChangeImpact>(`/org/plant-zone-overrides/${sourcePlantId}/impact`);

/** Pin a plant to a zone. `reason` is mandatory — the row is overwritten on re-pin, so it survives only in audit_logs. */
export const setPlantZoneOverride = (sourcePlantId: string, fsmZoneId: number, reason: string) =>
  req<PlantZoneOverrideRow>('/org/plant-zone-overrides', {
    method: 'PUT',
    body: JSON.stringify({ sourcePlantId, fsmZoneId, reason }),
  });

export const clearPlantZoneOverride = (sourcePlantId: string) =>
  req<void>(`/org/plant-zone-overrides/${sourcePlantId}`, { method: 'DELETE' });

/** The FSM-owned effect of an override edit. Without this, a set/clear changes nothing. */
export const reapplyZoneMappings = () =>
  req<ReapplyResult>('/org/zone-mappings/reapply', { method: 'POST' });
