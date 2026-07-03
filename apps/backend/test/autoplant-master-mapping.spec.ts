import {
  mapCompany,
  mapTransporter,
  mapPlant,
  mapVehicle,
  mapDevice,
  plantInScope,
  DEFAULT_INSERT_TIER,
  DEFAULT_INSERT_RANK,
  type MstCompanyRow,
  type MstTransporterRow,
  type MstPlantRow,
  type VehicleMasterMasterRow,
} from '../src/ingestion/autoplant/master-mapping';

/**
 * Phase 4 — pure `ap_masters` → FSM master-upsert mapping. Fixtures are real sampled rows
 * (docs/autoplant_databaseData.md): UTCL (1010), a Kadappa plant (3038, Vicat/1015), a transporter,
 * and the AP02TA2569 / AP03TC0959 (WheelsEye) vehicle+device rows from tb_vehiclemaster.
 *
 * The load-bearing invariant these tests pin down is the **anti-drift property** (blueprint §5.3/§5.4,
 * Risk R4): every map returns an `UpsertPlan {where, create, update}` where FSM-OWNED columns
 * (`companyTier`/`companyPriorityRank`/`opsOverride`, `zoneId`/`districtId`, `dealType`) NEVER appear in
 * `update` — a re-sync mirrors AutoPlant attributes but can never clobber an Ops-Head decision.
 * Resolved FKs and the operational `zoneId` are INPUTS (the service owns those gated decisions, §R6/R14).
 */

const UTCL: MstCompanyRow = {
  company_id: 1010,
  company_name: 'UTCL',
  company_type: 'Shipper',
  status: 'ACTIVE',
};

const TRANSPORTER: MstTransporterRow = {
  transporter_id: 7216,
  company_id: 1015,
  transporter_name: 'SRI LAKSHMI VENKATESWARA TRANSPORT',
  status: 'ACTIVE',
};

const KADAPPA: MstPlantRow = {
  plant_id: 3038,
  company_id: 1015,
  plant_name: 'Kadappa',
  zone_id: 2039,
  zone_name: 'South India',
  region_id: null,
  region_name: null,
  plant_state: 'Andhra Pradesh',
  plant_district: 'Kadapa',
  // master_plant_* is a DISTINCT parent reference (≠ plant_id/plant_code) — pin that it maps from the
  // right columns (real data has plants where these differ, e.g. plant 4561 → master_plant_id 4460).
  master_plant_id: 4460,
  master_plant_code: 'MP-KDP',
  status: 'ACTIVE',
};

// A real tb_vehiclemaster master row (vehicle AP02TA2569, leading-zero IMEI, Vicat/1015, DEPLOYED).
const VM_AP02TA2569: VehicleMasterMasterRow = {
  vehicle_no: 'AP02TA2569',
  device_id: '0869925073271551',
  plant_id: 3038,
  company_id: 1015,
  transporter_id: 7216,
  device_type: 'V5',
  deployment_status: 'DEPLOYED',
};

describe('Phase 4 — mapCompany', () => {
  it('keys the upsert by source_company_id and mirrors name/type/status', () => {
    const plan = mapCompany(UTCL);
    expect(plan.where).toEqual({ sourceCompanyId: 1010n });
    expect(plan.create).toMatchObject({
      sourceCompanyId: 1010n,
      name: 'UTCL',
      companyType: 'Shipper',
      status: 'ACTIVE',
    });
    expect(plan.update).toMatchObject({ name: 'UTCL', companyType: 'Shipper', status: 'ACTIVE' });
  });

  it('sets FSM-owned tier/rank as INSERT-ONLY safe defaults (never in update) — R13', () => {
    const plan = mapCompany(UTCL);
    expect(plan.create.companyTier).toBe(DEFAULT_INSERT_TIER);
    expect(plan.create.companyPriorityRank).toBe(DEFAULT_INSERT_RANK);
    // The anti-drift property: a re-sync must never overwrite tier/rank/ops_override.
    expect(plan.update).not.toHaveProperty('companyTier');
    expect(plan.update).not.toHaveProperty('companyPriorityRank');
    expect(plan.update).not.toHaveProperty('opsOverride');
  });

  it('honours an overridable insert default for tier/rank (values are a decision, not baked in)', () => {
    const plan = mapCompany(UTCL, { defaultTier: 'GOLD', defaultRank: 'A' });
    expect(plan.create.companyTier).toBe('GOLD');
    expect(plan.create.companyPriorityRank).toBe('A');
  });
});

describe('Phase 4 — plantInScope (fleet scope anchored on mst_plant.status, not company_type)', () => {
  it('includes a plant by status; company_type is never consulted', () => {
    const scope = { plantStatuses: ['ACTIVE'] };
    expect(plantInScope(KADAPPA, scope)).toBe(true);
    expect(plantInScope({ ...KADAPPA, status: 'INACTIVE' }, scope)).toBe(false);
  });

  it('matches case-insensitively and treats an empty list as "no status restriction"', () => {
    expect(plantInScope(KADAPPA, { plantStatuses: ['active'] })).toBe(true);
    expect(plantInScope({ ...KADAPPA, status: 'INACTIVE' }, { plantStatuses: [] })).toBe(true);
  });
});

describe('Phase 4 — mapTransporter', () => {
  it('keys by source_transporter_id and resolves company_id via the source map', () => {
    const plan = mapTransporter(TRANSPORTER, { companyId: 42n });
    expect(plan.where).toEqual({ sourceTransporterId: 7216n });
    expect(plan.create).toMatchObject({
      sourceTransporterId: 7216n,
      name: 'SRI LAKSHMI VENKATESWARA TRANSPORT',
      companyId: 42n,
      status: 'ACTIVE',
    });
    expect(plan.update).toMatchObject({ name: 'SRI LAKSHMI VENKATESWARA TRANSPORT', companyId: 42n, status: 'ACTIVE' });
    // source key is immutable — never re-written on update.
    expect(plan.update).not.toHaveProperty('sourceTransporterId');
  });

  it('tolerates an unresolved company (null FK) rather than throwing', () => {
    const plan = mapTransporter(TRANSPORTER, { companyId: null });
    expect(plan.create.companyId).toBeNull();
  });
});

describe('Phase 4 — mapPlant (R6: zoneId/districtId are FSM-owned inputs, never mirrored on update)', () => {
  it('mirrors the authoritative mst_plant org hierarchy as source attributes', () => {
    const plan = mapPlant(KADAPPA, { zoneId: 5n, districtId: 9n });
    expect(plan.where).toEqual({ sourcePlantId: 3038n });
    expect(plan.create).toMatchObject({
      sourcePlantId: 3038n,
      name: 'Kadappa',
      sourceZoneId: 2039n,
      sourceZoneName: 'South India',
      plantState: 'Andhra Pradesh',
      plantDistrict: 'Kadapa',
      // from master_plant_id/master_plant_code — NOT plant_id (3038) / plant_code.
      masterPlantId: 4460n,
      masterPlantCode: 'MP-KDP',
      status: 'ACTIVE',
    });
  });

  it('takes the operational zoneId/districtId on INSERT only — a re-sync never overwrites them', () => {
    const plan = mapPlant(KADAPPA, { zoneId: 5n, districtId: 9n });
    expect(plan.create.zoneId).toBe(5n);
    expect(plan.create.districtId).toBe(9n);
    // R6 anti-drift: the operational zone (and derived district) are Ops-owned — mirrored source
    // attributes may update, but zone_id/district_id are excluded from the update set forever.
    expect(plan.update).not.toHaveProperty('zoneId');
    expect(plan.update).not.toHaveProperty('districtId');
    // ...while the AutoPlant-authoritative attributes DO refresh on re-sync.
    expect(plan.update).toMatchObject({ name: 'Kadappa', plantState: 'Andhra Pradesh', status: 'ACTIVE' });
  });
});

describe('Phase 4 — mapVehicle', () => {
  it('keys by vehicle_no, resolves plant/company/transporter FKs, mirrors deployment status', () => {
    const plan = mapVehicle(VM_AP02TA2569, { plantId: 3n, companyId: 4n, transporterId: 7n });
    expect(plan.where).toEqual({ vehicleNo: 'AP02TA2569' });
    expect(plan.create).toMatchObject({
      vehicleNo: 'AP02TA2569',
      plantId: 3n,
      companyId: 4n,
      transporterId: 7n,
      status: 'DEPLOYED',
    });
    expect(plan.update).toMatchObject({ plantId: 3n, companyId: 4n, transporterId: 7n, status: 'DEPLOYED' });
    expect(plan.update).not.toHaveProperty('vehicleNo');
  });

  it('carries a null transporter FK through when the vehicle has no mapped transporter', () => {
    const plan = mapVehicle(VM_AP02TA2569, { plantId: 3n, companyId: 4n, transporterId: null });
    expect(plan.create.transporterId).toBeNull();
  });
});

describe('Phase 4 — mapDevice', () => {
  it('keys by the verbatim String device id, mirrors device_type + fitment, never touches deal_type', () => {
    const plan = mapDevice(VM_AP02TA2569, { currentVehicleId: 11n });
    expect(plan.where).toEqual({ deviceId: '0869925073271551' });
    expect(plan.create).toMatchObject({
      deviceId: '0869925073271551',
      deviceType: 'V5',
      currentVehicleId: 11n,
    });
    expect(plan.update).toMatchObject({ deviceType: 'V5', currentVehicleId: 11n });
    // deal_type is an FSM tag (proxy for CRM/SAP) — never sourced or overwritten from AutoPlant.
    expect(plan.create).not.toHaveProperty('dealType');
    expect(plan.update).not.toHaveProperty('dealType');
  });

  it('preserves an alphanumeric vendor id (device_id == vehicle_no) verbatim', () => {
    const wheelseye: VehicleMasterMasterRow = {
      ...VM_AP02TA2569,
      vehicle_no: 'AP03TC0959',
      device_id: 'AP03TC0959',
      device_type: 'VENDOR_GPS',
    };
    const plan = mapDevice(wheelseye, { currentVehicleId: 12n });
    expect(plan.where).toEqual({ deviceId: 'AP03TC0959' });
    expect(plan.create.deviceType).toBe('VENDOR_GPS');
  });

  it('returns null for a vehicle row with no fitted device (blank / "NULL" device_id)', () => {
    expect(mapDevice({ ...VM_AP02TA2569, device_id: null }, { currentVehicleId: 1n })).toBeNull();
    expect(mapDevice({ ...VM_AP02TA2569, device_id: 'NULL' }, { currentVehicleId: 1n })).toBeNull();
  });
});
