import { SnapshotIngestionService } from '../src/ingestion/snapshot-ingestion.service';
import type { SourceSnapshotRow } from '../src/ingestion/source-reader';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * `device_states.trip_creation_datetime` maintenance at ingest — the operational half of the AutoPlant
 * enrichment. Trip creation rides the 30-min telemetry tick (not the daily master sync) because it is
 * live trip state: it tracks `active_trip_id`, and 18.4% of the DEPLOYED fleet changes it per day
 * (measured against the live source 2026-07-17), so a daily mirror would be stale for ~2,600 vehicles.
 *
 * It rides the SAME set-based upsert as `latest_gps_datetime`, so it inherits the GREATEST "never
 * regress" guard — and, because Postgres GREATEST ignores NULLs, a chunk carrying no trip stamp must
 * leave a stored one intact rather than clearing it (a vehicle between trips keeps its last trip).
 */
const DEV_A = 'TRIP_KNOWN_A';
const DEV_B = 'TRIP_KNOWN_B';

const at = (minute: number): Date => new Date(Date.UTC(2026, 6, 17, 6, minute, 0));

const row = (deviceId: string, minute: number, trip: Date | null): SourceSnapshotRow => ({
  deviceId,
  gpsDatetime: at(minute),
  tripCreationDatetime: trip,
});

describe('AutoPlant enrichment — device_states.trip_creation_datetime at ingest', () => {
  let prisma: PrismaService;
  let service: SnapshotIngestionService;
  const runIds: bigint[] = [];

  const newRun = async (): Promise<bigint> => {
    const run = await prisma.snapshotRun.create({ data: { status: 'SUCCESS' } });
    runIds.push(run.runId);
    return run.runId;
  };

  const trip = async (deviceId: string): Promise<Date | null> =>
    (await prisma.deviceState.findUnique({ where: { deviceId } }))?.tripCreationDatetime ?? null;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new SnapshotIngestionService(prisma);
    await prisma.device.createMany({ data: [{ deviceId: DEV_A }, { deviceId: DEV_B }], skipDuplicates: true });
  });

  afterAll(async () => {
    const ids = [DEV_A, DEV_B];
    await prisma.rawDeviceSnapshot.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: ids } } });
    await prisma.snapshotRun.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: ids } } });
    await prisma.onModuleDestroy();
  });

  it('writes trip_creation_datetime alongside the ping watermark, in one pass', async () => {
    const runId = await newRun();
    const res = await service.ingestChunk(runId, [row(DEV_A, 10, at(5))]);

    expect(res.deviceStatesUpserted).toBe(1);
    expect((await trip(DEV_A))?.toISOString()).toBe(at(5).toISOString());
  });

  it('advances to a newer trip, and never regresses to an older one (GREATEST)', async () => {
    const runId = await newRun();
    await service.ingestChunk(runId, [row(DEV_A, 20, at(30))]);
    expect((await trip(DEV_A))?.toISOString()).toBe(at(30).toISOString());

    await service.ingestChunk(runId, [row(DEV_A, 25, at(15))]); // an older trip stamp must not win
    expect((await trip(DEV_A))?.toISOString()).toBe(at(30).toISOString());

    await service.ingestChunk(runId, [row(DEV_A, 40, at(45))]); // a newer one does
    expect((await trip(DEV_A))?.toISOString()).toBe(at(45).toISOString());
  });

  it('a null trip stamp never clears a stored one (vehicle between trips keeps its last trip)', async () => {
    const runId = await newRun();
    await service.ingestChunk(runId, [row(DEV_B, 10, at(8))]);
    expect((await trip(DEV_B))?.toISOString()).toBe(at(8).toISOString());

    await service.ingestChunk(runId, [row(DEV_B, 20, null)]);
    expect((await trip(DEV_B))?.toISOString()).toBe(at(8).toISOString());
  });

  it('a device that has never had a trip keeps a null trip stamp (does not block the ping write)', async () => {
    const runId = await newRun();
    await prisma.deviceState.deleteMany({ where: { deviceId: DEV_B } });
    const res = await service.ingestChunk(runId, [row(DEV_B, 55, null)]);

    expect(res.deviceStatesUpserted).toBe(1);
    expect(await trip(DEV_B)).toBeNull();
    const ds = await prisma.deviceState.findUnique({ where: { deviceId: DEV_B } });
    expect(ds?.latestGpsDatetime?.toISOString()).toBe(at(55).toISOString());
  });

  it('dedupes to the newest trip stamp within a single chunk', async () => {
    const runId = await newRun();
    await prisma.deviceState.deleteMany({ where: { deviceId: DEV_A } });
    await service.ingestChunk(runId, [row(DEV_A, 50, at(12)), row(DEV_A, 51, at(35)), row(DEV_A, 52, at(20))]);
    expect((await trip(DEV_A))?.toISOString()).toBe(at(35).toISOString());
  });
});
