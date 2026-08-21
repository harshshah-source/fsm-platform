// Typed client for the Assign Work Console's candidate column (#274, decision #272 R4/R5/R6).
//
// Uses the shared `authHeaders()` for the same reason `assignWork.ts` does: it carries
// `X-Acting-As-Zone`, and the two reads feed one screen. A pool clamped to the acting zone beside a
// candidate column scoped pan-India would offer engineers for work the pool never showed.

import { authHeaders } from './authHeaders';

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';

export type CoverageType = 'DEDICATED' | 'MULTI_PLANT' | 'FLOATING';

export type HardFilterReason =
  | 'VEHICLE_ON_TRIP'
  | 'SE_UNAVAILABLE'
  | 'OVER_CAPACITY'
  | 'COMMON_KIT_INCOMPLETE'
  | 'COMPONENT_UNAVAILABLE';

/** One engineer's answer to "can you cover this plant, and can you carry it?" */
export interface CandidateRow {
  seId: string;
  name: string | null;
  /** Coverage for **this plant**, from `se_coverage` / the floating MV — not the engineer's global
   *  `engineer_master.coverage_type`, which for a MULTI_PLANT engineer says nothing about this site. */
  coverageType: CoverageType;
  /** 1 DEDICATED · 2 MULTI_PLANT · 3 FLOATING — the precedence the engine walks. */
  tierRank: number;
  /** What the engine's hard filters make of this candidate right now. */
  verdict: 'PASSED' | 'DROPPED';
  dropReason: HardFilterReason | null;
  committed: number;
  dailyCapacity: number | null;
  availabilityStatus: string;
  kitComplete: boolean;
  missingKit: string[];
}

export interface PlantCandidates {
  plantId: string;
  plantName: string;
  zoneId: string;
  /** In the engine's order, unchanged, **including** the candidates it would drop. */
  candidates: CandidateRow[];
}

export interface CandidatesView {
  date: string;
  plants: PlantCandidates[];
}

/** Human wording for a hard-filter drop. The enum is the truth; this is what the operator reads. */
export const DROP_REASON_TEXT: Record<HardFilterReason, string> = {
  VEHICLE_ON_TRIP: 'vehicle on trip',
  SE_UNAVAILABLE: 'not available',
  OVER_CAPACITY: 'at or over capacity',
  COMMON_KIT_INCOMPLETE: 'common kit incomplete',
  COMPONENT_UNAVAILABLE: 'component unavailable',
};

export const TIER_LABEL: Record<CoverageType, string> = {
  DEDICATED: 'Dedicated',
  MULTI_PLANT: 'Multi-plant',
  FLOATING: 'Floating',
};

/** Precedence order — the order the column's headings are always rendered in, populated or not. */
export const TIER_ORDER: CoverageType[] = ['DEDICATED', 'MULTI_PLANT', 'FLOATING'];

export async function apiCandidates(plantIds: string[]): Promise<CandidatesView> {
  if (plantIds.length === 0) return { date: '', plants: [] };
  const res = await fetch(`${BASE_URL}/schedules/candidates?plantIds=${plantIds.join(',')}`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as CandidatesView;
}
