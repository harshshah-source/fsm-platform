import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from '../auth/auth.module';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import { DeviceDepartureModule } from '../device-departure/device-departure.module';
import { DeviceStateModule } from '../device-state/device-state.module';
import { OrgModule } from '../org/org.module';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsModule } from '../settings/settings.module';
import { TicketingModule } from '../ticketing/ticketing.module';
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
import { PartitionMaintenanceService } from './partition-maintenance.service';
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
  // TicketingModule supplies TicketCreationService to IntegrationSyncService (Issue 112 — the
  // pipeline's fourth stage). No cycle: Ticketing imports only Prisma + Audit.
  // DeviceDepartureModule supplies DeviceDepartureService to MasterSyncService (Issue 128 — the
  // lifecycle pass the widened read feeds). No cycle: it imports only Prisma.
  imports: [
    AuthModule,
    DeviceDepartureModule,
    DeviceStateModule,
    SettingsModule,
    TicketingModule,
    // OrgModule supplies PlantEligibleFloatingSeService to MasterSyncService (Issue 138 slice 2 — the
    // post-sync MV refresh). No cycle: OrgModule imports only AuditModule.
    OrgModule,
    ScheduleModule.forRoot(),
  ],
  controllers: [IntegrationHealthController, IntegrationSyncController],
  providers: [
    AuthGuard,
    RoleGuard,
    SnapshotRunService,
    SnapshotIngestionService,
    SnapshotQueryService,
    PartitionMaintenanceService,
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
          // Enables the static device-identity enrichment join (DEVICE_TYPE / IMSI_NO live only in
          // ap_widgets). Qualified for the same reason the snapshot reader is: the pool default is
          // ap_masters, where tb_vehiclemaster does not exist.
          widgetsSchema: cfg.dbWidgets,
          plantStatuses: ['ACTIVE'],
          // Issue 128: READ every deployment status, so a device leaving the deployed fleet is
          // OBSERVED rather than inferred (the DEPLOYED-only read is what froze departed devices at
          // 'DEPLOYED' forever). The CREATE scope is unchanged and pinned in MasterSyncService —
          // widening this list must never be read as widening what FSM mirrors.
          deploymentStatuses: [],
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
      useFactory: (client: AutoPlantMysqlClient): SourceReader => {
        const cfg = readAutoPlantMysqlConfig();
        if (cfg === null) return new InMemorySourceReader([]);
        const offsetEnv = process.env.AUTOPLANT_SOURCE_UTC_OFFSET_MIN;
        return new AutoPlantSourceReader({
          query: ((sql, params) => client.query(sql, params)) as AutoPlantSourceReaderDeps['query'],
          // tb_vehiclemaster lives in ap_widgets; the pool default schema is ap_masters, so this must be
          // qualified or every read fails ER_NO_SUCH_TABLE against ap_masters (regression, 2026-07-14).
          widgetsSchema: cfg.dbWidgets,
          offsetMinutes: offsetEnv ? Number(offsetEnv) : undefined,
        });
      },
      inject: [AutoPlantMysqlClient],
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
    PartitionMaintenanceService,
    AutoPlantMysqlClient,
    MasterSyncRunService,
    MasterSyncService,
    IntegrationSyncService,
    AutoPlantHealthService,
  ],
})
export class IngestionModule {}
