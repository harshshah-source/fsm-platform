import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { FleetUptimeAggregationService } from './fleet-uptime-aggregation.service';
import { ReportsService } from './reports.service';
import { SoftInactiveCountService } from './soft-inactive-count.service';

/**
 * Reports (Issue 39). The Fleet Uptime % monthly report read (`ReportsService`) + its aggregation
 * worker (`FleetUptimeAggregationService`). `ReportsController` is registered in AppModule alongside
 * the shared guards (mirroring Dashboard/Tickets).
 */
@Module({
  imports: [PrismaModule],
  providers: [ReportsService, FleetUptimeAggregationService, SoftInactiveCountService],
  exports: [ReportsService, FleetUptimeAggregationService, SoftInactiveCountService],
})
export class ReportsModule {}
