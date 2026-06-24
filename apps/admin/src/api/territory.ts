// Typed client for Floating-SE territory config (Issue 09): geography reads + engineer_territory_coverage
// reads/writes. Operations Head only (the backend enforces the role).

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';
const TOKEN_KEY = 'fsm.accessToken';

export interface EngineerView {
  engineerId: string;
  coverageType: string;
  zoneId: number;
  dailyCapacity: number;
  isActive: boolean;
}
export interface RegionView {
  regionId: number;
  name: string;
  state: string;
}
export interface DistrictView {
  districtId: number;
  name: string;
  state: string;
  regionId: number | null;
}
export interface TerritoryRow {
  id: number;
  seId: string;
  districtId: number | null;
  regionId: number | null;
  state: string | null;
}
export interface AddTerritoryInput {
  seId: string;
  districtId?: number;
  regionId?: number;
  state?: string;
}

function authHeaders(json = false): Record<string, string> {
  const token = sessionStorage.getItem(TOKEN_KEY);
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as T;
}

export async function apiFloatingEngineers(): Promise<EngineerView[]> {
  const all = await get<EngineerView[]>('/org/engineers');
  return all.filter((e) => e.coverageType === 'FLOATING');
}

export const apiGeoStates = () => get<string[]>('/org/geo/states');
export const apiGeoRegions = (state: string) =>
  get<RegionView[]>(`/org/geo/regions?state=${encodeURIComponent(state)}`);
export const apiGeoDistricts = (state: string, regionId?: number) => {
  const q = new URLSearchParams({ state });
  if (regionId !== undefined) q.set('regionId', String(regionId));
  return get<DistrictView[]>(`/org/geo/districts?${q.toString()}`);
};

export const apiListTerritory = (seId: string) =>
  get<TerritoryRow[]>(`/org/se-territory?seId=${encodeURIComponent(seId)}`);

export async function apiAddTerritory(input: AddTerritoryInput): Promise<TerritoryRow> {
  const res = await fetch(`${BASE_URL}/org/se-territory`, {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as TerritoryRow;
}

export async function apiRemoveTerritory(id: number): Promise<void> {
  const res = await fetch(`${BASE_URL}/org/se-territory/${id}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
}
