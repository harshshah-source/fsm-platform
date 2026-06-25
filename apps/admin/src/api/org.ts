// Typed client for the Operations-Head org/reference config endpoints (Issue 02). Each call
// carries the access token from sessionStorage (the same store AuthProvider writes). Views mirror
// the backend `*View` shapes; ids are JSON-safe numbers.

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';
const TOKEN_KEY = 'fsm.accessToken';

export interface ZoneView {
  zoneId: number;
  name: string;
  zonalManagerUserId: string | null;
}
export interface CompanyView {
  companyId: number;
  name: string;
  companyTier: string;
  companyPriorityRank: string;
  opsOverride: boolean;
}
export interface UserView {
  userId: string;
  name: string;
  role: string;
  zoneId: number | null;
  phone: string;
  email: string;
  status: string;
}
export interface SlaRuleView {
  scope: string;
  key: string;
  submitWithinMinutes: number | null;
  verifyWithinMinutes: number | null;
  escalateAfterMinutes: number | null;
}
export interface ScoringWeightView {
  weightSetRef: string;
  component: string;
  weight: number;
  active: boolean;
}
export interface CommonKitView {
  id: number;
  componentId: number;
  minQty: number;
  active: boolean;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = sessionStorage.getItem(TOKEN_KEY);
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`REQUEST_FAILED_${res.status}`);
  }
  return (await res.json()) as T;
}

export interface PlantView {
  plantId: number;
  name: string;
  zoneId: number;
}

export const listZones = () => api<ZoneView[]>('/org/zones');

export const listPlants = (zoneId?: number) =>
  api<PlantView[]>(`/org/plants${zoneId !== undefined ? `?zoneId=${zoneId}` : ''}`);
export const createPlant = (body: { name: string; zoneId: number }) =>
  api<PlantView>('/org/plants', { method: 'POST', body: JSON.stringify(body) });
export const createZone = (name: string) =>
  api<ZoneView>('/org/zones', { method: 'POST', body: JSON.stringify({ name }) });

export const listCompanies = () => api<CompanyView[]>('/org/companies');
export const createCompany = (body: {
  name: string;
  companyTier: string;
  companyPriorityRank: string;
}) => api<CompanyView>('/org/companies', { method: 'POST', body: JSON.stringify(body) });
// Issue 46 — Operations-Head edit of an existing company's commercial classification.
export const updateCompany = (
  companyId: number,
  body: { companyTier?: string; companyPriorityRank?: string; opsOverride?: boolean },
) => api<CompanyView>(`/org/companies/${companyId}`, { method: 'PATCH', body: JSON.stringify(body) });

export const listUsers = () => api<UserView[]>('/org/users');
export const createUser = (body: {
  name: string;
  role: string;
  email: string;
  phone: string;
  zoneId?: number;
}) => api<UserView>('/org/users', { method: 'POST', body: JSON.stringify(body) });

export const listSlaRules = () => api<SlaRuleView[]>('/org/sla-rules');
export const upsertSlaRule = (body: {
  scope: string;
  key: string;
  submitWithinMinutes?: number;
  verifyWithinMinutes?: number;
  escalateAfterMinutes?: number;
}) => api<SlaRuleView>('/org/sla-rules', { method: 'PUT', body: JSON.stringify(body) });

export const listScoringWeights = () => api<ScoringWeightView[]>('/org/scoring-weights');
export const upsertScoringWeight = (body: {
  weightSetRef: string;
  component: string;
  weight: number;
}) => api<ScoringWeightView>('/org/scoring-weights', { method: 'POST', body: JSON.stringify(body) });

export const listCommonKit = () => api<CommonKitView[]>('/org/common-kit');
export const upsertCommonKit = (body: { componentId: number; minQty: number }) =>
  api<CommonKitView>('/org/common-kit', { method: 'POST', body: JSON.stringify(body) });

export interface EngineerView {
  engineerId: string;
  coverageType: string;
  zoneId: number;
  dailyCapacity: number;
  isActive: boolean;
}
export interface SeCoverageView {
  id: number;
  seId: string;
  plantId: number;
  coverageType: string;
}

export const listEngineers = () => api<EngineerView[]>('/org/engineers');
export const createEngineer = (body: {
  userId: string;
  coverageType: string;
  zoneId: number;
  dailyCapacity: number;
}) => api<EngineerView>('/org/engineers', { method: 'POST', body: JSON.stringify(body) });

export const listSeCoverage = () => api<SeCoverageView[]>('/org/se-coverage');
export const addSeCoverage = (body: { seId: string; plantId: number; coverageType: string }) =>
  api<SeCoverageView>('/org/se-coverage', { method: 'POST', body: JSON.stringify(body) });
