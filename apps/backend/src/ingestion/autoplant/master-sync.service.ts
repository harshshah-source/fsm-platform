import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { MasterSyncRunService, type EntityStat, type MasterSyncOutcome } from './master-sync-run.service';
import {
  companyMatchesScope,
  mapCompany,
  mapDevice,
  mapPlant,
  mapTransporter,
  mapVehicle,
  toBigIntOrNull,
  type CompanyDefaults,
  type MasterSyncScope,
  type MstCompanyRow,
  type MstPlantRow,
  type MstTransporterRow,
  type VehicleMasterMasterRow,
} from './master-mapping';

/**
 * Port over `ap_masters` (+ the master columns of `ap_widgets.tb_vehiclemaster`). The real
 * implementation reads MySQL via `AutoPlantMysqlClient` (VPN-gated); tests inject a fake. Keeping this
 * a seam mirrors how `SourceReader` isolates the Snapshot path from the DB.
 */
export interface MasterSyncSource {
  readCompanies(): Promise<MstCompanyRow[]>;
  readTransporters(): Promise<MstTransporterRow[]>;
  readPlants(): Promise<MstPlantRow[]>;
  readVehicleMasters(): Promise<VehicleMasterMasterRow[]>;
}

/**
 * The FSM **operational** zone assignment for a synced plant (blueprint §5.2 / Risk R6). The real
 * resolver is the `plant_state → FSM zone` map (cross-checked vs `source_zone_name`, Ops-override,
 * UNZONED holding zone + exception queue) — all **business-gated**, so it is NOT built here. This port
 * is the seam; returning `null` means "unmappable" and the plant is deferred (never force-zoned).
 */
export interface PlantZoneResolver {
  resolve(plant: MstPlantRow): Promise<{ zoneId: bigint; districtId: bigint | null } | null>;
}

export const MASTER_SYNC_SOURCE = Symbol('MASTER_SYNC_SOURCE');
export const PLANT_ZONE_RESOLVER = Symbol('PLANT_ZONE_RESOLVER');
export const MASTER_SYNC_SCOPE = Symbol('MASTER_SYNC_SCOPE');
export const MASTER_SYNC_COMPANY_DEFAULTS = Symbol('MASTER_SYNC_COMPANY_DEFAULTS');

export interface MasterSyncResult {
  runId: bigint;
  status: MasterSyncOutcome;
  stats: Record<string, EntityStat>;
}

const emptyStat = (): EntityStat => ({ inserted: 0, updated: 0, skipped: 0 });

/**
 * Master synchroniser (blueprint §5) — upserts `company_master` / `transporters` / `plants` /
 * `vehicles` / `devices` from AutoPlant, keyed by `source_*_id`, in FK dependency order (companies →
 * transporters → plants → vehicles → devices), recording a `master_sync_runs` row for observability.
 *
 * The synchroniser only lands the **mechanism**. Two decisions stay business-gated and arrive as
 * injected collaborators — never invented here:
 *  - **R14 scoping** — which companies/plants are FSM's fleet. Supplied as {@link MasterSyncScope};
 *    with no scope configured the sync refuses to run rather than mirroring transporters/test rows.
 *  - **R6 operational zone** — {@link PlantZoneResolver}; an unmappable plant is deferred, not
 *    force-assigned to an invented zone.
 *
 * The anti-drift guarantee (Risk R4) is structural: the pure `master-mapping` layer excludes every
 * FSM-owned column from its `update` set, so a re-sync can never clobber `ops_override`/tier/rank,
 * the operational `zone_id`, or `deal_type`.
 */
@Injectable()
export class MasterSyncService {
  private readonly logger = new Logger(MasterSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly runService: MasterSyncRunService,
    @Inject(MASTER_SYNC_SOURCE) private readonly source: MasterSyncSource,
    @Inject(PLANT_ZONE_RESOLVER) private readonly zoneResolver: PlantZoneResolver,
    @Optional() @Inject(MASTER_SYNC_SCOPE) private readonly scope: MasterSyncScope | null = null,
    @Optional() @Inject(MASTER_SYNC_COMPANY_DEFAULTS) private readonly companyDefaults: CompanyDefaults = {},
  ) {}

  async sync(): Promise<MasterSyncResult> {
    // R14 gate — no invented default. Until Ops Head + AutoPlant define the fleet scope, the sync is
    // inert rather than mirroring the whole (transporter/test/INACTIVE-polluted) master set.
    if (!this.scope) {
      throw new Error(
        'MasterSyncService: no scope configured (R14). Set which company_type/status rows are FSM’s ' +
          'fleet before running — mirroring ap_masters verbatim pollutes ops + the Fleet-Uptime denominator.',
      );
    }

    const { runId } = await this.runService.startRun();
    const stats: Record<string, EntityStat> = {
      companies: emptyStat(),
      transporters: emptyStat(),
      plants: emptyStat(),
      vehicles: emptyStat(),
      devices: emptyStat(),
    };

    try {
      // 1. Companies (scoped) → source→FSM id map for downstream FK resolution.
      const companyIdBySource = new Map<string, bigint>();
      const inScope = (await this.source.readCompanies()).filter((c) => companyMatchesScope(c, this.scope!));
      for (const c of inScope) {
        const plan = mapCompany(c, this.companyDefaults);
        const existed = await this.prisma.company.findUnique({
          where: plan.where,
          select: { companyId: true },
        });
        const row = await this.prisma.company.upsert({
          where: plan.where,
          create: plan.create,
          update: plan.update,
          select: { companyId: true },
        });
        companyIdBySource.set(plan.where.sourceCompanyId.toString(), row.companyId);
        existed ? stats.companies.updated++ : stats.companies.inserted++;
      }

      // 2. Transporters — best-effort company FK, keyed by source_transporter_id.
      const transporterIdBySource = new Map<string, bigint>();
      for (const t of await this.source.readTransporters()) {
        const companyId = companyIdBySource.get(String(toBigIntOrNull(t.company_id))) ?? null;
        const plan = mapTransporter(t, { companyId });
        const existed = await this.prisma.transporter.findUnique({
          where: plan.where,
          select: { transporterId: true },
        });
        const row = await this.prisma.transporter.upsert({
          where: plan.where,
          create: plan.create,
          update: plan.update,
          select: { transporterId: true },
        });
        transporterIdBySource.set(plan.where.sourceTransporterId.toString(), row.transporterId);
        existed ? stats.transporters.updated++ : stats.transporters.inserted++;
      }

      // 3. Plants — only in-scope companies; operational zone via the (gated) resolver, else deferred.
      const plantIdBySource = new Map<string, bigint>();
      for (const p of await this.source.readPlants()) {
        const companyKey = String(toBigIntOrNull(p.company_id));
        if (!companyIdBySource.has(companyKey)) {
          stats.plants.skipped++; // plant of an out-of-scope company
          continue;
        }
        const zone = await this.zoneResolver.resolve(p);
        if (!zone) {
          stats.plants.skipped++; // unmappable → deferred (no invented UNZONED holding zone; R6)
          continue;
        }
        const plan = mapPlant(p, { zoneId: zone.zoneId, districtId: zone.districtId });
        const existed = await this.prisma.plant.findUnique({
          where: plan.where,
          select: { plantId: true },
        });
        const row = await this.prisma.plant.upsert({
          where: plan.where,
          create: plan.create,
          update: plan.update,
          select: { plantId: true },
        });
        plantIdBySource.set(plan.where.sourcePlantId.toString(), row.plantId);
        existed ? stats.plants.updated++ : stats.plants.inserted++;
      }

      // 4/5. Vehicles + devices (both from the tb_vehiclemaster master columns).
      const vehicleMasters = await this.source.readVehicleMasters();
      const vehicleIdByNo = new Map<string, bigint>();
      for (const v of vehicleMasters) {
        const plantId = plantIdBySource.get(String(toBigIntOrNull(v.plant_id)));
        const companyId = companyIdBySource.get(String(toBigIntOrNull(v.company_id)));
        if (plantId == null || companyId == null) {
          stats.vehicles.skipped++; // vehicle hangs off an unsynced (out-of-scope/deferred) plant/company
          continue;
        }
        const transporterId = transporterIdBySource.get(String(toBigIntOrNull(v.transporter_id))) ?? null;
        const plan = mapVehicle(v, { plantId, companyId, transporterId });
        const existed = await this.prisma.vehicle.findUnique({
          where: plan.where,
          select: { vehicleId: true },
        });
        const row = await this.prisma.vehicle.upsert({
          where: plan.where,
          create: plan.create,
          update: plan.update,
          select: { vehicleId: true },
        });
        vehicleIdByNo.set(v.vehicle_no.trim(), row.vehicleId);
        existed ? stats.vehicles.updated++ : stats.vehicles.inserted++;
      }

      for (const v of vehicleMasters) {
        // A device is mirrored only when its vehicle synced this run — never orphan it onto a null
        // vehicle because the plant/company was out of scope (which would also wipe its existing fitment).
        const currentVehicleId = vehicleIdByNo.get(v.vehicle_no.trim());
        const plan = currentVehicleId == null ? null : mapDevice(v, { currentVehicleId });
        if (!plan) {
          stats.devices.skipped++; // no fitted device, or the vehicle wasn't synced
          continue;
        }
        const existed = await this.prisma.device.findUnique({
          where: plan.where,
          select: { deviceId: true },
        });
        await this.prisma.device.upsert({ where: plan.where, create: plan.create, update: plan.update });
        existed ? stats.devices.updated++ : stats.devices.inserted++;
      }

      await this.runService.finishRun(runId, { status: 'SUCCESS', entityStats: stats });
      this.logger.log(`Master sync ${runId} SUCCESS ${JSON.stringify(stats)}`);
      return { runId, status: 'SUCCESS', stats };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await this.runService.finishRun(runId, { status: 'FAILED', entityStats: stats, error: message });
      this.logger.error(`Master sync ${runId} FAILED: ${message}`);
      throw e;
    }
  }
}
