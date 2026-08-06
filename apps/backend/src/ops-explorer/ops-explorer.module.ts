import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../prisma/prisma.module';
import { DatasetQueryService } from './dataset-query.service';
import { OpsExplorerConfigService } from './ops-explorer-enabled.guard';
import { ReconciliationService } from './reconciliation.service';

/**
 * Operations Data Explorer (#217). A **leaf** module: it imports Prisma and Audit and is imported by
 * nothing, so it can be removed wholesale without touching another module — the right shape for a
 * diagnostic surface that is off by default.
 *
 * It deliberately does NOT import `DashboardModule`. `ReconciliationService` imports the
 * `FLEET_COUNT_COLUMNS` SQL *fragment* from `dashboard.service.ts` — a value, not a provider — so the
 * two agree on the predicate without the explorer taking a runtime dependency on the dashboard's DI
 * graph (which #105 shows this codebase gets wrong when modules re-provide each other's services).
 *
 * The controller is mounted at the app level alongside the other ~45 controllers.
 */
@Module({
  imports: [PrismaModule, AuditModule],
  providers: [DatasetQueryService, ReconciliationService, OpsExplorerConfigService],
  exports: [DatasetQueryService, ReconciliationService, OpsExplorerConfigService],
})
export class OpsExplorerModule {}
