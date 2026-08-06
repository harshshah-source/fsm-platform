import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { IngestionModule } from '../ingestion/ingestion.module';
import { PrismaModule } from '../prisma/prisma.module';
import { DatasetQueryService } from './dataset-query.service';
import { OpsExplorerConfigService } from './ops-explorer-enabled.guard';
import { ReconciliationService } from './reconciliation.service';

/**
 * Operations Data Explorer (#217). A **leaf** module: it is imported by nothing, so it can be removed
 * wholesale without touching another module — the right shape for a diagnostic surface that is off by
 * default. It does, however, import two feature modules, each for a specifically different reason:
 *
 * It deliberately does NOT import `DashboardModule`. `ReconciliationService` imports
 * `FLEET_COUNT_COLUMNS`/`EXCLUDE_DEACTIVATED_PLANTS` as SQL *fragments* (values, not providers) from
 * `dashboard.service.ts`, so the two agree on the predicate without a DI dependency on the dashboard's
 * graph.
 *
 * It DOES import `IngestionModule` (#217 S3) — for the opposite reason. `AutoPlantHealthService` is a
 * real, stateful **provider** with its own constructor-injected dependencies (the MySQL client, the
 * master-sync source), so getting it the *fragment* way — re-instantiating it locally with a fresh
 * `useFactory` — would create a second, divergent instance with its own connection pool state. That is
 * precisely the "silent duplicate singleton" anti-pattern #105 documents in `recommender.module.ts` and
 * `engineers.module.ts`. Importing the owning module and injecting its exported provider is the fix
 * #105 itself prescribes, applied here rather than repeated.
 *
 * The controller is mounted at the app level alongside the other ~45 controllers.
 */
@Module({
  imports: [PrismaModule, AuditModule, IngestionModule],
  providers: [DatasetQueryService, ReconciliationService, OpsExplorerConfigService],
  exports: [DatasetQueryService, ReconciliationService, OpsExplorerConfigService],
})
export class OpsExplorerModule {}
