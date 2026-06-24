import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaSoftStateConflictPort } from './soft-state-conflict.adapter';
import { SoftStateService } from './soft-state.service';

/**
 * SE soft states + activity ping + derived Activity Status (Issue 15). Owns the field-progress chain
 * (VIEWED → ON_SITE → TROUBLESHOOT_STARTED), the VIEWED-timeout / stale-work sweeps, the render-time
 * Activity Status derivation, and the soft_states-backed override-conflict port (AC#7) consumed by the
 * scheduling module. `SoftStateController` is registered in AppModule (same convention as
 * `SharedPoolController` / `SchedulesController`).
 */
@Module({
  imports: [PrismaModule],
  providers: [SoftStateService, PrismaSoftStateConflictPort],
  exports: [SoftStateService, PrismaSoftStateConflictPort],
})
export class SoftStateModule {}
