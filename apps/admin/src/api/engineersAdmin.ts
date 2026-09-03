import { authHeaders } from './authHeaders';
// Typed client for the Phase 4 SE Management CRUD (`/api/engineers` admin surface). Unlike the generic
// helper it preserves the backend error `code` so the page renders validation/authority messages inline.
// Zone authority (OH/CSM cross-zone, ZM home-zone) is enforced server-side from the JWT; the page mirrors
// it for affordances only.

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';

export interface MappedPlant {
  id: number;
  name: string;
  /** se_coverage row id — present on directory rows so the UI can remove the mapping. */
  coverageId?: number;
}

export interface SeDirectoryRow {
  seId: string;
  name: string;
  phone: string;
  email: string;
  address: string | null;
  zoneId: number;
  coverageType: string;
  dailyCapacity: number;
  isActive: boolean;
  /** #267 — admin-managed home/base for the recommender's `distance` score component. Either both
   *  set or both null — never a lone lat/lng. */
  homeLat: number | null;
  homeLng: number | null;
  plants: MappedPlant[];
  companies: MappedPlant[];
}

export interface SeCoverageRow {
  id: number;
  seId: string;
  plantId: number;
  coverageType: string;
}

export interface CreateSeBody {
  name: string;
  phone: string;
  email: string;
  address?: string | null;
  zoneId: number;
  coverageType: string;
  dailyCapacity: number;
  homeLat?: number | null;
  homeLng?: number | null;
}

export interface UpdateSeBody {
  name?: string;
  phone?: string;
  email?: string;
  address?: string | null;
  zoneId?: number;
  dailyCapacity?: number;
  coverageType?: string;
  homeLat?: number | null;
  homeLng?: number | null;
}

/** Carries the backend error `code` (+ optional `field`) to the page. */
export class SeApiError extends Error {
  code: string;
  field?: string;
  constructor(code: string, field?: string) {
    super(code);
    this.name = 'SeApiError';
    this.code = code;
    this.field = field;
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let payload: { code?: string; field?: string } = {};
    try {
      payload = (await res.json()) as typeof payload;
    } catch {
      // non-JSON error body
    }
    throw new SeApiError(payload.code ?? `REQUEST_FAILED_${res.status}`, payload.field);
  }
  return (await res.json()) as T;
}

export const listSeDirectory = () => req<SeDirectoryRow[]>('/engineers/directory');

export const createSe = (body: CreateSeBody) =>
  req<SeDirectoryRow>('/engineers', { method: 'POST', body: JSON.stringify(body) });

export const updateSe = (seId: string, body: UpdateSeBody) =>
  req<SeDirectoryRow>(`/engineers/${seId}`, { method: 'PATCH', body: JSON.stringify(body) });

export const setSeActive = (seId: string, active: boolean) =>
  req<SeDirectoryRow>(`/engineers/${seId}/status`, { method: 'POST', body: JSON.stringify({ active }) });

export const addSeCoverage = (seId: string, body: { plantId: number; coverageType: string }) =>
  req<SeCoverageRow>(`/engineers/${seId}/coverage`, { method: 'POST', body: JSON.stringify(body) });

export const removeSeCoverage = (seId: string, coverageId: number) =>
  req<{ id: number }>(`/engineers/${seId}/coverage/${coverageId}`, { method: 'DELETE' });
