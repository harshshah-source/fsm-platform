import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import {
  MASTER_SYNC_SOURCE,
  MasterSyncService,
  type MasterSyncSource,
} from '../src/ingestion/autoplant/master-sync.service';
import { PrismaService } from '../src/prisma/prisma.service';
import type {
  MstCompanyRow,
  MstPlantRow,
  MstTransporterRow,
  VehicleMasterMasterRow,
} from '../src/ingestion/autoplant/master-mapping';

/**
 * `device_commissioning` — the append-only fitment fact (feasibility assessment §7.3).
 *
 * Booted through the real `AppModule` for the reason #218 established: every pre-existing master-sync
 * test constructs the service by hand, so a collaborator Nest cannot resolve stays `undefined` and the
 * suite passes anyway. A hand-built harness here would re-create exactly that blind spot, so the only
 * override is the AutoPlant source, which CI cannot reach.
 *
 * What these tests pin, in order of what would hurt most if it broke:
 *  1. Append-only-ness is STRUCTURAL. Re-syncing unchanged data must be a no-op, and a re-map must
 *     append while leaving the prior row byte-identical. No UPDATE path exists to regress into.
 *  2. NULL fitment fields must not duplicate. `installed_at` is null for ~13% of source rows; under a
 *     default NULLS DISTINCT index every one re-inserts on every daily sync (NULL <> NULL) — unbounded
 *     silent growth on a cron. Asserted against `pg_index` because Prisma 7.8 cannot express the
 *     modifier, so a regenerated schema would quietly drop it.
 *  3. The write is INERT. A commissioning failure must never fail the sync that carries it.
 *  4. `installed_at` is stored in TRUE UTC (offset 0), not shifted by #222's live +330.
 */
describe('device_commissioning — append-only fitment fact (real DI graph)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let sync: MasterSyncService;

  const NS = Date.now() % 100_000;
  const SRC_COMPANY = 226001;
  const SRC_PLANT = 226002;
  const SRC_TRANSPORTER = 226003;
  const V_ONE = `ZZ226V${NS}`;
  const V_TWO = `ZZ226W${NS}`;
  const D_ONE = `RR_D226${NS}`;
  /** Naive source wall clock. AutoPlant writes UTC into its DATETIME columns — measured, see #222. */
  const INSTALLED_WALL_CLOCK = '2026-05-15 08:56:37';
  const INSTALLED_TRUE_UTC = new Date('2026-05-15T08:56:37.000Z');

  const companies: MstCompanyRow[] = [
    { company_id: SRC_COMPANY, company_name: `Commissioning Cement ${NS}`, company_type: 'NA', status: 'ACTIVE' },
  ];
  const transporters: MstTransporterRow[] = [
    {
      transporter_id: SRC_TRANSPORTER,
      company_id: SRC_COMPANY,
      transporter_name: `Commissioning Roadways ${NS}`,
      status: 'ACTIVE',
    },
  ];
  const plants: MstPlantRow[] = [
    {
      plant_id: SRC_PLANT,
      company_id: SRC_COMPANY,
      plant_name: `Commissioning Plant ${NS}`,
      zone_id: 2039,
      zone_name: 'South India',
      region_id: null,
      region_name: null,
      plant_state: 'Andhra Pradesh',
      plant_district: 'Kadapa',
      master_plant_id: null,
      master_plant_code: null,
      status: 'ACTIVE',
    },
  ];

  const vehicle = (
    vehicleNo: string,
    fitment: Partial<VehicleMasterMasterRow> = {},
  ): VehicleMasterMasterRow => ({
    vehicle_no: vehicleNo,
    device_id: D_ONE,
    plant_id: SRC_PLANT,
    company_id: SRC_COMPANY,
    transporter_id: SRC_TRANSPORTER,
    device_type: 'V5',
    imsi_no: null,
    deployment_status: 'DEPLOYED',
    first_installed_date_time: INSTALLED_WALL_CLOCK,
    first_installed_by: 'COMMISSIONING_TEST',
    installation_remark: 'New Installation',
    ...fitment,
  });

  let vehicleMasters: VehicleMasterMasterRow[] = [vehicle(V_ONE)];

  const source: MasterSyncSource = {
    readCompanies: async () => companies,
    readTransporters: async () => transporters,
    readPlants: async () => plants,
    readVehicleMasters: async () => vehicleMasters,
  };

  const facts = (): Promise<Array<Record<string, unknown>>> =>
    prisma.deviceCommissioning.findMany({
      where: { deviceId: D_ONE },
      orderBy: { commissioningId: 'asc' },
    }) as unknown as Promise<Array<Record<string, unknown>>>;

  /**
   * Run `work` with the commissioning write forced to fail, then put the real method back.
   *
   * The manual re-assignment is NOT belt-and-braces. Prisma model delegates are materialised behind a
   * Proxy, so `vi.spyOn` installs an OWN property that shadows it — and `mockRestore()` then DELETES
   * that own property without reviving the proxy behind it. Every later call throws
   * "createMany is not a function", which reads exactly like an appender bug and is not one; it cost a
   * false failure in this very file before the reassignment was added.
   */
  const withFailingCommissioningWrite = async (
    work: (spy: { mock: { calls: unknown[][] } }) => Promise<void>,
  ): Promise<void> => {
    const original = prisma.deviceCommissioning.createMany;
    const spy = vi
      .spyOn(prisma.deviceCommissioning, 'createMany')
      .mockRejectedValue(new Error('simulated commissioning write failure'));
    try {
      await work(spy as unknown as { mock: { calls: unknown[][] } });
    } finally {
      spy.mockRestore();
      prisma.deviceCommissioning.createMany = original;
    }
  };

  const cleanup = async (): Promise<void> => {
    await prisma.deviceCommissioning.deleteMany({ where: { deviceId: D_ONE } });
    await prisma.deviceDeparture.deleteMany({ where: { deviceId: D_ONE } });
    await prisma.auditLog.deleteMany({ where: { entityType: 'DEVICE', entityId: D_ONE } });
    await prisma.deviceState.deleteMany({ where: { deviceId: D_ONE } });
    await prisma.device.deleteMany({ where: { deviceId: D_ONE } });
    await prisma.vehicle.deleteMany({ where: { vehicleNo: { in: [V_ONE, V_TWO] } } });
    await prisma.transporter.deleteMany({ where: { sourceTransporterId: BigInt(SRC_TRANSPORTER) } });
    await prisma.plant.deleteMany({ where: { sourcePlantId: BigInt(SRC_PLANT) } });
    await prisma.company.deleteMany({ where: { sourceCompanyId: BigInt(SRC_COMPANY) } });
  };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MASTER_SYNC_SOURCE)
      .useValue(source)
      .compile();
    prisma = moduleRef.get(PrismaService);
    sync = moduleRef.get(MasterSyncService);
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await moduleRef.close();
  });

  it('appends one fact when a fitment is first seen, with installed_at in TRUE UTC', async () => {
    vehicleMasters = [vehicle(V_ONE)];
    const run = await sync.sync();
    expect(run.status).toBe('SUCCESS');

    const rows = await facts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      deviceId: D_ONE,
      installedBy: 'COMMISSIONING_TEST',
      installationRemark: 'New Installation',
      // Offset 0, NOT AUTOPLANT_UTC_OFFSET_MIN: a +330 here would read 03:26:37 and, being written
      // once, could never be corrected when #222 lands.
      installedAtOffsetMin: 0,
    });
    expect(rows[0].installedAt).toEqual(INSTALLED_TRUE_UTC);
    expect(rows[0].runId).not.toBeNull();
  });

  it('is a NO-OP when the same fitment is synced again — no second row, no update', async () => {
    const before = await facts();
    // Guard against the vacuous form of this test. Before the appender existed, `before` was [] and
    // this whole assertion was 0 === 0 — it passed against a table nothing wrote to. If the fixture
    // ever stops producing a fact, this must fail here rather than pass for the wrong reason.
    expect(before.length).toBeGreaterThan(0);

    await sync.sync();
    await sync.sync();
    const after = await facts();

    expect(after).toHaveLength(before.length);
    // Byte-identical, including observedAt: an UPDATE masquerading as an append would move it.
    expect(after).toEqual(before);
  });

  it('APPENDS on a re-map and leaves the earlier fact untouched', async () => {
    const before = await facts();
    vehicleMasters = [vehicle(V_TWO)]; // same device, new vehicle — a new fitment identity
    const run = await sync.sync();
    expect(run.status).toBe('SUCCESS');

    const after = await facts();
    expect(after).toHaveLength(before.length + 1);
    // The whole reason this is a table and not a column: history survives the re-map.
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after[after.length - 1]).toMatchObject({ deviceId: D_ONE });
    expect(after[after.length - 1].vehicleId).not.toEqual(before[0].vehicleId);
  });

  it('does not duplicate rows whose installed_at is NULL (the NULLS NOT DISTINCT contract)', async () => {
    const before = await facts();
    vehicleMasters = [vehicle(V_TWO, { first_installed_date_time: null, first_installed_by: null })];
    await sync.sync();
    const afterFirst = await facts();

    // The test is only about NULL de-duplication if a NULL row was actually written. Without this the
    // assertion below is "n === n" over rows that all carry a non-null installed_at, which the ordinary
    // unique index would satisfy on its own and which would still pass with the modifier dropped.
    expect(afterFirst.length).toBe(before.length + 1);
    const nulls = afterFirst.filter((r) => r.installedAt === null);
    expect(nulls).toHaveLength(1);

    await sync.sync();
    await sync.sync();
    const afterSecond = await facts();

    // Under a default NULLS DISTINCT index this grows by one row per sync, forever, silently.
    expect(afterSecond).toHaveLength(afterFirst.length);
    expect(afterSecond.filter((r) => r.installedAt === null)).toHaveLength(1);
  });

  it('snapshots first_reported_at as it stands when the fitment is observed — null when never reported', async () => {
    // The commissioning fact records what was KNOWN at observation. A device that has never pinged is
    // exactly the population this table exists to surface (#223), so null here is the signal, not a gap.
    const noPing = await facts();
    expect(noPing.length).toBeGreaterThan(0);
    expect(noPing.every((r) => r.firstReportedAt === null)).toBe(true);

    const FIRST_PING = new Date('2026-04-01T05:00:00.000Z');
    await prisma.deviceState.upsert({
      where: { deviceId: D_ONE },
      create: { deviceId: D_ONE, firstReportedAt: FIRST_PING, firstReportedOffsetMin: 0, computedAt: new Date() },
      update: { firstReportedAt: FIRST_PING, firstReportedOffsetMin: 0 },
    });

    const V_FIVE = `ZZ226Z${NS}`;
    vehicleMasters = [vehicle(V_FIVE)];
    try {
      await sync.sync();
      const after = await facts();
      expect(after).toHaveLength(noPing.length + 1);
      // The NEW fact carries the snapshot…
      expect(after[after.length - 1].firstReportedAt).toEqual(FIRST_PING);
      // …and the pre-existing ones are NOT retro-filled. A fact is what was known then, not now.
      expect(after.slice(0, noPing.length)).toEqual(noPing);
    } finally {
      await prisma.vehicle.deleteMany({ where: { vehicleNo: V_FIVE } });
      await prisma.deviceState.deleteMany({ where: { deviceId: D_ONE } });
    }
  });

  it('the unique index really is NULLS NOT DISTINCT in the database', async () => {
    // Prisma 7.8 cannot express the modifier, so schema.prisma is weaker than the migration and a
    // regenerated migration would drop it. This assertion is what makes that failure loud.
    const [idx] = await prisma.$queryRawUnsafe<Array<{ indnullsnotdistinct: boolean }>>(`
      SELECT i.indnullsnotdistinct
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
       WHERE c.relname = 'device_commissioning_device_id_vehicle_id_installed_at_key'
    `);
    expect(idx?.indnullsnotdistinct).toBe(true);
  });

  it('is INERT — a commissioning write failure must not fail the sync, and must not roll back the mirror', async () => {
    const V_THREE = `ZZ226X${NS}`;
    const before = await facts();
    vehicleMasters = [vehicle(V_THREE)];
    try {
      await withFailingCommissioningWrite(async (spy) => {
        const run = await sync.sync();

        // 1. The run survives. On its own this proves nothing — before the appender existed the sync
        //    returned SUCCESS because it never touched `deviceCommissioning` at all.
        expect(run.status).toBe('SUCCESS');
        // 2. …so pin that the failure was actually REACHED. Without this the whole test is satisfied
        //    by an appender that silently does nothing, which is the exact regression it must catch.
        expect(spy.mock.calls.length).toBeGreaterThan(0);
        // 3. The failure is counted, not swallowed into silence (#218's lesson: a dead pass that logs
        //    nothing runs dead for 27 consecutive syncs).
        expect(run.stats.commissioning?.skippedByReason).toEqual({ APPEND_FAILED: 1 });
        // 4. The MIRROR still committed. This is the property that actually matters: `batchUpsert`
        //    runs inside `$transaction`, so the question is whether a rejection downstream can unwind
        //    it. The new vehicle and its device must be in Postgres despite the fitment write throwing.
        expect(await prisma.vehicle.findUnique({ where: { vehicleNo: V_THREE } })).not.toBeNull();
        expect(await prisma.device.findUnique({ where: { deviceId: D_ONE } })).not.toBeNull();
        // 5. Only the fact is lost, and nothing partial was written.
        expect(await facts()).toEqual(before);
      });
    } finally {
      await prisma.vehicle.deleteMany({ where: { vehicleNo: V_THREE } });
    }
  });

  it('recovers on the next run — the lost fact is re-derived from the source, nothing is permanent', async () => {
    // The other half of "inert": a swallowed failure is only acceptable because the source rows are
    // still there next time. If this ever fails, the swallow in `appendCommissioning` becomes real
    // data loss rather than a deferred write.
    const V_FOUR = `ZZ226Y${NS}`;
    const before = await facts();
    vehicleMasters = [vehicle(V_FOUR)];
    await withFailingCommissioningWrite(async () => {
      await sync.sync();
      expect(await facts()).toEqual(before);
    });
    try {
      const run = await sync.sync();
      expect(run.stats.commissioning?.skippedByReason).toBeUndefined();
      const after = await facts();
      expect(after).toHaveLength(before.length + 1);
      expect(after[after.length - 1]).toMatchObject({ deviceId: D_ONE, installedBy: 'COMMISSIONING_TEST' });
    } finally {
      await prisma.vehicle.deleteMany({ where: { vehicleNo: V_FOUR } });
    }
  });
});
