import { SnapshotIngestionService } from '../src/ingestion/snapshot-ingestion.service';
import type { SourceSnapshotRow } from '../src/ingestion/source-reader';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 04, slice 3 — ingest one chunk into `raw_device_snapshots`.
 *
 * Proves the write path and, critically, that a chunk re-run is idempotent: the
 * `(device_id, gps_datetime)` UNIQUE + `INSERT … ON CONFLICT DO NOTHING` means re-processing the
 * same chunk inserts nothing the second time (AC#4). Telemetry is persisted verbatim (AC#3).
 *
 * Test devices use a 9_000_00x namespace; rows + their run header are cleaned up per test so
 * the idempotency counts are deterministic against the persistent local DB.
 */
const DEV_A = 9_000_001n;
const DEV_B = 9_000_002n;

const row = (deviceId: bigint, minute: number): SourceSnapshotRow => ({
  deviceId,
  gpsDatetime: new Date(Date.UTC(2026, 5, 19, 8, minute, 0)),
  lat: 12.971599,
  lon: 77.594566,
  mainsStatus: 1,
  mainsVoltage: 12.4,
  ignitionStatus: 'OFF',
  speed: 0,
  csq: 22,
  deviceType: 'GT06',
});

describe('Issue 04 slice 3 — chunk ingest', () => {
  let prisma: PrismaService;
  let service: SnapshotIngestionService;
  const createdRunIds: bigint[] = [];

  const newRun = async (): Promise<bigint> => {
    // status SUCCESS to avoid the single-in-flight RUNNING guard (that lifecycle is slice 4).
    const run = await prisma.snapshotRun.create({ data: { status: 'SUCCESS' } });
    createdRunIds.push(run.runId);
    return run.runId;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new SnapshotIngestionService(prisma);
  });

  afterEach(async () => {
    if (createdRunIds.length > 0) {
      await prisma.rawDeviceSnapshot.deleteMany({ where: { runId: { in: createdRunIds } } });
      await prisma.snapshotRun.deleteMany({ where: { runId: { in: createdRunIds } } });
      createdRunIds.length = 0;
    }
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it('inserts a chunk and preserves telemetry verbatim', async () => {
    const runId = await newRun();

    const result = await service.ingestChunk(runId, [row(DEV_A, 0), row(DEV_B, 1)]);

    expect(result.inserted).toBe(2);
    const persisted = await prisma.rawDeviceSnapshot.findMany({ where: { runId } });
    expect(persisted).toHaveLength(2);
    const a = persisted.find((r) => r.deviceId === DEV_A)!;
    expect(a.csq).toBe(22);
    expect(a.deviceType).toBe('GT06');
    expect(Number(a.mainsVoltage)).toBe(12.4);
    expect(a.lat).toBeCloseTo(12.971599, 6);
  });

  it('is idempotent on chunk re-run (ON CONFLICT DO NOTHING)', async () => {
    const runId = await newRun();
    const chunk = [row(DEV_A, 0), row(DEV_B, 1)];

    const first = await service.ingestChunk(runId, chunk);
    const second = await service.ingestChunk(runId, chunk);

    expect(first.inserted).toBe(2);
    expect(second.inserted).toBe(0);
    const count = await prisma.rawDeviceSnapshot.count({ where: { runId } });
    expect(count).toBe(2);
  });

  it('inserts a new ping for the same device at a different gps_datetime', async () => {
    const runId = await newRun();

    await service.ingestChunk(runId, [row(DEV_A, 0)]);
    const next = await service.ingestChunk(runId, [row(DEV_A, 5)]);

    expect(next.inserted).toBe(1);
    const count = await prisma.rawDeviceSnapshot.count({ where: { deviceId: DEV_A, runId } });
    expect(count).toBe(2);
  });

  it('handles an empty chunk without a write', async () => {
    const runId = await newRun();

    const result = await service.ingestChunk(runId, []);

    expect(result.inserted).toBe(0);
  });
});
