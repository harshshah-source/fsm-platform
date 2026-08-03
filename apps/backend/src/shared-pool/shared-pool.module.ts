import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SeCoverageService } from './se-coverage.service';
import { SharedPoolService } from './shared-pool.service';

/**
 * SE Shared Pool (Issue 12) — always-visible secondary work scoped to an SE's covered plants.
 * `SharedPoolController` is registered in AppModule alongside the shared guards (same convention as
 * `TicketsController` / `SchedulesController`). `SeCoverageService` is exported so the #162 row-scoping
 * floor (troubleshoot submit, soft-state) and the #161 merged ticket-read surface can reuse the same
 * coverage predicate instead of a second copy.
 */
@Module({
  imports: [PrismaModule],
  providers: [SharedPoolService, SeCoverageService],
  exports: [SharedPoolService, SeCoverageService],
})
export class SharedPoolModule {}
