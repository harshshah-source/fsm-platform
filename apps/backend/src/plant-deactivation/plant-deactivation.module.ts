import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PlantDeactivationController } from './plant-deactivation.controller';
import { PlantDeactivationService } from './plant-deactivation.service';

/**
 * FSM-owned plant deactivation (Issue 119). Downstream gates each express the same "active
 * deactivation" exclusion in their own query style (ticket-creation Prisma filter, dashboard raw-SQL
 * predicate, recommender relation filter, the #121 export join) — all keyed on `reactivated_at IS NULL`.
 */
@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [PlantDeactivationController],
  providers: [PlantDeactivationService],
  exports: [PlantDeactivationService],
})
export class PlantDeactivationModule {}
