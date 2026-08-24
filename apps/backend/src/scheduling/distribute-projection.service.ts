import { Injectable } from '@nestjs/common';
import { istDate } from '../common/ist-day';
import { PrismaService } from '../prisma/prisma.service';
import { type PoolEmptyReason, RecommenderService } from '../recommender/recommender.service';
import { CandidateQueryService, type CandidateRow } from './candidate-query.service';
import { committedDayLoad } from './committed-day-load';
import type { ZmScope } from './zm-schedule-query.service';

/** The three ways Distribute can turn a ticket selection + an engineer selection into a plan (#276). */
export type DistributeStrategy = 'COVERAGE_TIER' | 'CAPACITY_HEADROOM' | 'PLANT_WHOLE';

export interface DistributePlantStop {
  plantId: string;
  ticketIds: string[];
}
export interface DistributeLane {
  seId: string;
  plants: DistributePlantStop[];
}
export interface DistributeUnplaced {
  ticketId: string;
  plantId: string;
  reason: PoolEmptyReason;
}
export interface DistributeResult {
  strategy: DistributeStrategy;
  targetDate: string;
  lanes: DistributeLane[];
  unplaced: DistributeUnplaced[];
  /** Engineers this projection would take to or past `dailyCapacity` — stated, never a reason to refuse. */
  overCapacitySeIds: string[];
}

interface ScopedTicket {
  ticketId: string;
  plantId: bigint;
  zoneId: bigint;
}

/**
 * #276 — Distribute: several plants across several engineers, projected before anything is written.
 *
 * **Eligibility, tier and readiness are never re-derived here.** `CandidateQueryService` already
 * publishes `buildCandidateReadiness` + `applyHardFilters` — the exact function the recommender itself
 * calls (#274) — so "who can cover this plant, at what tier, and are they currently passing" has
 * exactly one answer regardless of which surface asks. This service's own logic is the **allocation**
 * question the issue commissions three answers to: given several equally-eligible engineers, who
 * actually gets which ticket. That is a policy choice, not a second copy of the selection rule.
 *
 * **`COVERAGE_TIER` is the odd one out, deliberately.** It is not a re-derivation at all — it calls
 * {@link RecommenderService.runForZone}'s scoped dry run (#250's seam, #276 extending it with
 * `ticketIds`/`engineerIds`) and reports exactly what the engine itself would choose. That is what
 * makes the single-ticket/single-candidate AC true by construction: for a selection with only one
 * possible placement, all three strategies collapse to this one anyway.
 */
@Injectable()
export class DistributeProjectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly recommender: RecommenderService,
    private readonly candidateQuery: CandidateQueryService,
  ) {}

  async project(
    ticketIds: string[],
    engineerIds: string[],
    strategy: DistributeStrategy,
    scope: ZmScope,
    now: Date = new Date(),
  ): Promise<DistributeResult> {
    const day = istDate(now);
    const targetDate = day.toISOString().slice(0, 10);
    const scoped = await this.scopedTickets(ticketIds, scope);

    const base: Pick<DistributeResult, 'strategy' | 'targetDate'> = { strategy, targetDate };
    if (scoped.length === 0 || engineerIds.length === 0) {
      return { ...base, lanes: [], unplaced: [], overCapacitySeIds: [] };
    }

    const { lanes, unplaced } =
      strategy === 'COVERAGE_TIER'
        ? await this.byEngine(scoped, engineerIds, now)
        : await this.byAllocation(scoped, engineerIds, strategy, scope, now);

    const overCapacitySeIds = await this.markOverCapacity(lanes, now);
    return { ...base, lanes, unplaced, overCapacitySeIds };
  }

  /**
   * `COVERAGE_TIER` — the engine's own answer, scoped. Tickets can span more than one zone (an
   * Operations Head or CSM's selection is not zone-clamped); `runForZone` is per-zone, so this groups
   * the selection by zone and runs the scoped dry run once per zone touched, merging the results —
   * the same composition {@link RecommenderService.runForZone}'s other multi-zone caller
   * (`DispatchRunService.previewActiveZones`) already uses, not a new one.
   */
  private async byEngine(
    scoped: ScopedTicket[],
    engineerIds: string[],
    now: Date,
  ): Promise<{ lanes: DistributeLane[]; unplaced: DistributeUnplaced[] }> {
    const byZone = new Map<string, string[]>();
    for (const t of scoped) {
      const key = t.zoneId.toString();
      (byZone.get(key) ?? byZone.set(key, []).get(key)!).push(t.ticketId);
    }

    const lanesBySe = new Map<string, Map<string, string[]>>();
    const unplaced: DistributeUnplaced[] = [];
    for (const [zoneIdStr, zoneTicketIds] of byZone) {
      const summary = await this.recommender.runForZone(BigInt(zoneIdStr), {
        now,
        dryRun: true,
        targetDate: now,
        ticketIds: zoneTicketIds,
        engineerIds,
      });
      const projection = summary.projection!;
      for (const entry of projection.plan) {
        for (const stop of entry.plants) this.addToLane(lanesBySe, entry.seId, stop.plantId, stop.ticketIds);
      }
      for (const d of projection.decisions) {
        if (d.seId === null) unplaced.push({ ticketId: d.ticketId, plantId: d.plantId, reason: d.poolEmptyReason! });
      }
    }
    return { lanes: this.laneArray(lanesBySe), unplaced };
  }

  /**
   * `CAPACITY_HEADROOM` / `PLANT_WHOLE` — allocation over the ONE shared readiness read
   * ({@link CandidateQueryService.listForPlants}), restricted to the selected engineers. Tier order is
   * always respected (a lower tier is only consulted when the selection has no PASSED candidate in any
   * higher one — a structural fact of coverage, which is per-plant, not per-ticket); the two strategies
   * differ only in how they place work **within** the best available tier.
   */
  private async byAllocation(
    scoped: ScopedTicket[],
    engineerIds: string[],
    strategy: Exclude<DistributeStrategy, 'COVERAGE_TIER'>,
    scope: ZmScope,
    now: Date,
  ): Promise<{ lanes: DistributeLane[]; unplaced: DistributeUnplaced[] }> {
    const plantIds = [...new Set(scoped.map((t) => t.plantId))];
    const candidates = await this.candidateQuery.listForPlants(plantIds, scope, now);
    const byPlant = new Map(candidates.plants.map((p) => [p.plantId, p.candidates]));

    const ticketsByPlant = new Map<string, string[]>();
    for (const t of scoped) {
      const key = String(t.plantId);
      (ticketsByPlant.get(key) ?? ticketsByPlant.set(key, []).get(key)!).push(t.ticketId);
    }

    const engineerSet = new Set(engineerIds);
    const lanesBySe = new Map<string, Map<string, string[]>>();
    const unplaced: DistributeUnplaced[] = [];
    // Seeded from #269's committed load and grown as this projection places work — the same "real
    // commitment plus what this pass is adding" pattern `runForZone`'s own capacity accounting uses
    // (NEW-A1), so headroom reflects what this specific plan would do, not a stale snapshot.
    const runningPlaced = new Map<string, number>();

    // Deterministic plant order — the projection must not depend on Map iteration order.
    for (const plantId of [...ticketsByPlant.keys()].sort()) {
      const plantTicketIds = ticketsByPlant.get(plantId)!;
      const all = (byPlant.get(plantId) ?? []).filter((c) => engineerSet.has(c.seId));
      if (all.length === 0) {
        for (const ticketId of plantTicketIds) unplaced.push({ ticketId, plantId, reason: 'NO_COVERAGE' });
        continue;
      }
      const passed = all.filter((c) => c.verdict === 'PASSED');
      if (passed.length === 0) {
        for (const ticketId of plantTicketIds) unplaced.push({ ticketId, plantId, reason: 'ALL_DROPPED' });
        continue;
      }
      const bestTier = Math.min(...passed.map((c) => c.tierRank));
      const tierCandidates = passed.filter((c) => c.tierRank === bestTier);

      if (strategy === 'PLANT_WHOLE') {
        const winner = this.mostHeadroom(tierCandidates, runningPlaced)[0];
        this.addToLane(lanesBySe, winner.seId, plantId, plantTicketIds);
        runningPlaced.set(winner.seId, (runningPlaced.get(winner.seId) ?? 0) + plantTicketIds.length);
      } else {
        // CAPACITY_HEADROOM — per ticket, so load actually spreads across a tier with more than one
        // eligible engineer rather than landing on whichever sorts first.
        for (const ticketId of plantTicketIds) {
          const winner = this.mostHeadroom(tierCandidates, runningPlaced)[0];
          this.addToLane(lanesBySe, winner.seId, plantId, [ticketId]);
          runningPlaced.set(winner.seId, (runningPlaced.get(winner.seId) ?? 0) + 1);
        }
      }
    }
    return { lanes: this.laneArray(lanesBySe), unplaced };
  }

  /** Most remaining headroom first (unset capacity = infinite headroom, never the tie-break); seId asc breaks ties deterministically. */
  private mostHeadroom(candidates: CandidateRow[], runningPlaced: Map<string, number>): CandidateRow[] {
    const headroom = (c: CandidateRow): number =>
      c.dailyCapacity === null ? Number.POSITIVE_INFINITY : c.dailyCapacity - (c.committed + (runningPlaced.get(c.seId) ?? 0));
    return [...candidates].sort((a, b) => headroom(b) - headroom(a) || a.seId.localeCompare(b.seId));
  }

  private addToLane(lanesBySe: Map<string, Map<string, string[]>>, seId: string, plantId: string, ticketIds: string[]): void {
    const plants = lanesBySe.get(seId) ?? new Map<string, string[]>();
    const existing = plants.get(plantId) ?? [];
    plants.set(plantId, [...existing, ...ticketIds]);
    lanesBySe.set(seId, plants);
  }

  private laneArray(lanesBySe: Map<string, Map<string, string[]>>): DistributeLane[] {
    return [...lanesBySe].map(([seId, plants]) => ({
      seId,
      plants: [...plants].map(([plantId, ticketIds]) => ({ plantId, ticketIds })),
    }));
  }

  /**
   * Overflow is visible, never prevented (#258 Q2 / required-change #5) — computed once, after lanes
   * are final, so it applies uniformly whichever strategy built them (a `PLANT_WHOLE` lane can push an
   * engineer over capacity exactly as `CAPACITY_HEADROOM` can; `COVERAGE_TIER` structurally shouldn't,
   * since the engine's own hard filter drops an over-capacity candidate, but the check costs nothing
   * to apply uniformly and does not assume that invariant holds forever).
   */
  private async markOverCapacity(lanes: DistributeLane[], now: Date): Promise<string[]> {
    const seIds = lanes.map((l) => l.seId);
    if (seIds.length === 0) return [];
    const [masters, committed] = await Promise.all([
      this.prisma.engineerMaster.findMany({ where: { engineerId: { in: seIds } }, select: { engineerId: true, dailyCapacity: true } }),
      committedDayLoad(this.prisma, now, { seIds }),
    ]);
    const capacityBySe = new Map(masters.map((m) => [m.engineerId, m.dailyCapacity]));
    return lanes
      .filter((l) => {
        const cap = capacityBySe.get(l.seId);
        if (cap === undefined || cap === null || cap <= 0) return false;
        const placed = l.plants.reduce((n, p) => n + p.ticketIds.length, 0);
        const total = (committed.get(l.seId) ?? 0) + placed;
        return total >= cap;
      })
      .map((l) => l.seId);
  }

  /**
   * Resolve the caller's ticket ids to (plant, zone), dropping anything outside the caller's scope —
   * the same acting-zone posture every other console read on this controller applies: an out-of-scope
   * id is omitted, not refused, so one bad id cannot blank the projection for the rest.
   */
  private async scopedTickets(ticketIds: string[], scope: ZmScope): Promise<ScopedTicket[]> {
    if (ticketIds.length === 0) return [];
    const rows = await this.prisma.ticket.findMany({
      where: { ticketId: { in: ticketIds } },
      select: { ticketId: true, plantId: true, plant: { select: { zoneId: true } } },
    });
    return rows
      .filter((r) => this.inScope(r.plant.zoneId, scope))
      .map((r) => ({ ticketId: r.ticketId, plantId: r.plantId, zoneId: r.plant.zoneId }));
  }

  private inScope(zoneId: bigint, scope: ZmScope): boolean {
    if (scope.role === 'ZONAL_MANAGER') return scope.zoneId != null && BigInt(scope.zoneId) === zoneId;
    return true;
  }
}
