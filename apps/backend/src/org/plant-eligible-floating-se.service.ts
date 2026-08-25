import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** The view this service owns — the key its freshness row is stored under (#287). */
export const PLANT_ELIGIBLE_FLOATING_SE_MV = 'plant_eligible_floating_se';

/** How current a materialized view is, as the dispatch run's pre-check and snapshot see it. */
export interface MvFreshness {
  viewName: string;
  lastAttemptAt: string | null;
  /** NULL means it has never successfully rebuilt — which is not the same as fresh. */
  lastSuccessAt: string | null;
  lastError: string | null;
}

/**
 * True when the view has not rebuilt since the start of the operating day.
 *
 * Never-refreshed counts as stale: an empty freshness row and a fresh one are different facts, and
 * defaulting the unknown case to "fine" is the failure mode #287 exists to remove.
 */
export function isMvStale(freshness: MvFreshness, dayStart: Date): boolean {
  if (freshness.lastSuccessAt == null) return true;
  return new Date(freshness.lastSuccessAt).getTime() < dayStart.getTime();
}

/**
 * `plant_eligible_floating_se` materialized view access (ADR-0006, Issue 09). The MV precomputes the
 * plant → eligible-Floating-SE union (district / region / state hierarchical membership ∪
 * `ST_Contains(polygon, plant.location)`), keeping the Recommender hot path (Issue 10) an index
 * lookup. `refresh()` rebuilds it — invoked on territory edits and (later) nightly.
 */
@Injectable()
export class PlantEligibleFloatingSeService {
  constructor(private readonly prisma: PrismaService) {}

  /** Rebuild the MV from current plants + territory. Refreshes CONCURRENTLY (readers keep the old
   * snapshot, no lock) via the unique index; falls back to a plain refresh for the first-ever run,
   * when the MV is still unpopulated (created WITH NO DATA) and CONCURRENTLY is not yet allowed.
   *
   * **#287 — the outcome is recorded, not just returned.** The 04:30 tick that calls this catches and
   * logs its own failure and escalates nothing, and the 05:00 dispatch run that consumes the view
   * had no way to ask whether the rebuild worked. Now every attempt leaves a row, so a stale pool is
   * a fact the run can read and freeze into its snapshot rather than a silence. The throw still
   * propagates — recording a failure must not turn it into a success. */
  async refresh(now: Date = new Date()): Promise<void> {
    try {
      try {
        await this.prisma.$executeRawUnsafe('REFRESH MATERIALIZED VIEW CONCURRENTLY "plant_eligible_floating_se"');
      } catch {
        await this.prisma.$executeRawUnsafe('REFRESH MATERIALIZED VIEW "plant_eligible_floating_se"');
      }
      await this.recordRefresh(PLANT_ELIGIBLE_FLOATING_SE_MV, now, null);
    } catch (e) {
      await this.recordRefresh(
        PLANT_ELIGIBLE_FLOATING_SE_MV,
        now,
        e instanceof Error ? e.message : String(e),
      );
      throw e;
    }
  }

  /**
   * Stamp the attempt. Failure to record is swallowed on purpose: bookkeeping about a refresh must
   * never be the thing that fails a refresh, and the run's staleness check reads the *absence* of a
   * recent success — so a lost write degrades toward "assume stale", which is the safe direction.
   */
  private async recordRefresh(viewName: string, now: Date, error: string | null): Promise<void> {
    try {
      await this.prisma.mvRefreshState.upsert({
        where: { viewName },
        create: {
          viewName,
          lastAttemptAt: now,
          lastSuccessAt: error === null ? now : null,
          lastError: error,
        },
        update: {
          lastAttemptAt: now,
          ...(error === null ? { lastSuccessAt: now, lastError: null } : { lastError: error }),
        },
      });
    } catch {
      /* see above — never mask the refresh's own outcome */
    }
  }

  /** When this view last rebuilt successfully, and what went wrong last if anything. */
  async freshness(viewName: string = PLANT_ELIGIBLE_FLOATING_SE_MV): Promise<MvFreshness> {
    const row = await this.prisma.mvRefreshState.findUnique({ where: { viewName } });
    return {
      viewName,
      lastAttemptAt: row?.lastAttemptAt?.toISOString() ?? null,
      lastSuccessAt: row?.lastSuccessAt?.toISOString() ?? null,
      lastError: row?.lastError ?? null,
    };
  }

  /** The FLOATING SEs whose territory covers this plant, per the precomputed MV. */
  async eligibleSeIdsForPlant(plantId: bigint | number): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ se_id: string }[]>(
      Prisma.sql`SELECT se_id FROM plant_eligible_floating_se WHERE plant_id = ${BigInt(plantId)}`,
    );
    return rows.map((r) => r.se_id);
  }
}
