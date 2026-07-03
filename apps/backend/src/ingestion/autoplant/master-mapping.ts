/**
 * Pure AutoPlant `ap_masters` → FSM master-upsert mapping (Phase 4). Turns `mst_company` /
 * `mst_plant` / `mst_transporter` / `mst_vehicle` (or the master columns of `tb_vehiclemaster`) rows
 * into `UpsertPlan`s the `MasterSyncService` feeds to Prisma `upsert()`.
 *
 * Everything here is a pure function — unit-testable against recorded rows with no DB or VPN, the same
 * way `mapping.ts` is for the Snapshot path. The service (`master-sync.service.ts`) is the only thing
 * that touches Postgres and owns the two business-gated decisions this layer deliberately does NOT
 * make: the operational `zoneId` (R6 state→zone map) and the scoping filter values (R14) both arrive
 * here as plain inputs.
 *
 * The load-bearing invariant is the **anti-drift property** (blueprint §5.3/§5.4, Risk R4): each plan's
 * `update` set mirrors AutoPlant-authoritative attributes but structurally EXCLUDES every FSM-owned
 * column — `companyTier`/`companyPriorityRank`/`opsOverride` (R13), `zoneId`/`districtId` (R6), and
 * `dealType`. A re-sync can therefore never clobber an Ops-Head decision.
 */

/** An idempotent upsert keyed on a source id: match `where`, insert `create`, or refresh `update`. */
export interface UpsertPlan<TWhere, TCreate, TUpdate> {
  where: TWhere;
  create: TCreate;
  update: TUpdate;
}

/** The `company_tier` enum values (kept local so this layer stays decoupled from generated Prisma). */
export type CompanyTierValue = 'PLATINUM' | 'GOLD' | 'SILVER';

/** Safe, overridable INSERT-ONLY defaults for the FSM-owned tier/rank (blueprint §5.2 / R13). */
export const DEFAULT_INSERT_TIER: CompanyTierValue = 'SILVER';
export const DEFAULT_INSERT_RANK = 'C';

const NULLISH = new Set(['', 'NA', 'NULL', 'null']);

const isBlank = (v: string | null | undefined): boolean => v == null || NULLISH.has(v.trim());

/** Trim to a non-blank String, or null (AutoPlant uses `''`/`NA`/`NULL` sentinels interchangeably). */
export function cleanStr(v: string | null | undefined): string | null {
  return isBlank(v) ? null : v!.trim();
}

/** Coerce an AutoPlant numeric id (int/bigint arrives as number or string) to bigint, null-safe. */
export function toBigIntOrNull(v: number | string | null | undefined): bigint | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === '' || NULLISH.has(s)) return null;
  if (!/^-?\d+$/.test(s)) return null;
  const n = BigInt(s);
  return n === 0n ? null : n; // AutoPlant uses 0 as a "no id" sentinel (e.g. plant_id/transporter_id 0)
}

// ── Source row shapes (only the columns this layer consumes; mirrors the VehicleMasterRow pattern) ──

export interface MstCompanyRow {
  company_id: number | string;
  company_name: string;
  company_type: string | null;
  status: string | null;
}

export interface MstTransporterRow {
  transporter_id: number | string;
  company_id: number | string | null;
  transporter_name: string;
  status: string | null;
}

export interface MstPlantRow {
  plant_id: number | string;
  company_id: number | string | null;
  plant_name: string;
  zone_id: number | string | null;
  zone_name: string | null;
  region_id: number | string | null;
  region_name: string | null;
  plant_state: string | null;
  plant_district: string | null;
  plant_code: string | null;
  status: string | null;
}

/** The master columns of a `tb_vehiclemaster` (or `mst_vehicle`) row — vehicle identity + fitment. */
export interface VehicleMasterMasterRow {
  vehicle_no: string;
  device_id: string | null;
  plant_id: number | string | null;
  company_id: number | string | null;
  transporter_id: number | string | null;
  device_type: string | null;
  /** ACTIVE / DEPLOYED / UNDEPLOYED — mirrored verbatim onto `vehicles.status`. */
  deployment_status: string | null;
}

// ── Scoping predicate (R14 mechanism — the VALUES come from the caller, never baked in) ──

export interface MasterSyncScope {
  /** AutoPlant `company_type` values that are FSM's fleet (empty ⇒ no restriction on this axis). */
  companyTypes: string[];
  /** `status` values to include (empty ⇒ no restriction on this axis). */
  statuses: string[];
}

const inList = (value: string | null, allowed: string[]): boolean => {
  if (allowed.length === 0) return true; // empty list ⇒ this axis is unconstrained
  const v = (value ?? '').trim().toLowerCase();
  return allowed.some((a) => a.trim().toLowerCase() === v);
};

/** True when a company falls inside the (caller-supplied) FSM fleet scope — R14. */
export function companyMatchesScope(row: MstCompanyRow, scope: MasterSyncScope): boolean {
  return inList(row.company_type, scope.companyTypes) && inList(row.status, scope.statuses);
}

// ── Entity maps ──

export interface CompanyDefaults {
  defaultTier?: CompanyTierValue;
  defaultRank?: string;
}

export function mapCompany(
  row: MstCompanyRow,
  defaults: CompanyDefaults = {},
): UpsertPlan<
  { sourceCompanyId: bigint },
  {
    sourceCompanyId: bigint;
    name: string;
    companyType: string | null;
    status: string | null;
    companyTier: CompanyTierValue;
    companyPriorityRank: string;
  },
  { name: string; companyType: string | null; status: string | null }
> {
  const sourceCompanyId = BigInt(String(row.company_id).trim());
  const mirrored = {
    name: row.company_name.trim(),
    companyType: cleanStr(row.company_type),
    status: cleanStr(row.status),
  };
  return {
    where: { sourceCompanyId },
    create: {
      sourceCompanyId,
      ...mirrored,
      // FSM-owned, INSERT-ONLY (R13): a neutral default so the row is insertable; Ops-Head/CRM owns the truth.
      companyTier: defaults.defaultTier ?? DEFAULT_INSERT_TIER,
      companyPriorityRank: defaults.defaultRank ?? DEFAULT_INSERT_RANK,
    },
    update: mirrored,
  };
}

export function mapTransporter(
  row: MstTransporterRow,
  fks: { companyId: bigint | null },
): UpsertPlan<
  { sourceTransporterId: bigint },
  { sourceTransporterId: bigint; name: string; companyId: bigint | null; status: string | null },
  { name: string; companyId: bigint | null; status: string | null }
> {
  const sourceTransporterId = BigInt(String(row.transporter_id).trim());
  const mirrored = {
    name: row.transporter_name.trim(),
    companyId: fks.companyId,
    status: cleanStr(row.status),
  };
  return {
    where: { sourceTransporterId },
    create: { sourceTransporterId, ...mirrored },
    update: mirrored,
  };
}

export function mapPlant(
  row: MstPlantRow,
  fsm: { zoneId: bigint; districtId: bigint | null },
): UpsertPlan<
  { sourcePlantId: bigint },
  {
    sourcePlantId: bigint;
    name: string;
    zoneId: bigint;
    districtId: bigint | null;
    sourceZoneId: bigint | null;
    sourceZoneName: string | null;
    sourceRegionId: bigint | null;
    sourceRegionName: string | null;
    plantState: string | null;
    plantDistrict: string | null;
    masterPlantId: bigint | null;
    masterPlantCode: string | null;
    status: string | null;
  },
  {
    name: string;
    sourceZoneId: bigint | null;
    sourceZoneName: string | null;
    sourceRegionId: bigint | null;
    sourceRegionName: string | null;
    plantState: string | null;
    plantDistrict: string | null;
    masterPlantId: bigint | null;
    masterPlantCode: string | null;
    status: string | null;
  }
> {
  const sourcePlantId = BigInt(String(row.plant_id).trim());
  // AutoPlant-authoritative org hierarchy, mirrored faithfully (§5.2 Rev 3). These refresh on re-sync.
  const mirrored = {
    name: row.plant_name.trim(),
    sourceZoneId: toBigIntOrNull(row.zone_id),
    sourceZoneName: cleanStr(row.zone_name),
    sourceRegionId: toBigIntOrNull(row.region_id),
    sourceRegionName: cleanStr(row.region_name),
    plantState: cleanStr(row.plant_state),
    plantDistrict: cleanStr(row.plant_district),
    masterPlantId: sourcePlantId,
    masterPlantCode: cleanStr(row.plant_code),
    status: cleanStr(row.status),
  };
  return {
    where: { sourcePlantId },
    create: {
      sourcePlantId,
      ...mirrored,
      // FSM-owned operational zone (R6) + derived district — INSERT-ONLY, never overwritten on re-sync.
      zoneId: fsm.zoneId,
      districtId: fsm.districtId,
    },
    update: mirrored,
  };
}

export function mapVehicle(
  row: VehicleMasterMasterRow,
  fks: { plantId: bigint; companyId: bigint; transporterId: bigint | null },
): UpsertPlan<
  { vehicleNo: string },
  { vehicleNo: string; plantId: bigint; companyId: bigint; transporterId: bigint | null; status: string | null },
  { plantId: bigint; companyId: bigint; transporterId: bigint | null; status: string | null }
> {
  const mirrored = {
    plantId: fks.plantId,
    companyId: fks.companyId,
    transporterId: fks.transporterId,
    status: cleanStr(row.deployment_status),
  };
  return {
    where: { vehicleNo: row.vehicle_no.trim() },
    create: { vehicleNo: row.vehicle_no.trim(), ...mirrored },
    update: mirrored,
  };
}

export function mapDevice(
  row: VehicleMasterMasterRow,
  fitment: { currentVehicleId: bigint | null },
): UpsertPlan<
  { deviceId: string },
  { deviceId: string; deviceType: string | null; currentVehicleId: bigint | null },
  { deviceType: string | null; currentVehicleId: bigint | null }
> | null {
  const deviceId = cleanStr(row.device_id);
  if (deviceId == null) return null; // vehicle with no fitted device — master-sync still records the vehicle
  const mirrored = { deviceType: cleanStr(row.device_type), currentVehicleId: fitment.currentVehicleId };
  return {
    where: { deviceId },
    create: { deviceId, ...mirrored },
    update: mirrored,
    // `dealType` is an FSM tag (proxy for CRM/SAP) — deliberately absent from create AND update.
  };
}
