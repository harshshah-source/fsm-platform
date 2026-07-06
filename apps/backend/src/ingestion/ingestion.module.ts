import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from '../auth/auth.module';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import { DeviceStateModule } from '../device-state/device-state.module';
import { PrismaService } from '../prisma/prisma.service';
import {
  AutoPlantMasterSource,
  type AutoPlantMasterSourceDeps,
} from './autoplant/autoplant-master-source';
import { AutoPlantMysqlClient, readAutoPlantMysqlConfig } from './autoplant/autoplant-mysql.client';
import {
  AutoPlantSourceReader,
  type AutoPlantSourceReaderDeps,
} from './autoplant/autoplant-source-reader';
import { AutoPlantHealthService } from './autoplant/health.service';
import { IntegrationSchedulerService } from './autoplant/integration-scheduler.service';
import { IntegrationHealthController } from './autoplant/integration-health.controller';
import { IntegrationSyncController } from './autoplant/integration-sync.controller';
import { IntegrationSyncService } from './autoplant/integration-sync.service';
import { MappingTableZoneResolver } from './autoplant/mapping-table-zone-resolver';
import { MasterSyncRunService } from './autoplant/master-sync-run.service';
import {
  MASTER_SYNC_SCOPE,
  MASTER_SYNC_SOURCE,
  MasterSyncService,
  type MasterSyncSource,
  PLANT_ZONE_RESOLVER,
} from './autoplant/master-sync.service';
import { SnapshotIngestionService } from './snapshot-ingestion.service';
import { SnapshotIngestionWorker } from './snapshot-ingestion.worker';
import { SnapshotQueryService } from './snapshot-query.service';
import { SnapshotRunService } from './snapshot-run.service';
import { InMemorySourceReader, SOURCE_READER, type SourceReader } from './source-reader';

/** Empty master source — bound when AutoPlant is unconfigured so DI resolves and a stray sync no-ops. */
const EMPTY_MASTER_SOURCE: MasterSyncSource = {
  readCompanies: async () => [],
  readTransporters: async () => [],
  readPlants: async () => [],
  readVehicleMasters: async () => [],
};

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
  // ScheduleModule lives here (not AppModule) for the same self-containment reason as the guards —
  // the ingestion scheduler is this module's only cron user, and AppModule stays untouched.
  imports: [AuthModule, DeviceStateModule, ScheduleModule.forRoot()],
  controllers: [IntegrationHealthController, IntegrationSyncController],
  providers: [
    AuthGuard,
    RoleGuard,
    SnapshotRunService,
    SnapshotIngestionService,
    SnapshotQueryService,
    MasterSyncRunService,
    // ── Master synchroniser wiring (Step 2) — now that the R6 zone map is data-driven (the
    //    MappingTableZoneResolver defers nothing; pending plants land in UNZONED), MasterSyncService is
    //    registered with its three ports bound: the paginated AutoPlant source, the mapping-table zone
    //    resolver, and the ACTIVE-plant scope. Source-side scope (ACTIVE plants / DEPLOYED vehicles) +
    //    ≤90-row pagination respect the DBA < 100/query cap.
    MasterSyncService,
    IntegrationSyncService,
    { provide: MASTER_SYNC_SCOPE, useValue: { plantStatuses: ['ACTIVE'] } },
    {
      provide: PLANT_ZONE_RESOLVER,
      useFactory: (prisma: PrismaService) => new MappingTableZoneResolver(prisma),
      inject: [PrismaService],
    },
    {
      // Real paginated ap_masters source when configured; an empty no-op source otherwise (so DI
      // resolves and the unconfigured dev/test/CI env boots — the controller guards with 503).
      provide: MASTER_SYNC_SOURCE,
      useFactory: (client: AutoPlantMysqlClient): MasterSyncSource => {
        const cfg = readAutoPlantMysqlConfig();
        if (cfg === null) return EMPTY_MASTER_SOURCE;
        return new AutoPlantMasterSource({
          query: ((sql, params) => client.query(sql, params)) as AutoPlantMasterSourceDeps['query'],
          mastersSchema: cfg.dbMasters,
          plantStatuses: ['ACTIVE'],
          deploymentStatuses: ['DEPLOYED'],
        });
      },
      inject: [AutoPlantMysqlClient],
    },
    // AutoPlant integration health surface — the client doubles as the connectivity probe, and the
    // real master source doubles as the reconciliation counts dep (Issue 97 Slice 5): its COUNT(*)
    // reads reuse the sync's own filter fragments. Unconfigured env binds the empty source → counts
    // stay null → health reports reconciled: null (degraded), never crashing.
    {
      provide: AutoPlantHealthService,
      useFactory: (prisma: PrismaService, client: AutoPlantMysqlClient, source: MasterSyncSource) =>
        new AutoPlantHealthService(
          prisma,
          client,
          source instanceof AutoPlantMasterSource ? source : null,
        ),
      inject: [PrismaService, AutoPlantMysqlClient, MASTER_SYNC_SOURCE],
    },
    // In-process ingestion scheduler (Issue 97 Slice 7 / review A1). Env-gated OFF by default and
    // dormant when AutoPlant is unconfigured — the client doubles as the isConfigured() gate — so
    // dev/test/CI boot exactly as before while a configured+enabled runtime self-runs the pipeline.
    {
      provide: IntegrationSchedulerService,
      useFactory: (sync: IntegrationSyncService, client: AutoPlantMysqlClient) =>
        new IntegrationSchedulerService(sync, client),
      inject: [IntegrationSyncService, AutoPlantMysqlClient],
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
    MasterSyncService,
    IntegrationSyncService,
    AutoPlantHealthService,
  ],
})
export class IngestionModule {}
