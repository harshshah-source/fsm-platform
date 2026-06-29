/**
 * Book8 core pipeline — the reusable seed → ingest → recompute → ticket-create orchestration, shared
 * by the core driver spec and the recommender-layer spec. Composes the PRODUCTION services manually
 * (exactly like test/snapshot-worker.e2e-spec.ts); nothing below the SourceReader seam is altered.
 */
import { SnapshotIngestionWorker } from '../../../src/ingestion/snapshot-ingestion.worker';
import { SnapshotIngestionService } from '../../../src/ingestion/snapshot-ingestion.service';
import { SnapshotRunService } from '../../../src/ingestion/snapshot-run.service';
import { DeviceStateService } from '../../../src/device-state/device-state.service';
import type { SettingsService } from '../../../src/settings/settings.service';
import { TicketCreationService } from '../../../src/ticketing/ticket-creation.service';
import type { PrismaService } from '../../../src/prisma/prisma.service';
import { loadBook8Dataset, type Book8Dataset } from './book8-dataset';
import { Book8SourceReader } from './book8-source-reader';
import { seedBook8Master, type SeedSummary } from './book8-seeder';

/** Settings stub — recompute only reads the canonical inactivity threshold (24h). */
const settingsStub = { get: async () => 24 } as unknown as SettingsService;

export interface CoreResult {
  ds: Book8Dataset;
  idSet: Set<string>;
  seed: SeedSummary;
  ingest: Awaited<ReturnType<SnapshotIngestionWorker['run']>>;
  recompute: { upserted: number };
  ticketsCreated: number;
}

export async function runBook8Core(prisma: PrismaService): Promise<CoreResult> {
  const ds = loadBook8Dataset();
  const idSet = new Set(ds.usable.map((r) => r.deviceId.toString()));

  const seed = await seedBook8Master(prisma, ds);

  // Clear any stale in-flight run so the single-in-flight guard doesn't 409 a fresh run.
  await prisma.snapshotRun.deleteMany({ where: { status: 'RUNNING' } });
  const worker = new SnapshotIngestionWorker(
    new SnapshotRunService(prisma),
    new SnapshotIngestionService(prisma),
    new Book8SourceReader(ds.telemetry),
    prisma,
  );
  const ingest = await worker.run({ chunkSize: 1000 });

  const recompute = await new DeviceStateService(prisma, settingsStub).recompute(ds.datasetNow);
  const { created } = await new TicketCreationService(prisma).createForInactiveEligible(ds.datasetNow);

  return { ds, idSet, seed, ingest, recompute, ticketsCreated: created };
}
