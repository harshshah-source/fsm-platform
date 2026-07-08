/**
 * PROVISIONAL `plant_state → FSM operational-zone` map (blueprint §5.2 / R6). The FSM Zone is an
 * FSM-owned partition (ZM authority), auto-derived from the AUTHORITATIVE `mst_plant.plant_state` — it
 * is **not** a copy of AutoPlant's per-company `zone_name` (that is only a cross-check here).
 *
 * ⚠️ These VALUES are a business decision pending Ops-Head ratification — see
 * `docs/autoplant/R6-zone-map-proposal.md`. The flagged ambiguities: **Chhattisgarh** (encoded EAST to
 * match AutoPlant's own `mst_region` grouping, vs standard West/Central), **Madhya Pradesh** (WEST),
 * **Uttar Pradesh / Rajasthan** (NORTH). A 4-zone model has no "Central", so MP/CG land in one of four.
 *
 * Everything here is pure + unit-testable; the DB-touching `StateMapZoneResolver` turns a derived zone
 * name into an FSM `zone_id`. An unmapped/junk state → `null` (UNZONED → defer to the Ops exception
 * queue), never a guessed zone.
 */

export type FsmZoneName = 'NORTH' | 'SOUTH' | 'EAST' | 'WEST';

/** PROVISIONAL — keys are lowercased state names; values the four FSM zones. Ratify per R6. */
export const STATE_ZONE_MAP: Record<string, FsmZoneName> = {
  // ── NORTH ──
  delhi: 'NORTH',
  haryana: 'NORTH',
  punjab: 'NORTH',
  chandigarh: 'NORTH',
  'himachal pradesh': 'NORTH',
  'jammu & kashmir': 'NORTH',
  'jammu and kashmir': 'NORTH',
  ladakh: 'NORTH',
  uttarakhand: 'NORTH',
  'uttar pradesh': 'NORTH', // ⚠️ flagged (North vs Central)
  rajasthan: 'NORTH', // ⚠️ flagged (North vs West)
  // ── SOUTH ──
  'andhra pradesh': 'SOUTH',
  telangana: 'SOUTH',
  karnataka: 'SOUTH',
  'tamil nadu': 'SOUTH',
  kerala: 'SOUTH',
  puducherry: 'SOUTH',
  // ── EAST ──
  'west bengal': 'EAST',
  odisha: 'EAST',
  jharkhand: 'EAST',
  bihar: 'EAST',
  assam: 'EAST',
  'arunachal pradesh': 'EAST',
  manipur: 'EAST',
  meghalaya: 'EAST',
  mizoram: 'EAST',
  nagaland: 'EAST',
  tripura: 'EAST',
  sikkim: 'EAST',
  chhattisgarh: 'EAST', // ⚠️ flagged — follows AutoPlant mst_region (vs standard West/Central)
  // ── WEST ──
  maharashtra: 'WEST',
  gujarat: 'WEST',
  goa: 'WEST',
  'madhya pradesh': 'WEST', // ⚠️ flagged (West vs North/Central)
};

const norm = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();

/** State → FSM zone name, or `null` (UNZONED) for junk (`india`/`NA`/blank) or an unmapped state. */
export function stateToZone(plantState: string | null | undefined): FsmZoneName | null {
  return STATE_ZONE_MAP[norm(plantState)] ?? null;
}

/**
 * Normalize AutoPlant's inconsistent `zone_name` ("North India" / "West Zone" / "East") to an
 * `FsmZoneName` for cross-checking — or `null` when it's blank or an unrecognized/typo'd value
 * (real data contains e.g. "Noth India"), so a bad source label never fabricates a match.
 */
export function normalizeSourceZoneName(sourceZoneName: string | null | undefined): FsmZoneName | null {
  const s = norm(sourceZoneName).replace(/\b(india|zone)\b/g, '').trim();
  if (s === 'north') return 'NORTH';
  if (s === 'south') return 'SOUTH';
  if (s === 'east') return 'EAST';
  if (s === 'west') return 'WEST';
  return null;
}

export interface ZoneDerivation {
  /** The FSM zone from `plant_state`, or `null` ⇒ UNZONED / defer. */
  zoneName: FsmZoneName | null;
  /** The state-derived zone disagrees with AutoPlant's `zone_name` → flag for the Ops exception queue. */
  conflict: boolean;
}

/** Derive the operational zone from state (authoritative), using `zone_name` only to flag conflicts. */
export function deriveZone(
  plantState: string | null | undefined,
  sourceZoneName: string | null | undefined,
): ZoneDerivation {
  const zoneName = stateToZone(plantState);
  const src = normalizeSourceZoneName(sourceZoneName);
  return { zoneName, conflict: zoneName != null && src != null && src !== zoneName };
}
