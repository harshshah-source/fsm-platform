import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../prisma/prisma.module';
import { BatchAssignmentService } from './batch-assignment.service';
import { DAY_PLAN_NOTIFIER, LoggingDayPlanNotifier } from './day-plan-notifier';
import { DayPlanQueryService } from './day-plan-query.service';
import { OverrideService } from './override.service';
import { SOFT_STATE_CONFLICT } from './soft-state-conflict';
import { PrismaSoftStateConflictPort } from '../soft-state/soft-state-conflict.adapter';
import { ZmScheduleQueryService } from './zm-schedule-query.service';

/**
 * Scheduling / dispatch (Issue 11). The BatchAssignmentWorker turns Recommender output into
 * dispatched Day Plans (work_schedules / plant_batch_assignments / batch_assignment_tickets) with
 * no approval gate (Decision §7). Read surfaces (/api/schedules/*) build on this service.
 */
@Module({
  imports: [PrismaModule, AuditModule],
  providers: [
    BatchAssignmentService,
    DayPlanQueryService,
    ZmScheduleQueryService,
    OverrideService,
    { provide: DAY_PLAN_NOTIFIER, useClass: LoggingDayPlanNotifier },
    // Issue 15 AC#7 — the real soft_states-backed conflict source replaces the 13a no-conflict seam.
    { provide: SOFT_STATE_CONFLICT, useClass: PrismaSoftStateConflictPort },
  ],
  exports: [BatchAssignmentService, DayPlanQueryService, ZmScheduleQueryService, OverrideService],
})
export class SchedulingModule {}
