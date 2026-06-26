import { Injectable, Optional } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** The Recommender's operating mode, switched off the Soft Inactive Count (CONTEXT §5). */
export type RecommenderMode = 'DEFICIT' | 'PREVENTIVE';

/** Default deficit-mode threshold: Soft Inactive Count > 2% × eligible device count (CONTEXT §5). */
export const DEFAULT_DEFICIT_THRESHOLD_PCT = 0.02;

export interface SoftInactiveRecomputeResult {
  capturedAt: string;
  zones: number;
}

interface ZoneCountRow {
  zoneId: bigint;
  softInactive: number;
  eligible: number;
}

/**
 * Soft Inactive Count signal (Issue 40, CONTEXT §5). The intraday operational counterpart to the
 * monthly Fleet Uptime %: per zone, the count of **Eligible Devices** (`eligible_for_uptime`, the same
 * gate as Fleet Uptime) currently silent >24h (`is_inactive`). `recompute` snapshots every zone into
 * `soft_inactive_count_history` twice daily (morning/afternoon); `modeForZone` is the live count-driven
 * switch the Recommender reads — DEFICIT when the count exceeds `thresholdPct × eligible`, else
 * PREVENTIVE. The threshold is configurable (CONTEXT default 2%). On-demand (no scheduler), same posture
 * as the other workers.
 */
@Injectable()
export class SoftInactiveCountService {
  constructor(
    private readonly prisma: PrismaService,
    // @Optional so Nest doesn't try to resolve a `Number` provider; the default (CONTEXT 2%) applies
    // under DI, and tests pass an explicit threshold for light fixtures.
    @Optional() private readonly thresholdPct: number = DEFAULT_DEFICIT_THRESHOLD_PCT,
  ) {}

  /** The live deficit/preventive switch for a zone — what the Recommender consumes at run time. */
  async modeForZone(zoneId: bigint, _now: Date = new Date()): Promise<RecommenderMode> {
    const rows = await this.prisma.$queryRaw<{ softInactive: number; eligible: number }[]>(Prisma.sql`
      SELECT
        COUNT(*) FILTER (WHERE ds.is_inactive = true AND ds.eligible_for_uptime = true)::int AS "softInactive",
        COUNT(*) FILTER (WHERE ds.eligible_for_uptime = true)::int AS "eligible"
      FROM device_states ds
      JOIN plants p ON p.plant_id = ds.plant_id
      WHERE p.zone_id = ${zoneId}`);
    const r = rows[0] ?? { softInactive: 0, eligible: 0 };
    return this.isDeficit(r.softInactive, r.eligible) ? 'DEFICIT' : 'PREVENTIVE';
  }

  /** Snapshot every zone's Soft Inactive Count into history (a twice-daily capture). */
  async recompute(now: Date = new Date()): Promise<SoftInactiveRecomputeResult> {
    const period = now.getUTCHours() < 12 ? 'MORNING' : 'AFTERNOON';
    const rows = await this.prisma.$queryRaw<ZoneCountRow[]>(Prisma.sql`
      SELECT z.zone_id AS "zoneId",
        COUNT(*) FILTER (WHERE ds.is_inactive = true AND ds.eligible_for_uptime = true)::int AS "softInactive",
        COUNT(*) FILTER (WHERE ds.eligible_for_uptime = true)::int AS "eligible"
      FROM zones z
      LEFT JOIN plants p ON p.zone_id = z.zone_id
      LEFT JOIN device_states ds ON ds.plant_id = p.plant_id
      GROUP BY z.zone_id`);

    await this.prisma.softInactiveCountHistory.createMany({
      data: rows.map((r) => ({
        zoneId: r.zoneId,
        capturedAt: now,
        period,
        softInactiveCount: r.softInactive,
        eligibleDeviceCount: r.eligible,
        deficitMode: this.isDeficit(r.softInactive, r.eligible),
        thresholdPct: new Prisma.Decimal(this.thresholdPct),
      })),
    });

    return { capturedAt: now.toISOString(), zones: rows.length };
  }

  private isDeficit(softInactive: number, eligible: number): boolean {
    return softInactive > this.thresholdPct * eligible;
  }
}
