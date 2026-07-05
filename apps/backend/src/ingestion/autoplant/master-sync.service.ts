import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { MasterSyncRunService, type EntityStat, type MasterSyncOutcome } from './master-sync-run.service';
import {
  mapCompany,
  mapDevice,
  mapPlant,
  mapTransporter,
  mapVehicle,
  plantInScope,
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
 * Cap on `master_sync_rejects` rows written per run (review A5). The itemisation exists to answer
 * "which rows and why" after a run; beyond this bound the per-reason counters still carry the
 * totals, and writing tens of thousands of reject rows per sync would cost more than it informs.
 */
const REJECT_CAP_PER_RUN = 5000;

/**
 * Master synchroniser (blueprint §5) — upserts `company_master` / `transporters` / `plants` /
 * `vehicles` / `devices` from AutoPlant, keyed by `source_*_id`, in FK dependency order (companies →
 * transporters → plants → vehicles → devices), recording a `master_sync_runs` row for observability.
 *
 * **Plant-first derivation.** `mst_plant` is the authoritative master (DB team) and its `company_id` is
 * NOT NULL, so scope is anchored on plants, and companies are DERIVED — created only when an in-scope
 * plant names them. This removes any company allow-list and drops all reliance on the dirty
 * `mst_company.company_type` (real customers are typed 'NA'): transporters own no plants so they never
 * become companies, and INACTIVE/vendor companies fall out because no active in-scope plant references
 * them. The one gated decision left is **R6** — the {@link PlantZoneResolver} (state→zone map); an
 * unmappable plant is deferred, not force-zoned, and the residual test-plant-in-a-real-state is an
 * Ops-Head exception-queue concern at the plant grain, not a company list.
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
    // Scope is anchored on mst_plant.status; ACTIVE is the documented baseline (§5.5), not a business
    // gate (that is the injected PlantZoneResolver, R6). Callers may narrow/widen the status set.
    const scope: MasterSyncScope = this.scope ?? { plantStatuses: ['ACTIVE'] };

    const { runId } = await this.runService.startRun();
    const stats: Record<string, EntityStat> = {
      plants: emptyStat(),
      companies: emptyStat(),
      transporters: emptyStat(),
      vehicles: emptyStat(),
      devices: emptyStat(),
    };

    // Itemised skip accounting (review A5): every skip site splits its counter per reason and
    // buffers the skipped natural key; the buffer is flushed to `master_sync_rejects` in one
    // batched write, best-effort — accounting must never fail the sync it accounts for.
    const rejects: { entity: string; sourceKey: string; reason: string }[] = [];
    const skip = (entity: keyof typeof stats & string, sourceKey: string, reason: string): void => {
      const stat = stats[entity];
      stat.skipped++;
      stat.skippedByReason ??= {};
      stat.skippedByReason[reason] = (stat.skippedByReason[reason] ?? 0) + 1;
      if (rejects.length < REJECT_CAP_PER_RUN) rejects.push({ entity, sourceKey, reason });
    };
    const flushRejects = async (): Promise<void> => {
      if (rejects.length === 0) return;
      try {
        await this.prisma.masterSyncReject.createMany({
          data: rejects.map((r) => ({ runId, ...r })),
        });
      } catch (e) {
        this.logger.warn(
          `Master sync ${runId}: failed to write ${rejects.length} reject rows: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    };

    try {
      // 1. Plants — the scope anchor. In-scope = status allowed ∧ zone-resolvable (R6). Plants carry no
      //    company FK in FSM, so they upsert first; each in-scope plant's (NOT NULL) company_id is
      //    collected so the companies it references get created on demand.
      const plantIdBySource = new Map<string, bigint>();
      const neededCompanyIds = new Set<string>();
      for (const p of await this.source.readPlants()) {
        if (!plantInScope(p, scope)) {
          skip('plants', String(p.plant_id), 'OUT_OF_SCOPE_STATUS'); // e.g. INACTIVE
          continue;
        }
        const zone = await this.zoneResolver.resolve(p);
        if (!zone) {
          skip('plants', String(p.plant_id), 'ZONE_UNRESOLVED'); // deferred, never force-zoned (R6)
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
        const companyKey = toBigIntOrNull(p.company_id);
        if (companyKey != null) neededCompanyIds.add(companyKey.toString());
        existed ? stats.plants.updated++ : stats.plants.inserted++;
      }

      // 2. Companies — DERIVED: upsert only those an in-scope plant references. No allow-list, and
      //    mst_company.company_type is never consulted (a Transporter-typed plant owner is still an FSM
      //    customer; an unreferenced/INACTIVE-only company is inert and skipped).
      const companyIdBySource = new Map<string, bigint>();
      for (const c of await this.source.readCompanies()) {
        const key = BigInt(String(c.company_id).trim()).toString();
        if (!neededCompanyIds.has(key)) {
          skip('companies', key, 'NO_INSCOPE_PLANT'); // inert company — nothing in scope names it
          continue;
        }
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

      // 3. Transporters — best-effort company FK, keyed by source_transporter_id.
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

      // 4/5. Vehicles + devices (both from the tb_vehiclemaster master columns).
      const vehicleMasters = await this.source.readVehicleMasters();
      const vehicleIdByNo = new Map<string, bigint>();
      for (const v of vehicleMasters) {
        const plantId = plantIdBySource.get(String(toBigIntOrNull(v.plant_id)));
        const companyId = companyIdBySource.get(String(toBigIntOrNull(v.company_id)));
        if (plantId == null || companyId == null) {
          // Vehicle hangs off an unsynced (out-of-scope/deferred) plant or company.
          skip(
            'vehicles',
            v.vehicle_no.trim(),
            plantId == null ? 'PLANT_NOT_SYNCED' : 'COMPANY_NOT_SYNCED',
          );
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
          // Itemise by device id when the row carries one; a deviceless row falls back to its vehicle.
          const deviceKey = String(v.device_id ?? '').trim() || v.vehicle_no.trim();
          skip('devices', deviceKey, currentVehicleId == null ? 'VEHICLE_NOT_SYNCED' : 'NO_FITTED_DEVICE');
          continue;
        }
        const existed = await this.prisma.device.findUnique({
          where: plan.where,
          select: { deviceId: true },
        });
        await this.prisma.device.upsert({ where: plan.where, create: plan.create, update: plan.update });
        existed ? stats.devices.updated++ : stats.devices.inserted++;
      }

      await flushRejects();
      await this.runService.finishRun(runId, { status: 'SUCCESS', entityStats: stats });
      this.logger.log(`Master sync ${runId} SUCCESS ${JSON.stringify(stats)}`);
      return { runId, status: 'SUCCESS', stats };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await flushRejects(); // partial accounting is still worth keeping on a FAILED run
      await this.runService.finishRun(runId, { status: 'FAILED', entityStats: stats, error: message });
      this.logger.error(`Master sync ${runId} FAILED: ${message}`);
      throw e;
    }
  }
}
