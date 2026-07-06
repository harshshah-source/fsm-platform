import { SnapshotIngestionService } from '../src/ingestion/snapshot-ingestion.service';
import type { SourceSnapshotRow } from '../src/ingestion/source-reader';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * R4-A — same-path incremental `device_states` maintenance. `ingestChunk` already holds each chunk in
 * memory, so after the journal write it upserts `device_states.latest_gps_datetime` set-based
 * (`unnest` + `GREATEST`), joined against `devices` so telemetry for an unmastered device can never
 * violate the FK — those ids are skipped and counted. This removes the need to fold the whole telemetry
 * table just to learn each device's latest ping (the load-the-world groupBy in the old recompute).
 */
const KNOWN_A = 'R4A_KNOWN_A';
const KNOWN_B = 'R4A_KNOWN_B';
const UNKNOWN = 'R4A_UNKNOWN_NOT_IN_DEVICES';

const row = (deviceId: string, minute: number): SourceSnapshotRow => ({
  deviceId,
  gpsDatetime: new Date(Date.UTC(2026, 5, 19, 8, minute, 0)),
  lat: 12.97,
  lon: 77.59,
});

describe('R4-A — device_states dual-write at ingest', () => {
  let prisma: PrismaService;
  let service: SnapshotIngestionService;
  const runIds: bigint[] = [];

  const newRun = async (): Promise<bigint> => {
    const run = await prisma.snapshotRun.create({ data: { status: 'SUCCESS' } });
    runIds.push(run.runId);
    return run.runId;
  };

  const latest = async (deviceId: string): Promise<Date | null> => {
    const ds = await prisma.deviceState.findUnique({ where: { deviceId } });
    return ds?.latestGpsDatetime ?? null;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new SnapshotIngestionService(prisma);
    await prisma.device.createMany({
      data: [{ deviceId: KNOWN_A }, { deviceId: KNOWN_B }],
      skipDuplicates: true,
    });
  });

  afterAll(async () => {
    const ids = [KNOWN_A, KNOWN_B, UNKNOWN];
    await prisma.rawDeviceSnapshot.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: ids } } });
    await prisma.snapshotRun.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: ids } } });
    await prisma.onModuleDestroy();
  });

  it('upserts latest_gps_datetime for a known device at ingest time', async () => {
    const runId = await newRun();
    const res = await service.ingestChunk(runId, [row(KNOWN_A, 10)]);

    expect(res.inserted).toBe(1);
    expect(res.deviceStatesUpserted).toBe(1);
    expect(res.unknownDevices).toBe(0);
    expect((await latest(KNOWN_A))?.toISOString()).toBe(new Date(Date.UTC(2026, 5, 19, 8, 10, 0)).toISOString());
  });

  it('skips telemetry for a device not in `devices` (FK-safe) and counts it', async () => {
    const runId = await newRun();
    const res = await service.ingestChunk(runId, [row(KNOWN_B, 3), row(UNKNOWN, 4)]);

    expect(res.inserted).toBe(2); // both journal rows land (journal has no FK to devices)
    expect(res.deviceStatesUpserted).toBe(1); // only the known device reaches device_states
    expect(res.unknownDevices).toBe(1);
    expect(await latest(UNKNOWN)).toBeNull();
    expect(await latest(KNOWN_B)).not.toBeNull();
  });

  it('never regresses latest_gps_datetime (GREATEST) but advances on a newer ping', async () => {
    const runId = await newRun();
    await service.ingestChunk(runId, [row(KNOWN_A, 30)]);
    await service.ingestChunk(runId, [row(KNOWN_A, 20)]); // older → must not overwrite
    expect((await latest(KNOWN_A))?.toISOString()).toBe(new Date(Date.UTC(2026, 5, 19, 8, 30, 0)).toISOString());

    await service.ingestChunk(runId, [row(KNOWN_A, 45)]); // newer → advances
    expect((await latest(KNOWN_A))?.toISOString()).toBe(new Date(Date.UTC(2026, 5, 19, 8, 45, 0)).toISOString());
  });

  it('dedupes multiple pings of one device within a chunk to the max timestamp', async () => {
    const runId = await newRun();
    const res = await service.ingestChunk(runId, [row(KNOWN_B, 50), row(KNOWN_B, 58), row(KNOWN_B, 52)]);

    expect(res.inserted).toBe(3); // three distinct journal rows
    expect(res.deviceStatesUpserted).toBe(1); // one device_states row
    expect((await latest(KNOWN_B))?.toISOString()).toBe(new Date(Date.UTC(2026, 5, 19, 8, 58, 0)).toISOString());
  });
});
