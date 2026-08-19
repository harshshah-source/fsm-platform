import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { RecommenderModule } from '../recommender/recommender.module';
import { BatchAssignmentService } from './batch-assignment.service';
import { BulkUnassignService } from './bulk-unassign.service';
import { DAY_PLAN_NOTIFIER, SpineDayPlanNotifier } from './day-plan-notifier';
import { DayPlanQueryService } from './day-plan-query.service';
import { DispatchRunService } from './dispatch-run.service';
import { DispatchScheduleService } from './dispatch-schedule.service';
import { DispatchSchedulerService } from './dispatch-scheduler.service';
import { DispatchTransparencyQueryService } from './dispatch-transparency-query.service';
import { OverrideService } from './override.service';
import { ScheduleClosureScheduler } from './schedule-closure-scheduler.service';
import { SameDayUpdateService } from './same-day-update.service';
import { SOFT_STATE_CONFLICT } from './soft-state-conflict';
import { PrismaSoftStateConflictPort } from '../soft-state/soft-state-conflict.adapter';
import { ZmScheduleQueryService } from './zm-schedule-query.service';
import { SchedulerPreviewService } from './scheduler-preview.service';

/**
 * Scheduling / dispatch (Issue 11). The BatchAssignmentWorker turns Recommender output into
 * dispatched Day Plans (work_schedules / plant_batch_assignments / batch_assignment_tickets) with
 * no approval gate (Decision §7). Read surfaces (/api/schedules/*) build on this service.
 */
@Module({
  imports: [PrismaModule, AuditModule, RecommenderModule, NotificationsModule],
  providers: [
    BatchAssignmentService,
    // #251 — the Scheduler Preview's read + the two hold writes. Plain DI: it composes
    // DispatchRunService (for #250's dry-run orchestration), Prisma and AuditService, and has no
    // env-driven config of its own, so none of the factory shapes below apply to it.
    SchedulerPreviewService,
    DayPlanQueryService,
    ZmScheduleQueryService,
    DispatchTransparencyQueryService,
    OverrideService,
    SameDayUpdateService,
    BulkUnassignService,
    // Issue 113 — the daily Recommender → Day-Plan dispatch run + its scheduler tick. The scheduler is
    // factory-provided (mirroring the ingestion / business-sweep schedulers) so its optional `config`
    // param reads the environment rather than being DI-resolved.
    DispatchRunService,
    {
      provide: DispatchSchedulerService,
      useFactory: (run: DispatchRunService) => new DispatchSchedulerService(run),
      inject: [DispatchRunService],
    },
    // #213 — owns the registered job's lifecycle: applies the stored schedule at boot and re-points the
    // live job on every write, so an operator's change takes effect without a restart. DI-resolved (it
    // needs Prisma + the SchedulerRegistry), unlike the scheduler above whose only config is env.
    DispatchScheduleService,
    // Issue 147 slice 2 — the work-schedule closing transition, the lifecycle's missing half. Same
    // factory-provided shape and the same reason: its optional `config` param reads the environment.
    {
      provide: ScheduleClosureScheduler,
      useFactory: (prisma: PrismaService) => new ScheduleClosureScheduler(prisma),
      inject: [PrismaService],
    },
    // #76 adoption — SpineDayPlanNotifier routes through the real notification spine.
    { provide: DAY_PLAN_NOTIFIER, useClass: SpineDayPlanNotifier },
    // Issue 15 AC#7 — the real soft_states-backed conflict source replaces the 13a no-conflict seam.
    { provide: SOFT_STATE_CONFLICT, useClass: PrismaSoftStateConflictPort },
  ],
  // Every service `SchedulesController` injects must be EXPORTED, not merely provided: the
  // controller is registered in `AppModule`, so a provider that is only visible inside this module
  // resolves at `SchedulingModule` boot and then fails at AppModule boot — which is every e2e that
  // stands up the real app, and none of the ones that construct services by hand.
  exports: [BatchAssignmentService, DayPlanQueryService, ZmScheduleQueryService, DispatchTransparencyQueryService, OverrideService, SameDayUpdateService, DispatchRunService, BulkUnassignService, DispatchScheduleService, SchedulerPreviewService],
})
export class SchedulingModule {}
