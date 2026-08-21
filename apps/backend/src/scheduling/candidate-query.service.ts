import { Injectable } from '@nestjs/common';
import { istDate } from '../common/ist-day';
import { SeAvailabilityService } from '../engineers/se-availability.service';
import type { SeAvailabilityStatus } from '../generated/prisma/enums';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { buildCandidateReadiness } from '../recommender/candidate-readiness';
import { CandidateSelectionService, type CoverageType } from '../recommender/candidate-selection.service';
import { applyHardFilters, type HardFilterReason } from '../recommender/hard-filters';
import { committedDayLoad } from './committed-day-load';
import type { ZmScope } from './zm-schedule-query.service';

/** Strict precedence as a number, for the tier headings the column groups under (#272 R6). */
const TIER_RANK: Record<CoverageType, number> = { DEDICATED: 1, MULTI_PLANT: 2, FLOATING: 3 };

/** One engineer's answer to "can you cover this plant, and can you carry it?" */
export interface CandidateRow {
  seId: string;
  name: string | null;
  /** The per-(engineer, plant) coverage type from `se_coverage` / the floating MV — **not** the
   *  engineer's global `engineer_master.coverage_type`, which for a MULTI_PLANT engineer says nothing
   *  about whether they cover *this* plant (#272 R4). */
  coverageType: CoverageType;
  /** 1 DEDICATED · 2 MULTI_PLANT · 3 FLOATING — the precedence the engine walks, displayed. */
  tierRank: number;
  /** What the engine's hard filters make of this candidate right now. */
  verdict: 'PASSED' | 'DROPPED';
  /** The first failing filter, exactly as `applyHardFilters` reports it; null when `PASSED`. */
  dropReason: HardFilterReason | null;
  /** #269's one committed-load figure for today. This issue defines no counter of its own. */
  committed: number;
  /** From `engineer_master`; null when the SE has no master row (reachable via `se_coverage`). */
  dailyCapacity: number | null;
  availabilityStatus: SeAvailabilityStatus;
  kitComplete: boolean;
  /** Names of the Common-Kit components the SE is short of — the tooltip behind "kit short ×2". */
  missingKit: string[];
}

export interface PlantCandidates {
  plantId: string;
  plantName: string;
  zoneId: string;
  /** In `orderedCandidatesForPlant` order, unchanged, **including** the ones the engine would drop. */
  candidates: CandidateRow[];
}

export interface CandidatesView {
  /** The IST operating day the figures are for — the same day a commit would be judged against. */
  date: string;
  plants: PlantCandidates[];
}

/**
 * The Assign Work Console's candidate column (#274, decisions #272 R4, R5 and R6).
 *
 * `orderedCandidatesForPlant` is the exact per-plant eligibility answer the dispatch engine uses, and
 * it has been backend-internal for its whole life: no admin surface could reach it, so every manual
 * picker in this codebase offers a flat list of names with no coverage, no tier and no load. This
 * service is that function published — nothing more, and deliberately nothing less.
 *
 * **Order is the engine's order, untouched.** Sorting for the operator's convenience would render a
 * ranking the engine does not use, which is precisely why #266 was sequenced ahead of this issue.
 *
 * **Dropped candidates are returned, not filtered out.** The operator's question at this column is
 * "why not them", and an empty list is the least useful possible answer to it. The engine persists
 * only drop *counts* to its trace, so before this the rows existed for a few milliseconds inside one
 * run and were never seen by anyone.
 *
 * **`TIER_NOT_REACHED` is not a verdict here.** #266 added it to the dispatch trace, where exactly one
 * ticket is being placed and a lower tier is consulted only when every higher one failed. This column
 * is not placing anything: a human may cross tiers deliberately (#272 R6), so every candidate is
 * evaluated on its own readiness and a never-reached tier would be a rejection the operator's own
 * decision has not yet made.
 */
@Injectable()
export class CandidateQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly selection: CandidateSelectionService,
    private readonly availability: SeAvailabilityService,
    private readonly inventory: InventoryService,
  ) {}

  async listForPlants(plantIds: bigint[], scope: ZmScope, now: Date = new Date()): Promise<CandidatesView> {
    const day = istDate(now);
    const date = day.toISOString().slice(0, 10);
    if (plantIds.length === 0) return { date, plants: [] };

    const plants = await this.prisma.plant.findMany({
      where: { plantId: { in: plantIds }, ...(this.zoneClamp(scope) ?? {}) },
      select: { plantId: true, name: true, zoneId: true },
    });
    if (plants.length === 0) return { date, plants: [] };

    const ordered = new Map<string, { seId: string; coverageType: CoverageType }[]>();
    for (const plant of plants) {
      ordered.set(String(plant.plantId), await this.selection.orderedCandidatesForPlant(plant.plantId));
    }

    // The readiness inputs are gathered **once for the union of candidates**, not once per plant: the
    // same engineer covers several of the selected plants far more often than not, and each of these
    // is a per-SE question whose answer cannot differ between two plants on one screen.
    const seIds = [...new Set([...ordered.values()].flat().map((c) => c.seId))];
    const [masters, load, availability, kits, names] = await Promise.all([
      this.prisma.engineerMaster.findMany({
        where: { engineerId: { in: seIds } },
        select: { engineerId: true, dailyCapacity: true, isActive: true },
      }),
      // #269's one definition, on `now` — the figure the recommender enforces against and every
      // manager picker already renders. This issue deliberately adds no second counter.
      committedDayLoad(this.prisma, now, { seIds }),
      this.availability.currentStatusMany(seIds, now),
      this.kitStatuses(seIds),
      this.names(seIds),
    ]);
    const capacityBySe = new Map(
      masters.map((m) => [m.engineerId, { dailyCapacity: m.dailyCapacity, isActive: m.isActive }]),
    );

    const out: PlantCandidates[] = plants.map((plant) => {
      const candidates = ordered.get(String(plant.plantId)) ?? [];
      const readiness = candidates.map((c) => {
        const kit = kits.get(c.seId);
        return {
          ...buildCandidateReadiness({
            seId: c.seId,
            coverageType: c.coverageType,
            availabilityStatus: availability.get(c.seId) ?? 'AVAILABLE',
            committed: load.get(c.seId) ?? 0,
            capacity: capacityBySe.get(c.seId),
            commonKitComplete: kit?.complete ?? true,
          }),
          missingKit: kit?.missing ?? [],
        };
      });
      // The engine's own partition, over the engine's own readiness. `dropped` keeps its input order,
      // so re-joining by `se_id` below preserves `orderedCandidatesForPlant`'s sequence for both halves.
      const { dropped } = applyHardFilters(readiness);
      const dropReasonBySe = new Map(dropped.map((d) => [d.candidate.seId, d.reason]));

      return {
        plantId: String(plant.plantId),
        plantName: plant.name,
        zoneId: String(plant.zoneId),
        candidates: readiness.map((r) => {
          const reason = dropReasonBySe.get(r.seId) ?? null;
          return {
            seId: r.seId,
            name: names.get(r.seId) ?? null,
            coverageType: r.coverageType,
            tierRank: TIER_RANK[r.coverageType],
            verdict: reason === null ? ('PASSED' as const) : ('DROPPED' as const),
            dropReason: reason,
            committed: load.get(r.seId) ?? 0,
            dailyCapacity: capacityBySe.get(r.seId)?.dailyCapacity ?? null,
            availabilityStatus: availability.get(r.seId) ?? ('AVAILABLE' as SeAvailabilityStatus),
            kitComplete: r.commonKitComplete,
            missingKit: r.missingKit.map((m) => m.name),
          };
        }),
      };
    });

    // The caller's order, so the column can follow the plant the operator is working on without
    // hunting through a list the server reshuffled.
    out.sort((a, b) => plantIds.indexOf(BigInt(a.plantId)) - plantIds.indexOf(BigInt(b.plantId)));
    return { date, plants: out };
  }

  /** Common-Kit completeness per SE. One call each — `commonKitStatus` is keyed on the SE. */
  private async kitStatuses(seIds: string[]) {
    const entries = await Promise.all(
      seIds.map(async (seId) => [seId, await this.inventory.commonKitStatus(seId)] as const),
    );
    return new Map(entries);
  }

  private async names(seIds: string[]): Promise<Map<string, string | null>> {
    if (seIds.length === 0) return new Map();
    const rows = await this.prisma.user.findMany({
      where: { userId: { in: seIds } },
      select: { userId: true, name: true },
    });
    return new Map(rows.map((r) => [r.userId, r.name]));
  }

  /**
   * A ZONAL_MANAGER sees candidates only for plants in their own zone; CSM / Operations Head see
   * every zone — the same clamp every other manager read on this controller applies, hung off
   * `plants.zone_id`.
   *
   * An out-of-zone plant is **omitted from the response** rather than refused, so a request naming
   * several plants still answers for the ones the caller may see. Via the console this cannot happen
   * at all — the work pool it selects from is clamped by the same rule — so the case only arises for
   * a hand-made request, where returning nothing for that plant is the honest answer.
   */
  private zoneClamp(scope: ZmScope): { zoneId: bigint } | null {
    return scope.role === 'ZONAL_MANAGER' && scope.zoneId != null ? { zoneId: BigInt(scope.zoneId) } : null;
  }
}
