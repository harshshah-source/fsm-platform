import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SnapshotIngestionService } from './snapshot-ingestion.service';
import { SnapshotIngestionWorker } from './snapshot-ingestion.worker';
import { SnapshotQueryService } from './snapshot-query.service';
import { SnapshotRunService } from './snapshot-run.service';
import { InMemorySourceReader, SOURCE_READER, type SourceReader } from './source-reader';

/**
 * Snapshot ingestion (Issue 04). Composes the run lifecycle, idempotent chunk writer, query side,
 * and the worker. The `SOURCE_READER` token is bound here to an empty in-memory reader as a
 * placeholder — the real read-only AutoPlant connection (credentials + provisioning are HITL /
 * external-access) swaps in behind this token without touching the worker, controller, or tests.
 * The worker is wired via factory because its constructor takes the `ChunkWriter` interface and the
 * `SOURCE_READER` token, neither of which Nest can resolve by type.
 */
@Module({
  controllers: [],
  providers: [
    SnapshotRunService,
    SnapshotIngestionService,
    SnapshotQueryService,
    { provide: SOURCE_READER, useValue: new InMemorySourceReader([]) },
    {
      provide: SnapshotIngestionWorker,
      useFactory: (
        runs: SnapshotRunService,
        writer: SnapshotIngestionService,
        source: SourceReader,
        prisma: PrismaService,
      ) => new SnapshotIngestionWorker(runs, writer, source, prisma),
      inject: [SnapshotRunService, SnapshotIngestionService, SOURCE_READER, PrismaService],
    },
  ],
  exports: [SnapshotRunService, SnapshotIngestionService, SnapshotQueryService, SnapshotIngestionWorker],
})
export class IngestionModule {}
