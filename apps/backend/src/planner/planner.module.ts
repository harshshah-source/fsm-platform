import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SePlannerService } from './se-planner.service';

/**
 * SE Planner (Issue 14a). ZM-authored plant-visit intents that soft-bias the Morning Batch
 * (ADR-0022). `SePlannerController` is registered in AppModule alongside the shared guards.
 * `SePlannerService` is exported so the Recommender can read planner entries as a bias signal.
 */
@Module({
  imports: [PrismaModule],
  providers: [SePlannerService],
  exports: [SePlannerService],
})
export class PlannerModule {}
