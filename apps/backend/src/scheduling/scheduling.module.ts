import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../prisma/prisma.module';
import { RecommenderModule } from '../recommender/recommender.module';
import { BatchAssignmentService } from './batch-assignment.service';
import { DAY_PLAN_NOTIFIER, LoggingDayPlanNotifier } from './day-plan-notifier';
import { DayPlanQueryService } from './day-plan-query.service';
import { DispatchRunService } from './dispatch-run.service';
import { DispatchSchedulerService } from './dispatch-scheduler.service';
import { DispatchTransparencyQueryService } from './dispatch-transparency-query.service';
import { OverrideService } from './override.service';
import { SameDayUpdateService } from './same-day-update.service';
import { SOFT_STATE_CONFLICT } from './soft-state-conflict';
import { PrismaSoftStateConflictPort } from '../soft-state/soft-state-conflict.adapter';
import { ZmScheduleQueryService } from './zm-schedule-query.service';

/**
 * Scheduling / dispatch (Issue 11). The BatchAssignmentWorker turns Recommender output into
 * dispatched Day Plans (work_schedules / plant_batch_assignments / batch_assignment_tickets) with
 * no approval gate (Decision §7). Read surfaces (/api/schedules/*) build on this service.
 */
@Module({
  imports: [PrismaModule, AuditModule, RecommenderModule],
  providers: [
    BatchAssignmentService,
    DayPlanQueryService,
    ZmScheduleQueryService,
    DispatchTransparencyQueryService,
    OverrideService,
    SameDayUpdateService,
    // Issue 113 — the daily Recommender → Day-Plan dispatch run + its scheduler tick. The scheduler is
    // factory-provided (mirroring the ingestion / business-sweep schedulers) so its optional `config`
    // param reads the environment rather than being DI-resolved.
    DispatchRunService,
    {
      provide: DispatchSchedulerService,
      useFactory: (run: DispatchRunService) => new DispatchSchedulerService(run),
      inject: [DispatchRunService],
    },
    { provide: DAY_PLAN_NOTIFIER, useClass: LoggingDayPlanNotifier },
    // Issue 15 AC#7 — the real soft_states-backed conflict source replaces the 13a no-conflict seam.
    { provide: SOFT_STATE_CONFLICT, useClass: PrismaSoftStateConflictPort },
  ],
  exports: [BatchAssignmentService, DayPlanQueryService, ZmScheduleQueryService, DispatchTransparencyQueryService, OverrideService, SameDayUpdateService, DispatchRunService],
})
export class SchedulingModule {}
