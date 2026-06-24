import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SharedPoolService } from './shared-pool.service';

/**
 * SE Shared Pool (Issue 12) — always-visible secondary work scoped to an SE's covered plants.
 * `SharedPoolController` is registered in AppModule alongside the shared guards (same convention as
 * `TicketsController` / `SchedulesController`).
 */
@Module({
  imports: [PrismaModule],
  providers: [SharedPoolService],
  exports: [SharedPoolService],
})
export class SharedPoolModule {}
