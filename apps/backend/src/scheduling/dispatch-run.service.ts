import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RecommenderService } from '../recommender/recommender.service';
import { BatchAssignmentService } from './batch-assignment.service';

export interface DispatchRunError {
  zoneId: string;
  message: string;
}

export interface DispatchRunSummary {
  /** Active zones processed this run. */
  zones: number;
  /** WorkSchedules dispatched across all zones. */
  schedules: number;
  /** Tickets placed on a Day Plan across all zones. */
  tickets: number;
  /** Zones that failed — recorded, not fatal (the run continues). */
  errors: DispatchRunError[];
}

/**
 * Issue 113 — the daily Recommender → Day-Plan dispatch run. This is the middle of the funnel that no
 * issue owned: ingestion (#97) ages device state, ticket creation (#112) chains off the telemetry
 * tick, the field-loop sweeps (#108) run unattended — but scoring + dispatch had no caller, so created
 * tickets sat OPEN/UNASSIGNED forever. `runForActiveZones` loops every active zone (a zone with at
 * least one plant) and runs {@link RecommenderService.runForZone} then
 * {@link BatchAssignmentService.dispatchForZone} — the latter is transactional, recommendation-
 * consuming and per-zone advisory-locked (#100), so a re-run the same day is a safe no-op and this
 * loop can sit on a daily timer or a manual trigger.
 *
 * A zone's failure is contained: it is logged + recorded in {@link DispatchRunSummary.errors} and the
 * remaining zones still dispatch. The Schedule Cadence is daily, so the Day Plan covers a single date
 * (`dateFrom === dateTo === the run day`).
 */
@Injectable()
export class DispatchRunService {
  private readonly logger = new Logger(DispatchRunService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly recommender: RecommenderService,
    private readonly dispatch: BatchAssignmentService,
  ) {}

  async runForActiveZones(now: Date = new Date()): Promise<DispatchRunSummary> {
    const day = utcDayStart(now);
    const zoneIds = await this.activeZoneIds();

    const summary: DispatchRunSummary = { zones: 0, schedules: 0, tickets: 0, errors: [] };
    for (const zoneId of zoneIds) {
      try {
        await this.recommender.runForZone(zoneId, { now });
        const out = await this.dispatch.dispatchForZone(zoneId, { dateFrom: day, dateTo: day, now });
        summary.zones++;
        summary.schedules += out.schedules;
        summary.tickets += out.tickets;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.logger.error(`dispatch run failed for zone ${zoneId}: ${message}`);
        summary.errors.push({ zoneId: zoneId.toString(), message });
      }
    }
    this.logger.log(
      `dispatch run: ${summary.zones} zones, ${summary.schedules} schedules, ${summary.tickets} tickets, ${summary.errors.length} errors`,
    );
    return summary;
  }

  /** Active zones = zones with at least one plant (the only zones that can carry dispatchable work). */
  private async activeZoneIds(): Promise<bigint[]> {
    const rows = await this.prisma.plant.findMany({ distinct: ['zoneId'], select: { zoneId: true }, orderBy: { zoneId: 'asc' } });
    return rows.map((r) => r.zoneId);
  }
}

/** UTC midnight of the day containing `now` — the daily Day Plan's single coverage date. */
function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
