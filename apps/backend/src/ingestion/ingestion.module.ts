import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import { PrismaService } from '../prisma/prisma.service';
import { AutoPlantMysqlClient, readAutoPlantMysqlConfig } from './autoplant/autoplant-mysql.client';
import {
  AutoPlantSourceReader,
  type AutoPlantSourceReaderDeps,
} from './autoplant/autoplant-source-reader';
import { AutoPlantHealthService } from './autoplant/health.service';
import { IntegrationHealthController } from './autoplant/integration-health.controller';
import { MasterSyncRunService } from './autoplant/master-sync-run.service';
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
  // AuthModule (→ TokenService) + the guards are imported/provided locally so IntegrationHealthController's
  // @UseGuards(AuthGuard, RoleGuard) resolves inside this module — the app-level controllers (SnapshotsController
  // et al.) stay in AppModule; this one is self-contained to avoid touching the concurrently-edited AppModule.
  imports: [AuthModule],
  controllers: [IntegrationHealthController],
  providers: [
    AuthGuard,
    RoleGuard,
    SnapshotRunService,
    SnapshotIngestionService,
    SnapshotQueryService,
    // Master-sync run bookkeeping (Phase 4). Decision-free + self-contained; the MasterSyncService
    // itself is NOT registered — its scope/zone/source ports are business-/VPN-gated (Phase 7 wiring).
    MasterSyncRunService,
    // AutoPlant integration health surface — the client doubles as the connectivity probe.
    {
      provide: AutoPlantHealthService,
      useFactory: (prisma: PrismaService, client: AutoPlantMysqlClient) =>
        new AutoPlantHealthService(prisma, client),
      inject: [PrismaService, AutoPlantMysqlClient],
    },
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
    MasterSyncRunService,
    AutoPlantHealthService,
  ],
})
export class IngestionModule {}
