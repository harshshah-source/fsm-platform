import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AutoPlantMysqlClient, readAutoPlantMysqlConfig } from './autoplant/autoplant-mysql.client';
import {
  AutoPlantSourceReader,
  type AutoPlantSourceReaderDeps,
} from './autoplant/autoplant-source-reader';
import { SnapshotIngestionService } from './snapshot-ingestion.service';
import { SnapshotIngestionWorker } from './snapshot-ingestion.worker';
import { SnapshotQueryService } from './snapshot-query.service';
import { SnapshotRunService } from './snapshot-run.service';
import { InMemorySourceReader, SOURCE_READER, type SourceReader } from './source-reader';

/**
 * Snapshot ingestion (Issue 04). Composes the run lifecycle, idempotent chunk writer, query side,
 * and the worker. `SOURCE_READER` is bound to the real `AutoPlantSourceReader` (Phase 3) **when the
 * AutoPlant MySQL env is configured**, and to the empty `InMemorySourceReader` otherwise — so dev /
 * test / CI (no VPN, env unset) keep the mock reader and boot unaffected, while a configured runtime
 * ingests `tb_vehiclemaster` live. Credentials + VPN provisioning remain external-access HITL.
 * The worker is wired via factory because its constructor takes the `ChunkWriter` interface and the
 * `SOURCE_READER` token, neither of which Nest can resolve by type.
 */
@Module({
  controllers: [],
  providers: [
    SnapshotRunService,
    SnapshotIngestionService,
    SnapshotQueryService,
    // Connection seam to the read-only AutoPlant MySQL source. Bound now so the app can reach and
    // read AutoPlant; the real SourceReader (JSON mapping + normalization) still swaps in behind
    // SOURCE_READER later. Lazy pool → an unset config never blocks boot.
    AutoPlantMysqlClient,
    {
      // Real reader when AutoPlant is configured; mock (unset env ⇒ boots on the in-memory reader) otherwise.
      provide: SOURCE_READER,
      useFactory: (client: AutoPlantMysqlClient, runs: SnapshotRunService): SourceReader => {
        if (readAutoPlantMysqlConfig() === null) return new InMemorySourceReader([]);
        const offsetEnv = process.env.AUTOPLANT_SOURCE_UTC_OFFSET_MIN;
        return new AutoPlantSourceReader({
          query: ((sql, params) => client.query(sql, params)) as AutoPlantSourceReaderDeps['query'],
          loadResumeCursor: () => runs.lastResumeCursor(),
          offsetMinutes: offsetEnv ? Number(offsetEnv) : undefined,
        });
      },
      inject: [AutoPlantMysqlClient, SnapshotRunService],
    },
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
  exports: [
    SnapshotRunService,
    SnapshotIngestionService,
    SnapshotQueryService,
    SnapshotIngestionWorker,
    AutoPlantMysqlClient,
  ],
})
export class IngestionModule {}
