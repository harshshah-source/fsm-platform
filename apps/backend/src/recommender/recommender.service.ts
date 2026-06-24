import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { type CommonKitStatus, InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { CandidateSelectionService } from './candidate-selection.service';
import { type CandidateTicket, type DeviceBucket, canonicalSort } from './canonical-sort';
import { type SeCandidateReadiness, applyHardFilters } from './hard-filters';
import { type ScoringWeights, scoreCandidate } from './scoring';

const DEFAULT_CLUSTER_MULTIPLIER = 1.25;
const DEFAULT_WEIGHT_SET = 'v1';

// Device-bucket → dispatch urgency (0..1), monotonic in severity.
const BUCKET_SEVERITY: DeviceBucket[] = [
  'WARNING',
  'EARLY_RISK',
  'RISK',
  'CRITICAL',
  'HIGH_CRITICAL',
  'SEVERE',
  'VERY_SEVERE',
  'LONG_PENDING',
];
const urgencyFromBucket = (b: DeviceBucket): number => BUCKET_SEVERITY.indexOf(b) / (BUCKET_SEVERITY.length - 1);

export interface RunSummary {
  recommended: number;
  unassignable: number;
}

/**
 * The Recommender orchestrator (ADR-0001/0003/0017, LLD §13.1; Issue 10). Per zone: collect OPEN
 * unassigned TROUBLESHOOT tickets, canonical-sort them, and for each pick the highest-precedence
 * eligible SE (Dedicated→Multi-Plant→Floating, with a hard-filter/capacity fallback to the next
 * tier), score it (Plant Cluster Multiplier on additional same-plant tickets), and persist a
 * `recommendations` row with the reasoning breakdown. No eligible SE → an UNASSIGNABLE row (never
 * silently dropped). Day-plan grouping + dispatch is Issue 11; this only selects + explains.
 */
@Injectable()
export class RecommenderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly candidates: CandidateSelectionService,
    // Defaulted so direct construction in tests need not pass it; Nest injects the provider.
    private readonly inventory: InventoryService = new InventoryService(prisma),
  ) {}

  async runForZone(zoneId: bigint, opts: { now?: Date } = {}): Promise<RunSummary> {
    const now = opts.now ?? new Date();

    const tickets = await this.prisma.ticket.findMany({
      where: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        assignmentState: 'UNASSIGNED',
        plant: { zoneId },
      },
      include: {
        company: { select: { companyTier: true, companyPriorityRank: true } },
        device: { select: { state: { select: { slaBucket: true, latestGpsDatetime: true } } } },
      },
    });

    // Build the canonical-sort candidate list (skip tickets with no computed bucket — unrankable).
    const rankable = tickets.filter((t) => t.device.state?.slaBucket != null);
    const candidateTickets: (CandidateTicket & { plantId: bigint; repeatFailure: boolean })[] = rankable.map((t) => ({
      ticketId: t.ticketId,
      companyTier: t.company.companyTier,
      deviceBucket: t.device.state!.slaBucket as DeviceBucket,
      companyPriorityRank: t.company.companyPriorityRank,
      latestGpsDatetime: t.device.state!.latestGpsDatetime,
      deviceId: t.deviceId,
      plantId: t.plantId,
      repeatFailure: t.repeatFailure,
    }));
    const sorted = canonicalSort(candidateTickets);

    const { weights, weightSetRef } = await this.activeWeights();
    const clusterMultiplier = await this.plantClusterMultiplier();
    const capacity = await this.engineerCapacity();

    const assigned = new Map<string, number>(); // se_id → tickets assigned this run
    const seededPlants = new Set<string>(); // plant_id → already has a cluster seed this run
    const plannerByPlant = await this.plannerForDate(zoneId, now); // plant_id → planned se_ids (soft bias)
    const kitStatusBySe = new Map<string, CommonKitStatus>(); // memoised Common-Kit status per SE

    let recommended = 0;
    let unassignable = 0;

    for (let i = 0; i < sorted.length; i++) {
      const t = sorted[i];
      const processingRank = i + 1;
      const ordered = await this.candidates.orderedCandidatesForPlant(t.plantId);

      // Common-Kit completeness per candidate (Issue 21) — memoised across the run. Availability and
      // vehicle readiness remain seams (issues 25/28); the expected-component leg is deferred until
      // `expected_components` lands (Issue 22).
      await Promise.all(ordered.map((c) => this.ensureKitStatus(c.seId, kitStatusBySe)));

      const readiness: (SeCandidateReadiness & { seId: string })[] = ordered.map((c) => {
        const cap = capacity.get(c.seId);
        return {
          seId: c.seId,
          vehicleReadiness: 'UNKNOWN',
          available: cap?.isActive ?? true,
          overCapacity: cap !== undefined && (assigned.get(c.seId) ?? 0) >= cap.dailyCapacity,
          commonKitComplete: kitStatusBySe.get(c.seId)?.complete ?? true,
          expectedComponentsAvailable: true,
        };
      });
      // SE Planner soft bias (ADR-0022): among eligible candidates, prefer the planner-named SE for
      // this plant/date; otherwise keep strict precedence (passed[0]). Activity-ping staleness is NOT
      // a filter — `last_activity_at` never gates scoring (CONTEXT §3/§16).
      const filtered = applyHardFilters(readiness);
      const passed = filtered.passed;
      const planned = plannerByPlant.get(String(t.plantId));
      const chosen = (planned ? passed.find((c) => planned.has(c.seId)) : undefined) ?? passed[0] ?? null;

      const isSeed = !seededPlants.has(String(t.plantId));
      seededPlants.add(String(t.plantId));
      const multiplier = isSeed ? 1 : clusterMultiplier;

      if (chosen === null) {
        await this.prisma.recommendation.create({
          data: {
            ticketId: t.ticketId,
            seId: null,
            companyTier: t.companyTier,
            deviceBucket: t.deviceBucket,
            scoreBreakdown: { reason: 'NO_ELIGIBLE_SE', weightSetRef, companyTier: t.companyTier, deviceBucket: t.deviceBucket } as Prisma.InputJsonValue,
            processingRank,
            status: 'UNASSIGNABLE',
            path: 'MORNING_BATCH',
          },
        });
        // Component-Blocked Queue (Issue 21): if a candidate was dropped because their Common Kit is
        // incomplete, record the ticket with the missing parts so the ZM sees an operational reason.
        const kitDrop = filtered.dropped.find((d) => d.reason === 'COMMON_KIT_INCOMPLETE');
        if (kitDrop) {
          const missing = kitStatusBySe.get(kitDrop.candidate.seId)?.missing ?? [];
          await this.inventory.recordComponentBlock(t.ticketId, kitDrop.candidate.seId, missing);
        }
        unassignable++;
        continue;
      }

      // The ticket is assignable now — clear any stale Component-Blocked row for it.
      await this.inventory.resolveComponentBlock(t.ticketId, now);

      const coverageType = ordered.find((c) => c.seId === chosen.seId)!.coverageType;
      const scored = scoreCandidate(
        {
          companyPriorityRank: t.companyPriorityRank,
          dispatchUrgency: urgencyFromBucket(t.deviceBucket),
          repeatFailure: t.repeatFailure,
          distanceFromPrevStopKm: null, // Floating distance-from-previous-stop deferred (needs day-plan geo)
        },
        weights,
        multiplier,
      );

      assigned.set(chosen.seId, (assigned.get(chosen.seId) ?? 0) + 1);

      await this.prisma.recommendation.create({
        data: {
          ticketId: t.ticketId,
          seId: chosen.seId,
          companyTier: t.companyTier,
          deviceBucket: t.deviceBucket,
          scoreBreakdown: {
            ...scored.breakdown,
            weightSetRef,
            coverageType,
            companyTier: t.companyTier,
            deviceBucket: t.deviceBucket,
            companyPriorityRank: t.companyPriorityRank,
            score: scored.score,
          } as Prisma.InputJsonValue,
          processingRank,
          status: 'SUGGESTED',
          path: 'MORNING_BATCH',
        },
      });
      recommended++;
    }

    return { recommended, unassignable };
  }

  /** Memoise Common-Kit completeness for an SE within a run (Issue 21). */
  private async ensureKitStatus(seId: string, cache: Map<string, CommonKitStatus>): Promise<void> {
    if (cache.has(seId)) return;
    cache.set(seId, await this.inventory.commonKitStatus(seId));
  }

  /** SE Planner entries for the run date, as plant_id → planned se_ids (soft bias, ADR-0022). */
  private async plannerForDate(zoneId: bigint, now: Date): Promise<Map<string, Set<string>>> {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const entries = await this.prisma.sePlanner.findMany({
      where: { plannedDate: day, plant: { zoneId } },
      select: { seId: true, plantId: true },
    });
    const map = new Map<string, Set<string>>();
    for (const e of entries) {
      const key = String(e.plantId);
      const set = map.get(key) ?? new Set<string>();
      set.add(e.seId);
      map.set(key, set);
    }
    return map;
  }

  /** Active weight set → component→weight map + its ref (stamped into each score_breakdown). */
  private async activeWeights(): Promise<{ weights: ScoringWeights; weightSetRef: string }> {
    const active = await this.prisma.priorityRuleConfig.findMany({ where: { active: true }, orderBy: { id: 'asc' } });
    const weightSetRef =
      active.find((r) => r.component === 'company_priority_rank')?.weightSetRef ??
      active[0]?.weightSetRef ??
      DEFAULT_WEIGHT_SET;
    const weights: ScoringWeights = {};
    for (const r of active) if (r.weightSetRef === weightSetRef) weights[r.component] = Number(r.weight);
    return { weights, weightSetRef };
  }

  private async plantClusterMultiplier(): Promise<number> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: 'plant_cluster_multiplier' } });
    const v = Number(row?.value);
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_CLUSTER_MULTIPLIER;
  }

  private async engineerCapacity(): Promise<Map<string, { dailyCapacity: number; isActive: boolean }>> {
    const rows = await this.prisma.engineerMaster.findMany({
      select: { engineerId: true, dailyCapacity: true, isActive: true },
    });
    return new Map(rows.map((r) => [r.engineerId, { dailyCapacity: r.dailyCapacity, isActive: r.isActive }]));
  }
}
