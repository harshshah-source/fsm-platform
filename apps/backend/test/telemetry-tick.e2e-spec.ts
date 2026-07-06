import { vi } from 'vitest';
import type { DeviceStateService } from '../src/device-state/device-state.service';
import { IntegrationSyncService } from '../src/ingestion/autoplant/integration-sync.service';
import type { MasterSyncService } from '../src/ingestion/autoplant/master-sync.service';
import { SnapshotIngestionService } from '../src/ingestion/snapshot-ingestion.service';
import { SnapshotIngestionWorker } from '../src/ingestion/snapshot-ingestion.worker';
import { SnapshotRunService } from '../src/ingestion/snapshot-run.service';
import { InMemorySourceReader } from '../src/ingestion/source-reader';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 97 Slice 6 — overlap-safe telemetry tick. The scheduler (Slice 7) needs a short-cadence
 * entry that ingests telemetry + recomputes device state WITHOUT touching the org graph, and that
 * treats an in-flight run as a normal outcome: two overlapping ticks must degrade to
 * `{ skipped: true }` — never a thrown 409 crashing the cron handler. The single-in-flight guards
 * stay the serialization mechanism; the tick just converts their 409 into a skip.
 */
describe('Issue 97 Slice 6 — IntegrationSyncService.ingestTelemetry', () => {
  let prisma: PrismaService;
  let runs: SnapshotRunService;
  const created: bigint[] = [];

  const masterSync = { sync: vi.fn() };
  const deviceState = { recompute: vi.fn(async () => ({ upserted: 7 })) };

  const makeService = (): IntegrationSyncService =>
    new IntegrationSyncService(
      masterSync as unknown as MasterSyncService,
      new SnapshotIngestionWorker(runs, new SnapshotIngestionService(prisma), new InMemorySourceReader([]), prisma),
      deviceState as unknown as DeviceStateService,
    );

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    runs = new SnapshotRunService(prisma);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await prisma.snapshotRun.deleteMany({ where: { status: 'RUNNING' } });
  });

  afterEach(async () => {
    if (created.length > 0) {
      await prisma.snapshotRun.deleteMany({ where: { runId: { in: created } } });
      created.length = 0;
    }
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it('runs snapshot ingest + device-state recompute and never the master sync', async () => {
    const result = await makeService().ingestTelemetry();
    if (!result.skipped) created.push(BigInt(result.snapshot.runId));

    expect(result.skipped).toBe(false);
    if (result.skipped) throw new Error('unreachable');
    expect(result.snapshot.status).toBe('SUCCESS'); // empty source drains to a clean run
    expect(result.deviceState).toEqual({ upserted: 7 });
    expect(deviceState.recompute).toHaveBeenCalledTimes(1);
    expect(masterSync.sync).not.toHaveBeenCalled(); // telemetry tick never touches the org graph
  });

  it('degrades to { skipped: true } when a snapshot run is already in flight — never throws', async () => {
    const inFlight = await prisma.snapshotRun.create({ data: { status: 'RUNNING' } });
    created.push(inFlight.runId);

    const result = await makeService().ingestTelemetry();

    expect(result).toEqual({ skipped: true, reason: 'RUN_IN_PROGRESS' });
    expect(deviceState.recompute).not.toHaveBeenCalled(); // a skipped tick does no half-work
    const untouched = await prisma.snapshotRun.findUnique({ where: { runId: inFlight.runId } });
    expect(untouched?.status).toBe('RUNNING'); // the in-flight run is left alone
  });

  it('propagates a non-overlap failure — only RUN_IN_PROGRESS is swallowed', async () => {
    const service = new IntegrationSyncService(
      masterSync as unknown as MasterSyncService,
      {
        run: async () => {
          throw new Error('source exploded');
        },
      } as unknown as SnapshotIngestionWorker,
      deviceState as unknown as DeviceStateService,
    );

    await expect(service.ingestTelemetry()).rejects.toThrow('source exploded');
    expect(deviceState.recompute).not.toHaveBeenCalled();
  });
});
