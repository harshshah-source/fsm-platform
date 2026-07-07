import { Module } from '@nestjs/common';
import { CrossZoneModule } from '../cross-zone/cross-zone.module';
import { CrossZoneEscalationService } from '../cross-zone/cross-zone-escalation.service';
import { IntradayModule } from '../intraday/intraday.module';
import { IntradayInsertionService } from '../intraday/intraday-insertion.service';
import { ReportsModule } from '../reports/reports.module';
import { FleetUptimeAggregationService } from '../reports/fleet-uptime-aggregation.service';
import { RootCauseAnalyticsAggregationService } from '../reports/root-cause-aggregation.service';
import { SoftInactiveCountService } from '../reports/soft-inactive-count.service';
import { SystemEfficiencyAggregationService } from '../reports/system-efficiency-aggregation.service';
import { ZmPerformanceAggregationService } from '../reports/zm-performance-aggregation.service';
import { TicketingModule } from '../ticketing/ticketing.module';
import { InstallLifecycleService } from '../ticketing/install-lifecycle.service';
import { RepeatEscalationService } from '../ticketing/repeat-escalation.service';
import { VerificationModule } from '../verification/verification.module';
import { VerificationService } from '../verification/verification.service';
import { BusinessSweepSchedulerService } from './business-sweep-scheduler.service';

/**
 * Issue 108 — a leaf module that wires {@link BusinessSweepSchedulerService} to the business sweeps it
 * drives. It imports the owning feature modules (which already export these services) purely for DI;
 * nothing imports this module back, so it cannot form a cycle — importantly it does NOT live in
 * `SchedulingModule`, which `IntradayModule`/`CrossZoneModule` already depend on.
 *
 * `ScheduleModule.forRoot()` is registered once (IngestionModule); its explorer discovers `@Cron`
 * handlers across the whole container, so this module needs no schedule registration of its own. The
 * scheduler is factory-provided (mirroring the ingestion scheduler) so its optional `config` param is
 * left to read the environment rather than being DI-resolved.
 */
@Module({
  imports: [VerificationModule, IntradayModule, CrossZoneModule, TicketingModule, ReportsModule],
  providers: [
    {
      provide: BusinessSweepSchedulerService,
      useFactory: (
        verification: VerificationService,
        intraday: IntradayInsertionService,
        crossZone: CrossZoneEscalationService,
        installLifecycle: InstallLifecycleService,
        repeatEscalation: RepeatEscalationService,
        softInactive: SoftInactiveCountService,
        fleetUptime: FleetUptimeAggregationService,
        rootCause: RootCauseAnalyticsAggregationService,
        zmPerformance: ZmPerformanceAggregationService,
        systemEfficiency: SystemEfficiencyAggregationService,
      ) =>
        new BusinessSweepSchedulerService(
          verification,
          intraday,
          crossZone,
          installLifecycle,
          repeatEscalation,
          softInactive,
          fleetUptime,
          rootCause,
          zmPerformance,
          systemEfficiency,
        ),
      inject: [
        VerificationService,
        IntradayInsertionService,
        CrossZoneEscalationService,
        InstallLifecycleService,
        RepeatEscalationService,
        SoftInactiveCountService,
        FleetUptimeAggregationService,
        RootCauseAnalyticsAggregationService,
        ZmPerformanceAggregationService,
        SystemEfficiencyAggregationService,
      ],
    },
  ],
})
export class BusinessSweepSchedulerModule {}
