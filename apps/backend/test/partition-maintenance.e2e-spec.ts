import { alwaysClaims } from './support/tick-claims';
import { PartitionMaintenanceService } from '../src/ingestion/partition-maintenance.service';
import { dailyPartitionName, startOfUtcDay } from '../src/ingestion/partition-planner';
import { PrismaService } from '../src/prisma/prisma.service';
import type { SettingsService } from '../src/settings/settings.service';

/**
 * R3 end-to-end against real Postgres: the migration converts the DEFAULT catch-all into real daily
 * partitions, ingested rows prune to their day partition, and PartitionMaintenanceService creates ahead
 * and drops aged partitions (never the DEFAULT). Self-contained — it only ever creates today-forward
 * partitions plus one clearly-ancient throwaway (2000-01-01) it then drops, so it cannot disturb the
 * shared test DB's telemetry.
 */
describe('R3 — raw_device_snapshots daily partitioning + retention', () => {
  let prisma: PrismaService;
  const settings7 = { get: async () => 7 } as unknown as SettingsService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "raw_device_snapshots_y2000m01d01"`);
    await prisma.onModuleDestroy();
  });

  const partitions = async (): Promise<string[]> => {
    const rows = await prisma.$queryRawUnsafe<{ relname: string }[]>(
      `SELECT c.relname FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhrelid
         JOIN pg_class pp ON pp.oid = i.inhparent
        WHERE pp.relname = 'raw_device_snapshots'`,
    );
    return rows.map((r) => r.relname);
  };

  it('leaves a DEFAULT partition and real dated daily partitions after migration', async () => {
    const names = await partitions();
    expect(names).toContain('raw_device_snapshots_default');
    expect(names.some((n) => /^raw_device_snapshots_y\d{4}m\d{2}d\d{2}$/.test(n))).toBe(true);
  });

  it('routes an ingested ping to its day partition, not the DEFAULT catch-all', async () => {
    const svc = new PartitionMaintenanceService(prisma, settings7, alwaysClaims() as never);
    await svc.runMaintenance(); // guarantee today's partition exists (create-ahead)

    const run = await prisma.snapshotRun.create({ data: { status: 'SUCCESS' } });
    const ts = new Date(); // today → a real daily partition exists for it
    const deviceId = `PARTTEST_${Date.now()}`;
    await prisma.rawDeviceSnapshot.create({ data: { runId: run.runId, deviceId, gpsDatetime: ts } });

    const rows = await prisma.$queryRawUnsafe<{ part: string }[]>(
      `SELECT tableoid::regclass::text AS part FROM raw_device_snapshots WHERE device_id = '${deviceId}'`,
    );
    expect(rows[0]?.part).toBe(dailyPartitionName(startOfUtcDay(ts)));
    expect(rows[0]?.part).not.toMatch(/default/);
  });

  it('creates ahead and drops an aged partition, never the DEFAULT', async () => {
    // Plant a clearly-expired partition to prove retention removal at partition granularity.
    await prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "raw_device_snapshots_y2000m01d01" PARTITION OF raw_device_snapshots ` +
        `FOR VALUES FROM ('2000-01-01 00:00:00+00') TO ('2000-01-02 00:00:00+00')`,
    );

    const svc = new PartitionMaintenanceService(prisma, settings7, alwaysClaims() as never);
    const res = await svc.runMaintenance(new Date());
    const names = await partitions();

    expect(res.retentionDays).toBe(7);
    expect(res.dropped).toContain('raw_device_snapshots_y2000m01d01');
    expect(names).not.toContain('raw_device_snapshots_y2000m01d01');
    expect(names).toContain('raw_device_snapshots_default'); // safety-net default survives
    // create-ahead reaches today + 3 days.
    const plus3 = dailyPartitionName(new Date(startOfUtcDay(new Date()).getTime() + 3 * 86_400_000));
    expect(names).toContain(plus3);
  });
});
