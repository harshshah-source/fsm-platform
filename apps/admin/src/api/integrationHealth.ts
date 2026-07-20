// Typed client for the AutoPlant integration-health surface (`GET /api/integration/health`,
// OPERATIONS_HEAD-only). #130 added build attribution (which build produced each run + a staleBuild
// flag against the current runtime-lock high-water mark) and the last-N device-state recompute
// history with the semantic-canary swing flag. Mirrors the backend `IntegrationHealth`.

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';
const TOKEN_KEY = 'fsm.accessToken';

export interface RunBuildStamp {
  buildVersion: string | null;
  buildFingerprint: string | null;
  /** This run was produced by a build below the current runtime-lock version (a stale-build run). */
  staleBuild: boolean;
}

export interface RuntimeLockHealth {
  version: string | null;
  fingerprint: string | null;
}

export interface RecomputeLedgerEntry {
  recomputeId: string;
  computedAt: string;
  eligibleCount: number;
  inactiveCount: number;
  departedCount: number;
  totalCount: number;
  buildVersion: string | null;
  buildFingerprint: string | null;
  trigger: string;
  staleBuild: boolean;
  /** Relative eligible swing vs the previous row; null for the oldest row in the window. */
  swingPct: number | null;
  /** |swingPct| exceeded the canary threshold — the row an operator should investigate. */
  swing: boolean;
}

/** The subset of the backend `IntegrationHealth` this client reads (build attribution + canary). */
export interface IntegrationHealthView {
  masterSync: { build: RunBuildStamp | null };
  snapshot: { build: RunBuildStamp | null };
  runtimeLock: RuntimeLockHealth;
  recomputes: RecomputeLedgerEntry[];
}

export async function apiIntegrationHealth(): Promise<IntegrationHealthView> {
  const token = sessionStorage.getItem(TOKEN_KEY);
  const res = await fetch(`${BASE_URL}/integration/health`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as IntegrationHealthView;
}
