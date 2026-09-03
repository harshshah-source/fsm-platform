import { Module } from '@nestjs/common';
import { CrossZoneModule } from '../cross-zone/cross-zone.module';
import { CrossZoneEscalationService } from '../cross-zone/cross-zone-escalation.service';
import { IntradayModule } from '../intraday/intraday.module';
import { IntradayInsertionService } from '../intraday/intraday-insertion.service';
import { NotificationService } from '../notifications/notification.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { OrgModule } from '../org/org.module';
import { TierOverrideExpiryService } from '../org/tier-override-expiry.service';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { ReportsModule } from '../reports/reports.module';
import { FleetUptimeAggregationService } from '../reports/fleet-uptime-aggregation.service';
import { RootCauseAnalyticsAggregationService } from '../reports/root-cause-aggregation.service';
import { SoftInactiveCountService } from '../reports/soft-inactive-count.service';
import { SystemEfficiencyAggregationService } from '../reports/system-efficiency-aggregation.service';
import { ZmPerformanceAggregationService } from '../reports/zm-performance-aggregation.service';
import { TicketingModule } from '../ticketing/ticketing.module';
import { InstallLifecycleService } from '../ticketing/install-lifecycle.service';
import { INSTALL_NOTIFIER, type InstallNotifier } from '../ticketing/install-notifier';
import { RECOVERY_NOTIFIER, type RecoveryNotifier } from '../ticketing/recovery-notifier';
import { RepeatEscalationService } from '../ticketing/repeat-escalation.service';
import { VerificationModule } from '../verification/verification.module';
import { VerificationService } from '../verification/verification.service';
import { BusinessSweepSchedulerService } from './business-sweep-scheduler.service';
import { CronTickClaimModule } from './cron-tick-claim.module';
import { CronTickClaimService } from './cron-tick-claim.service';
import { DAY_PLAN_NOTIFIER, type DayPlanNotifier } from './day-plan-notifier';
// #264 — the outbox sweep's notifier. `SchedulingModule` is imported for exactly this one export
// (`DAY_PLAN_NOTIFIER`); nothing else here needs it, and `SchedulingModule` importing this module
// back would be the only way to cycle, which it does not (see the module docstring below).
import { SchedulingModule } from './scheduling.module';

/**
 * Issue 108 — a leaf module that wires {@link BusinessSweepSchedulerService} to the business sweeps it
 * drives. It imports the owning feature modules (which already export these services) purely for DI;
 * nothing imports this module back, so it cannot form a cycle — importantly it does NOT live in
 * `SchedulingModule`, which `IntradayModule`/`CrossZoneModule` already depend on. #264 adds one
 * import — `SchedulingModule` itself, for its exported `DAY_PLAN_NOTIFIER` token only — which does not
 * change this: the edge is one-directional (`SchedulingModule` still does not import this module).
 *
 * `ScheduleModule.forRoot()` is registered once (IngestionModule); its explorer discovers `@Cron`
 * handlers across the whole container, so this module needs no schedule registration of its own. The
 * scheduler is factory-provided (mirroring the ingestion scheduler) so its optional `config` param is
 * left to read the environment rather than being DI-resolved.
 */
@Module({
  imports: [
    VerificationModule,
    IntradayModule,
    CrossZoneModule,
    TicketingModule,
    ReportsModule,
    OrgModule,
    // #263 — `runGuarded` consults this before every one of the eleven sweeps.
    CronTickClaimModule,
    PrismaModule,
    // #264 — for `DAY_PLAN_NOTIFIER` only (see the module docstring above).
    SchedulingModule,
    // #338 — for `NotificationService`, the drain's deliverer for general (`NOTIFY`) rows. Without
    // it this sweep can retry a day-plan row and nothing else, which is the state every converted
    // producer's notice would have been left in.
    NotificationsModule,
  ],
  providers: [
    {
      provide: BusinessSweepSchedulerService,
      useFactory: (
        verification: VerificationService,
        intraday: IntradayInsertionService,
        crossZone: CrossZoneEscalationService,
        installLifecycle: InstallLifecycleService,
        repeatEscalation: RepeatEscalationService,
        tierOverrideExpiry: TierOverrideExpiryService,
        softInactive: SoftInactiveCountService,
        fleetUptime: FleetUptimeAggregationService,
        rootCause: RootCauseAnalyticsAggregationService,
        zmPerformance: ZmPerformanceAggregationService,
        systemEfficiency: SystemEfficiencyAggregationService,
        claims: CronTickClaimService,
        prisma: PrismaService,
        dayPlanNotifier: DayPlanNotifier,
        notifications: NotificationService,
        installNotifier: InstallNotifier,
        recoveryNotifier: RecoveryNotifier,
      ) =>
        new BusinessSweepSchedulerService(
          verification,
          intraday,
          crossZone,
          installLifecycle,
          repeatEscalation,
          tierOverrideExpiry,
          softInactive,
          fleetUptime,
          rootCause,
          zmPerformance,
          systemEfficiency,
          claims,
          // `config` (env-driven) — explicitly undefined so `prisma`/`dayPlanNotifier` below land in
          // THEIR named slots, not silently shift into this one.
          undefined,
          prisma,
          dayPlanNotifier,
          // #338 — the deliverer for `NOTIFY` rows. Omitting it left the sweep able to retry only
          // day-plan events: a general notice was claimed, failed for want of a deliverer, un-claimed
          // and retried to exhaustion. The post-commit drains hid it, since they succeed on the happy
          // path and only a *failed* push ever reaches this sweep.
          notifications,
          // #338 — the outbox carries install and recovery events too, and this sweep is the only
          // drain that sees every producer's rows.
          installNotifier,
          recoveryNotifier,
        ),
      inject: [
        VerificationService,
        IntradayInsertionService,
        CrossZoneEscalationService,
        InstallLifecycleService,
        RepeatEscalationService,
        TierOverrideExpiryService,
        SoftInactiveCountService,
        FleetUptimeAggregationService,
        RootCauseAnalyticsAggregationService,
        ZmPerformanceAggregationService,
        SystemEfficiencyAggregationService,
        CronTickClaimService,
        PrismaService,
        DAY_PLAN_NOTIFIER,
        NotificationService,
        INSTALL_NOTIFIER,
        RECOVERY_NOTIFIER,
      ],
    },
  ],
})
export class BusinessSweepSchedulerModule {}
