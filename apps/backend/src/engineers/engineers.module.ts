import { Module } from '@nestjs/common';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaModule } from '../prisma/prisma.module';
import { EngineersQueryService } from './engineers-query.service';
import { SeAvailabilityService } from './se-availability.service';

/**
 * SE Management (Issue 25) — SE planning availability. `SeAvailabilityService` is exported so the
 * `/api/engineers` controller (registered in AppModule) and the Recommender (AC#4 readiness) can
 * consume it. Controllers follow this repo's convention of living in AppModule's `controllers` array.
 */
@Module({
  imports: [PrismaModule],
  providers: [SeAvailabilityService, EngineersQueryService, InventoryService],
  exports: [SeAvailabilityService, EngineersQueryService],
})
export class EngineersModule {}
