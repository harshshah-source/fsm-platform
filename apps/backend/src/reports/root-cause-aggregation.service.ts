import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Result of one month's Root Cause Analytics aggregation run. */
export interface RootCauseAggregationResult {
  month: string; // ISO date of the month's first day
  submissions: number; // total structured-root-cause submissions aggregated into the month
}

/**
 * Root Cause Analytics aggregation worker (Issue 41, CONTEXT §Root Cause Analytics). `computeMonth`
 * rebuilds `root_cause_summary_monthly` for the month: one row per (month, zone, company, plant,
 * device_type, SE, root_cause_category) holding the count of troubleshooting submissions whose
 * **structured** `root_cause_category` falls in that bucket — the diagnosis free-text is never parsed.
 * A submission's month is its `submitted_at`; its zone is the ticket plant's zone, its company/plant the
 * ticket's, its device_type the device's. Rebuilt per month (delete + insert in one transaction) so the
 * report reads a small pre-aggregated cube and recompute is idempotent. On-demand (no scheduler) — a
 * BullMQ month-end cron wires to it when scheduling lands, same posture as the Fleet Uptime worker.
 */
@Injectable()
export class RootCauseAnalyticsAggregationService {
  constructor(private readonly prisma: PrismaService) {}

  async computeMonth(month: Date, now: Date = new Date()): Promise<RootCauseAggregationResult> {
    const monthStart = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1));
    const monthEnd = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1));

    const submissions = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`DELETE FROM root_cause_summary_monthly WHERE month = ${monthStart}`);
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO root_cause_summary_monthly
          (month, zone_id, company_id, plant_id, device_type, se_id, root_cause_category, submission_count, computed_at)
        SELECT ${monthStart}::date, p.zone_id, t.company_id, t.plant_id, d.device_type,
               ts.se_id, ts.root_cause_category, COUNT(*)::int, ${now}
        FROM troubleshooting_submissions ts
        JOIN tickets t ON t.ticket_id = ts.ticket_id
        LEFT JOIN plants p ON p.plant_id = t.plant_id
        LEFT JOIN devices d ON d.device_id = t.device_id
        WHERE ts.submitted_at >= ${monthStart} AND ts.submitted_at < ${monthEnd}
        GROUP BY p.zone_id, t.company_id, t.plant_id, d.device_type, ts.se_id, ts.root_cause_category`);
      const [{ total }] = await tx.$queryRaw<{ total: bigint }[]>(Prisma.sql`
        SELECT COALESCE(SUM(submission_count), 0)::bigint AS total
        FROM root_cause_summary_monthly WHERE month = ${monthStart}`);
      return Number(total);
    });

    return { month: monthStart.toISOString().slice(0, 10), submissions };
  }
}
