import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { DashboardService } from './dashboard.service';

/**
 * Dashboard (Issue 06). Read-only aggregations for the Zone Operations Dashboard. `DashboardController`
 * is registered in AppModule alongside the shared guards (mirroring Snapshots/Tickets).
 */
@Module({
  imports: [PrismaModule],
  providers: [DashboardService],
  exports: [DashboardService],
})
export class DashboardModule {}
