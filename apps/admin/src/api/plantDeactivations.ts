// Typed client for OH plant deactivation (Issue 119, `/api/plants`). List active deactivations,
// deactivate a plant (mandatory reason — cancels its open tickets server-side), and reactivate.

import { authHeaders } from './authHeaders';

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';

export interface PlantDeactivationRow {
  id: string;
  plantId: string;
  plantName: string;
  sourcePlantId: string | null;
  company: string | null;
  zone: string | null;
  deviceCount: number;
  reason: string;
  deactivatedBy: string | null;
  deactivatedAt: string;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as T;
}

export const listPlantDeactivations = () =>
  req<PlantDeactivationRow[]>('/plants/deactivations');

export const deactivatePlant = (plantId: string, reason: string) =>
  req<{ deactivationId: string; cancelledTickets: number }>(`/plants/${plantId}/deactivate`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });

export const reactivatePlant = (plantId: string, reason?: string) =>
  req<{ result: string }>(`/plants/${plantId}/reactivate`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
