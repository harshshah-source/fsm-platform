import {
  AutoPlantHealthService,
  readReconMaxDrift,
  type AutoPlantProbe,
  type MasterSourceCounts,
} from '../src/ingestion/autoplant/health.service';
import { AutoPlantMasterSource } from '../src/ingestion/autoplant/autoplant-master-source';
import { OPERATIONAL_DEPLOYMENT_STATUSES } from '../src/ingestion/autoplant/master-mapping';
import { PrismaService } from '../src/prisma/prisma.service';

/** Mirror of `AutoPlantMasterSource.inClause` — keeps the expected SQL derived, never hand-counted. */
const placeholders = (column: string, values: readonly string[]): string =>
  `${column} IN (${values.map(() => '?').join(', ')})`;

/**
 * Issue 97 Slice 5 (review A6) — reconciliation counts in `GET /api/integration/health`. A master
 * sync could report SUCCESS while silently mirroring a fraction of the fleet; nothing compared FSM
 * row counts to AutoPlant's. The health surface now diffs, per entity, a source-side single-row
 * `COUNT(*)` (same filters the sync uses) against the FSM table count and reports
 * `{ entity, sourceCount, fsmCount, drift }` plus a top-level `reconciled` flag. Degraded (source
 * unreachable / unconfigured) → `reconciled: null` + error, never a crash: freshness stays useful.
 * Drift is informational (review risk: noisy while the zone-mapping queue drains) — the threshold
 * `INGESTION_RECON_MAX_DRIFT` (absolute rows, default 0) is ops-configurable, not a business rule.
 */
const okProbe: AutoPlantProbe = {
  isConfigured: () => true,
  ping: async () => ({ ok: true, vehicleRows: 42 }),
};

describe('Issue 97 Slice 5 — reconciliation counts in integration health', () => {
  let prisma: PrismaService;
  let fsmPlants: number;
  let fsmVehicles: number;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
  });

  beforeEach(async () => {
    // The FSM side of the diff is whatever is in the tables right now — observed independently here.
    fsmPlants = await prisma.plant.count();
    fsmVehicles = await prisma.vehicle.count();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  const countsOf = (plants: number, vehicles: number): MasterSourceCounts => ({
    countPlants: async () => plants,
    countVehicleMasters: async () => vehicles,
  });

  it('reports per-entity sourceCount/fsmCount/drift and reconciled=true when counts match', async () => {
    const service = new AutoPlantHealthService(prisma, okProbe, countsOf(fsmPlants, fsmVehicles));
    const health = await service.check();

    expect(health.reconciliation.entities).toEqual([
      { entity: 'plants', sourceCount: fsmPlants, fsmCount: fsmPlants, drift: 0 },
      { entity: 'vehicles', sourceCount: fsmVehicles, fsmCount: fsmVehicles, drift: 0 },
    ]);
    expect(health.reconciliation.reconciled).toBe(true);
  });

  it('flags drift: source ahead of FSM → positive drift, reconciled=false at the default 0 threshold', async () => {
    const service = new AutoPlantHealthService(
      prisma,
      okProbe,
      countsOf(fsmPlants + 3, fsmVehicles),
    );
    const health = await service.check();

    const plants = health.reconciliation.entities.find((e) => e.entity === 'plants');
    expect(plants).toEqual({
      entity: 'plants',
      sourceCount: fsmPlants + 3,
      fsmCount: fsmPlants,
      drift: 3,
    });
    expect(health.reconciliation.reconciled).toBe(false);
    expect(health.reconciliation.maxDriftAllowed).toBe(0);
  });

  it('degrades to reconciled=null when unconfigured (no counts) — freshness stays intact', async () => {
    const service = new AutoPlantHealthService(prisma, okProbe); // two-arg call: pre-slice-5 wiring
    const health = await service.check();

    expect(health.reconciliation.entities).toEqual([]);
    expect(health.reconciliation.reconciled).toBeNull();
    expect(health.reconciliation.error).toMatch(/not configured/i);
    expect(health.masterSync).toBeDefined(); // the pre-existing surfaces are untouched
    expect(health.snapshot).toBeDefined();
  });

  it('degrades to reconciled=null when a count read fails (VPN drop) — never a crash', async () => {
    const service = new AutoPlantHealthService(prisma, okProbe, {
      countPlants: async () => {
        throw new Error('ETIMEDOUT 10.0.0.25:3306');
      },
      countVehicleMasters: async () => 1,
    });
    const health = await service.check();

    expect(health.reconciliation.entities).toEqual([]);
    expect(health.reconciliation.reconciled).toBeNull();
    expect(health.reconciliation.error).toMatch(/ETIMEDOUT/);
  });

  it('tolerates drift within INGESTION_RECON_MAX_DRIFT — reconciled=true while the queue drains', async () => {
    process.env.INGESTION_RECON_MAX_DRIFT = '5';
    try {
      const service = new AutoPlantHealthService(
        prisma,
        okProbe,
        countsOf(fsmPlants + 3, fsmVehicles),
      );
      const health = await service.check();

      expect(health.reconciliation.entities.find((e) => e.entity === 'plants')?.drift).toBe(3);
      expect(health.reconciliation.reconciled).toBe(true); // |3| <= 5
      expect(health.reconciliation.maxDriftAllowed).toBe(5);
    } finally {
      delete process.env.INGESTION_RECON_MAX_DRIFT;
    }
  });

  it('readReconMaxDrift: default 0; env override; garbage/negative fall back to 0', () => {
    expect(readReconMaxDrift({})).toBe(0);
    expect(readReconMaxDrift({ INGESTION_RECON_MAX_DRIFT: '25' })).toBe(25);
    expect(readReconMaxDrift({ INGESTION_RECON_MAX_DRIFT: 'lots' })).toBe(0);
    expect(readReconMaxDrift({ INGESTION_RECON_MAX_DRIFT: '-4' })).toBe(0);
  });

  it('AutoPlantMasterSource counts: one single-row COUNT each, reusing the sync filters', async () => {
    const calls: { sql: string; params: unknown }[] = [];
    const plantStatuses = ['ACTIVE'];
    const source = new AutoPlantMasterSource({
      query: async <T>(sql: string, params?: readonly unknown[]): Promise<T[]> => {
        calls.push({ sql, params });
        return [{ c: 17 }] as T[];
      },
      mastersSchema: 'ap_masters',
      plantStatuses,
      // READ scope only — since Issue 128 this is `[]` (every status) in production so departures are
      // observable. It deliberately does NOT drive countVehicleMasters; see the next assertion block.
      deploymentStatuses: [],
    });

    expect(await source.countPlants()).toBe(17);
    expect(await source.countVehicleMasters()).toBe(17);
    expect(calls).toHaveLength(2); // one physical query per count — never a paged enumeration

    // Plants: DISTINCT plant_id (mirrors readPlants' composite-PK dedup) under the same status filter.
    expect(calls[0].sql).toMatch(/SELECT COUNT\(DISTINCT plant_id\) AS c FROM `ap_masters`\.`mst_plant`/);
    expect(calls[0].sql).toContain(placeholders('status', plantStatuses));
    expect(calls[0].params).toEqual(plantStatuses);

    // Vehicles: plain COUNT(*) under the OPERATIONAL filter (no join — the count needs no company).
    // Derived from the exported constant, never a duplicated literal: #128 widened it from
    // ['DEPLOYED'] to ['DEPLOYED','ACTIVE'] and this assertion silently desynced, leaving the whole
    // backend suite red for 43 commits. Deriving it means the next widening cannot repeat that.
    expect(calls[1].sql).toMatch(/SELECT COUNT\(\*\) AS c FROM `ap_masters`\.`mst_vehicle`/);
    expect(calls[1].sql).toContain(placeholders('deployment_status', OPERATIONAL_DEPLOYMENT_STATUSES));
    expect(calls[1].params).toEqual(OPERATIONAL_DEPLOYMENT_STATUSES);
  });

  it('countVehicleMasters counts the OPERATIONAL scope, not the READ scope', async () => {
    // The regression that made the assertion above stale was not really a changed literal — it was
    // that the spec injected `deploymentStatuses` (the READ scope) while countVehicleMasters reads
    // `operationalStatuses` (the create/reconciliation scope). The injection was inert, so the test
    // was pinning a default it did not know it was pinning. This pins WHICH knob drives the count.
    const calls: { sql: string; params: unknown }[] = [];
    const operationalStatuses = ['DEPLOYED', 'ACTIVE', 'IN_TRANSIT'];
    const source = new AutoPlantMasterSource({
      query: async <T>(sql: string, params?: readonly unknown[]): Promise<T[]> => {
        calls.push({ sql, params });
        return [{ c: 3 }] as T[];
      },
      mastersSchema: 'ap_masters',
      deploymentStatuses: [], // read every status — must NOT reach the count
      operationalStatuses,
    });

    expect(await source.countVehicleMasters()).toBe(3);
    expect(calls[0].sql).toContain(placeholders('deployment_status', operationalStatuses));
    expect(calls[0].params).toEqual(operationalStatuses);
  });
});
