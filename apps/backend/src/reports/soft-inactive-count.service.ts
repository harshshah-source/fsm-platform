import { Injectable, Optional } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** The Recommender's operating mode, switched off the Soft Inactive Count (CONTEXT §5). */
export type RecommenderMode = 'DEFICIT' | 'PREVENTIVE';

/**
 * One zone's live operating mode + the counts that decide it (Issue 136 read seam). `mode` is the
 * SAME enum `modeForZone` feeds the recommender — this is a legibility surface, not a new signal.
 * **The `mode` enum must never be rendered to a user**; the admin FE maps it to plain language
 * ("Catch-up"/"Steady") in one util. Counts are exposed so the UI can state a human reason.
 */
export interface ZoneOperatingMode {
  zoneId: string;
  zoneName: string;
  mode: RecommenderMode;
  /** Eligible devices in the zone currently silent (`is_inactive` AND `eligible_for_uptime`). */
  silentCount: number;
  /** Eligible devices in the zone (`eligible_for_uptime`) — the denominator behind the switch. */
  eligibleCount: number;
}

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
 * gate as Fleet Uptime) currently silent >24h (`is_inactive`).
 *
 * **#223 — this surface is fixed by the state layer, not here, and that is deliberate.**
 * `cross-analysis.md` §2.3 listed it as surface 5: all 913 never-reported devices sat in the
 * `eligible` DENOMINATOR while never entering the `is_inactive` numerator, so the zone's inactive rate
 * was depressed by devices that had never worked at all. The fix is `DeviceStateService.recompute`
 * ageing a never-reported device from its install date, which puts it in the numerator too — the
 * predicates below need no change and must not get one. Adding a `latest_gps_datetime IS NOT NULL`
 * clause here would be actively wrong: this is a WORKLOAD signal driving the recommender's
 * deficit/preventive switch, and an NDD device past its grace window is real work for a real SE.
 *
 * What remains, knowingly: a device inside the 24 h install grace window (and the 6 source-orphans of
 * #227, which have no install date anywhere) stays denominator-only. That is correct — a tracker fitted
 * this morning is not yet a fault — and the population is small enough to name rather than engineer for.
 *
 * `recompute` snapshots every zone into
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

  /**
   * Live operating mode + supporting counts for one zone, or every zone (Issue 136 read seam). Same
   * per-zone counting and `isDeficit` decision as {@link modeForZone} — deliberately mirrored so the
   * displayed mode is provably the one the recommender reads (pinned by the e2e fidelity test). Counts
   * come straight from `device_states`; **no** deactivated-plant filter, because the recommender's own
   * mode (`modeForZone`) does not apply one — a legibility surface must show the real signal, not a
   * prettier variant. LEFT JOINs from `zones` so a zone with no plants/devices still returns a row
   * (eligible 0 → PREVENTIVE, no divide-by-zero). Reads live, never `soft_inactive_count_history`.
   */
  async operatingModes(zoneId?: bigint): Promise<ZoneOperatingMode[]> {
    const rows = await this.prisma.$queryRaw<
      { zoneId: string; zoneName: string; softInactive: number; eligible: number }[]
    >(Prisma.sql`
      SELECT z.zone_id::text AS "zoneId",
        z.name AS "zoneName",
        COUNT(*) FILTER (WHERE ds.is_inactive = true AND ds.eligible_for_uptime = true)::int AS "softInactive",
        COUNT(*) FILTER (WHERE ds.eligible_for_uptime = true)::int AS "eligible"
      FROM zones z
      LEFT JOIN plants p ON p.zone_id = z.zone_id
      LEFT JOIN device_states ds ON ds.plant_id = p.plant_id
      ${zoneId === undefined ? Prisma.empty : Prisma.sql`WHERE z.zone_id = ${zoneId}`}
      GROUP BY z.zone_id, z.name
      ORDER BY z.zone_id`);
    return rows.map((r) => ({
      zoneId: r.zoneId,
      zoneName: r.zoneName,
      mode: this.isDeficit(r.softInactive, r.eligible) ? 'DEFICIT' : 'PREVENTIVE',
      silentCount: r.softInactive,
      eligibleCount: r.eligible,
    }));
  }

  /** Live operating mode + counts for a single zone (Issue 136); null if the zone does not exist. */
  async operatingModeForZone(zoneId: bigint): Promise<ZoneOperatingMode | null> {
    const [row] = await this.operatingModes(zoneId);
    return row ?? null;
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
