import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { FleetUptimeAggregationService } from './fleet-uptime-aggregation.service';
import { ReportsService } from './reports.service';
import { RootCauseAnalyticsAggregationService } from './root-cause-aggregation.service';
import { SoftInactiveCountService } from './soft-inactive-count.service';
import { SystemEfficiencyAggregationService } from './system-efficiency-aggregation.service';
import { ZmPerformanceAggregationService } from './zm-performance-aggregation.service';

/**
 * Reports (Issue 39). The Fleet Uptime % monthly report read (`ReportsService`) + its aggregation
 * worker (`FleetUptimeAggregationService`), the Soft Inactive Count service (Issue 40), and the Root
 * Cause Analytics aggregation worker (Issue 41). `ReportsController` is registered in AppModule alongside
 * the shared guards (mirroring Dashboard/Tickets).
 */
@Module({
  imports: [PrismaModule],
  providers: [ReportsService, FleetUptimeAggregationService, SoftInactiveCountService, RootCauseAnalyticsAggregationService, ZmPerformanceAggregationService, SystemEfficiencyAggregationService],
  exports: [ReportsService, FleetUptimeAggregationService, SoftInactiveCountService, RootCauseAnalyticsAggregationService, ZmPerformanceAggregationService, SystemEfficiencyAggregationService],
})
export class ReportsModule {}
