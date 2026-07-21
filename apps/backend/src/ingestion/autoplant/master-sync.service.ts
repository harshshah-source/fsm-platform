import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { DeviceDepartureService } from '../../device-departure/device-departure.service';
import type { PlantEligibleFloatingSeService } from '../../org/plant-eligible-floating-se.service';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MasterSyncRunService, type EntityStat, type MasterSyncOutcome } from './master-sync-run.service';
import {
  isOperationalStatus,
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

export interface MasterSyncOptions {
  /** Override the departure absence-diff blast limiter for this run (Issue 128). */
  maxAbsenceRatio?: number;
}

const emptyStat = (): EntityStat => ({ inserted: 0, updated: 0, skipped: 0 });

/**
 * How many per-row upserts are grouped into one batched `$transaction` round trip (write side only —
 * the DBA ≤90-row cap governs *reads from AutoPlant*, not writes to FSM Postgres). Collapses the
 * per-row round-trip storm (a `findUnique` + `upsert` each, ~2 per source row over ~54k vehicles +
 * ~54k devices) into a handful of batched transactions. The pure mapping plans are unchanged, so the
 * structural anti-drift guarantee (FSM-owned columns excluded from every `update`) is preserved.
 */
const UPSERT_BATCH_SIZE = 500;

const chunk = <T>(arr: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

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
    /**
     * Device deployment lifecycle (Issue 128). Optional because the lifecycle pass is only meaningful
     * against a source read that covers ALL deployment statuses — omitted, the sync mirrors exactly as
     * before and marks no departures (never a silent half-application).
     */
    @Optional() private readonly departures: DeviceDepartureService | null = null,
    /**
     * Floating-SE eligibility MV (Issue 138 slice 2). Optional because master-sync must run in contexts
     * that don't wire the org module (tests, minimal boots); omitted, the sync mirrors exactly as before
     * and the MV is left to the periodic backstop (slice 3) / the next run.
     */
    @Optional() private readonly floatingEligibility: PlantEligibleFloatingSeService | null = null,
  ) {}

  async sync(options: MasterSyncOptions = {}): Promise<MasterSyncResult> {
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
      // Issue 128 lifecycle counters: `inserted` = departures opened, `updated` = restores.
      departures: emptyStat(),
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
      // 1. Plants — the scope anchor. In-scope = status allowed ∧ zone-resolvable (R6). Zone resolution
      //    stays per-plant (business logic, R6); the WRITES are batched. Each in-scope plant's (NOT NULL)
      //    company_id is collected so the companies it references get created on demand.
      const plantIdBySource = new Map<string, bigint>();
      const neededCompanyIds = new Set<string>();
      const plantPlans: ReturnType<typeof mapPlant>[] = [];
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
        plantPlans.push(mapPlant(p, { zoneId: zone.zoneId, districtId: zone.districtId }));
        const companyKey = toBigIntOrNull(p.company_id);
        if (companyKey != null) neededCompanyIds.add(companyKey.toString());
      }
      const existingPlants = await this.existingKeys(
        () => this.prisma.plant.findMany({ where: { sourcePlantId: { not: null } }, select: { sourcePlantId: true } }),
        (r) => r.sourcePlantId!.toString(),
      );
      const plantRows = await this.batchUpsert(plantPlans, (pl) =>
        this.prisma.plant.upsert({ where: pl.where, create: pl.create, update: pl.update, select: { plantId: true } }),
      );
      plantPlans.forEach((pl, i) => {
        const key = pl.where.sourcePlantId.toString();
        plantIdBySource.set(key, plantRows[i].plantId);
        existingPlants.has(key) ? stats.plants.updated++ : stats.plants.inserted++;
      });

      // 2. Companies — DERIVED: upsert only those an in-scope plant references. No allow-list, and
      //    mst_company.company_type is never consulted (a Transporter-typed plant owner is still an FSM
      //    customer; an unreferenced/INACTIVE-only company is inert and skipped).
      const companyIdBySource = new Map<string, bigint>();
      const companyPlans: ReturnType<typeof mapCompany>[] = [];
      for (const c of await this.source.readCompanies()) {
        const key = BigInt(String(c.company_id).trim()).toString();
        if (!neededCompanyIds.has(key)) {
          skip('companies', key, 'NO_INSCOPE_PLANT'); // inert company — nothing in scope names it
          continue;
        }
        companyPlans.push(mapCompany(c, this.companyDefaults));
      }
      const existingCompanies = await this.existingKeys(
        () => this.prisma.company.findMany({ where: { sourceCompanyId: { not: null } }, select: { sourceCompanyId: true } }),
        (r) => r.sourceCompanyId!.toString(),
      );
      const companyRows = await this.batchUpsert(companyPlans, (pl) =>
        this.prisma.company.upsert({ where: pl.where, create: pl.create, update: pl.update, select: { companyId: true } }),
      );
      companyPlans.forEach((pl, i) => {
        const key = pl.where.sourceCompanyId.toString();
        companyIdBySource.set(key, companyRows[i].companyId);
        existingCompanies.has(key) ? stats.companies.updated++ : stats.companies.inserted++;
      });

      // 3. Transporters — best-effort company FK, keyed by source_transporter_id.
      const transporterIdBySource = new Map<string, bigint>();
      const transporterPlans = (await this.source.readTransporters()).map((t) =>
        mapTransporter(t, { companyId: companyIdBySource.get(String(toBigIntOrNull(t.company_id))) ?? null }),
      );
      const existingTransporters = await this.existingKeys(
        () =>
          this.prisma.transporter.findMany({
            where: { sourceTransporterId: { not: null } },
            select: { sourceTransporterId: true },
          }),
        (r) => r.sourceTransporterId!.toString(),
      );
      const transporterRows = await this.batchUpsert(transporterPlans, (pl) =>
        this.prisma.transporter.upsert({
          where: pl.where,
          create: pl.create,
          update: pl.update,
          select: { transporterId: true },
        }),
      );
      transporterPlans.forEach((pl, i) => {
        const key = pl.where.sourceTransporterId.toString();
        transporterIdBySource.set(key, transporterRows[i].transporterId);
        existingTransporters.has(key) ? stats.transporters.updated++ : stats.transporters.inserted++;
      });

      // 4. Vehicles — skip any whose plant/company is unsynced, then apply the Issue 128 INSERT-SCOPE
      //    PIN. The read is widened to every deployment_status so departures can be OBSERVED (§128), but
      //    the create scope must stay the OPERATIONAL fleet: a vehicle FSM has never seen, arriving
      //    non-operational, is counted and dropped — never inserted. Mirroring the whole source catalog
      //    would take `vehicles` ~21k → ~48k and change the meaning of every dashboard total.
      //    A vehicle FSM ALREADY knows is always upserted regardless of status, so its `status` mirror
      //    finally tells the truth (that update is exactly what the departure pass keys on).
      const vehicleMasters = await this.source.readVehicleMasters();
      const existingVehicles = await this.existingKeys(
        () => this.prisma.vehicle.findMany({ select: { vehicleNo: true } }),
        (r) => r.vehicleNo,
      );
      const vehicleIdByNo = new Map<string, bigint>();
      const vehiclePlans: ReturnType<typeof mapVehicle>[] = [];
      for (const v of vehicleMasters) {
        const plantId = plantIdBySource.get(String(toBigIntOrNull(v.plant_id)));
        const companyId = companyIdBySource.get(String(toBigIntOrNull(v.company_id)));
        if (plantId == null || companyId == null) {
          skip('vehicles', v.vehicle_no.trim(), plantId == null ? 'PLANT_NOT_SYNCED' : 'COMPANY_NOT_SYNCED');
          continue;
        }
        const vehicleNo = v.vehicle_no.trim();
        if (!isOperationalStatus(v.deployment_status) && !existingVehicles.has(vehicleNo)) {
          skip('vehicles', vehicleNo, 'NOT_DEPLOYED_NEVER_KNOWN'); // the pin — read, counted, not mirrored
          continue;
        }
        const transporterId = transporterIdBySource.get(String(toBigIntOrNull(v.transporter_id))) ?? null;
        vehiclePlans.push(mapVehicle(v, { plantId, companyId, transporterId }));
      }
      const vehicleRows = await this.batchUpsert(vehiclePlans, (pl) =>
        this.prisma.vehicle.upsert({ where: pl.where, create: pl.create, update: pl.update, select: { vehicleId: true } }),
      );
      vehiclePlans.forEach((pl, i) => {
        vehicleIdByNo.set(pl.where.vehicleNo, vehicleRows[i].vehicleId);
        existingVehicles.has(pl.where.vehicleNo) ? stats.vehicles.updated++ : stats.vehicles.inserted++;
      });

      // 5. Devices — mirrored only when their vehicle synced this run (never orphan a fitment onto a null
      //    vehicle because the plant/company was out of scope). The insert-scope pin applies here too: a
      //    never-known device newly fitted to a non-operational vehicle is not created either.
      const existingDevices = await this.existingKeys(
        () => this.prisma.device.findMany({ select: { deviceId: true } }),
        (r) => r.deviceId,
      );
      const devicePlans: NonNullable<ReturnType<typeof mapDevice>>[] = [];
      for (const v of vehicleMasters) {
        const currentVehicleId = vehicleIdByNo.get(v.vehicle_no.trim());
        const plan = currentVehicleId == null ? null : mapDevice(v, { currentVehicleId });
        if (!plan) {
          const deviceKey = String(v.device_id ?? '').trim() || v.vehicle_no.trim();
          const reason = currentVehicleId != null
            ? 'NO_FITTED_DEVICE'
            : !isOperationalStatus(v.deployment_status) && !existingVehicles.has(v.vehicle_no.trim())
              ? 'NOT_DEPLOYED_NEVER_KNOWN'
              : 'VEHICLE_NOT_SYNCED';
          skip('devices', deviceKey, reason);
          continue;
        }
        if (!isOperationalStatus(v.deployment_status) && !existingDevices.has(plan.where.deviceId)) {
          skip('devices', plan.where.deviceId, 'NOT_DEPLOYED_NEVER_KNOWN');
          continue;
        }
        devicePlans.push(plan);
      }
      await this.batchUpsert(devicePlans, (pl) =>
        this.prisma.device.upsert({ where: pl.where, create: pl.create, update: pl.update, select: { deviceId: true } }),
      );
      devicePlans.forEach((pl) => {
        existingDevices.has(pl.where.deviceId) ? stats.devices.updated++ : stats.devices.inserted++;
      });

      // 6. Deployment lifecycle (Issue 128) — mark departures / restores from the SAME read the mirror
      //    was built from. Runs last: the mirror is already truthful, so this only opens/closes the
      //    FSM-owned side rows and cancels the open work of devices that left the fleet.
      await this.reconcileDepartures(runId, vehicleMasters, plantIdBySource, stats, options);

      await flushRejects();
      await this.runService.finishRun(runId, { status: 'SUCCESS', entityStats: stats });
      this.logger.log(`Master sync ${runId} SUCCESS ${JSON.stringify(stats)}`);
      // 7. Floating-SE eligibility MV (Issue 138 slice 2) — plants/districts (its geometry inputs) just
      //    changed, so a stale MV would give the Recommender wrong floating coverage for new/relocated
      //    plants. Refreshed AFTER the mirror committed; best-effort like the departure pass.
      await this.refreshFloatingEligibility(runId);
      return { runId, status: 'SUCCESS', stats };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await flushRejects(); // partial accounting is still worth keeping on a FAILED run
      await this.runService.finishRun(runId, { status: 'FAILED', entityStats: stats, error: message });
      this.logger.error(`Master sync ${runId} FAILED: ${message}`);
      throw e;
    }
  }

  /**
   * Best-effort refresh of `plant_eligible_floating_se` after a successful master sync (Issue 138
   * slice 2). A refresh failure is logged and swallowed — it must never fail the mirror sync that
   * already committed; the periodic backstop (slice 3) or the next run heals a missed refresh.
   */
  private async refreshFloatingEligibility(runId: bigint): Promise<void> {
    if (!this.floatingEligibility) return;
    try {
      await this.floatingEligibility.refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error(`Master sync ${runId}: floating-eligibility MV refresh failed (mirror committed): ${message}`);
    }
  }

  /**
   * Drive the Issue 128 lifecycle pass from this run's read. Two inputs matter and both come from the
   * read itself, so detection can never disagree with what was mirrored:
   *
   *  - `observed`: every device_id the read returned → its verbatim status. MEMBERSHIP is what
   *    separates "observed non-operational" (trustworthy → depart) from "absent" (inferred → guarded).
   *  - `syncedPlantIds`: the plants this run actually covered. Absence is only meaningful inside the
   *    scope the read visited — without this bound, every FSM device under a non-AutoPlant plant (dev
   *    seed rows, plants that fell out of ACTIVE scope) would be inferred MISSING_FROM_SOURCE.
   *
   * A lifecycle failure must not fail the mirror sync that already committed: it is logged and counted,
   * never rethrown — the next run re-derives the same departures from the source (nothing is lost).
   */
  private async reconcileDepartures(
    runId: bigint,
    vehicleMasters: VehicleMasterMasterRow[],
    plantIdBySource: Map<string, bigint>,
    stats: Record<string, EntityStat>,
    options: MasterSyncOptions,
  ): Promise<void> {
    if (!this.departures) return;
    const observed = new Map<string, string | null>();
    for (const v of vehicleMasters) {
      const deviceId = String(v.device_id ?? '').trim();
      if (deviceId !== '') observed.set(deviceId, v.deployment_status);
    }
    try {
      const result = await this.departures.reconcile({
        observed,
        syncedPlantIds: [...plantIdBySource.values()],
        runId,
        maxAbsenceRatio: options.maxAbsenceRatio,
      });
      stats.departures.inserted = result.departed;
      stats.departures.updated = result.restored;
      if (Object.keys(result.skippedByReason).length > 0) {
        stats.departures.skipped = Object.values(result.skippedByReason).reduce((a, b) => a + b, 0);
        stats.departures.skippedByReason = result.skippedByReason;
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      stats.departures.skipped++;
      stats.departures.skippedByReason = { ...stats.departures.skippedByReason, RECONCILE_FAILED: 1 };
      this.logger.error(`Master sync ${runId}: departure reconcile failed (mirror is committed): ${message}`);
    }
  }

  /**
   * Preload the set of already-mirrored natural keys for an entity in ONE query, so inserted-vs-updated
   * can be classified in memory — replacing the per-row `findUnique` that ran before every upsert. Loads
   * all rows for the (fleet-bounded) mirror table rather than an `IN (…)` over tens of thousands of ids,
   * which both avoids the Postgres bind-parameter ceiling and is a single sequential scan.
   */
  private async existingKeys<T>(load: () => Promise<T[]>, keyOf: (row: T) => string): Promise<Set<string>> {
    return new Set((await load()).map(keyOf));
  }

  /**
   * Upsert `plans` in batched `$transaction` groups, returning the results index-aligned with `plans`
   * (so callers can wire generated ids into their source→id maps). Each group commits as one round trip.
   */
  private async batchUpsert<P, R>(plans: P[], toOp: (plan: P) => Prisma.PrismaPromise<R>): Promise<R[]> {
    const results: R[] = [];
    for (const group of chunk(plans, UPSERT_BATCH_SIZE)) {
      const settled = (await this.prisma.$transaction(group.map(toOp))) as R[];
      results.push(...settled);
    }
    return results;
  }
}
