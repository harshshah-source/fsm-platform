import { Injectable } from '@nestjs/common';
import { SeAvailabilityService } from '../engineers/se-availability.service';
import { Prisma } from '../generated/prisma/client';
import { type SeAvailabilityStatus } from '../generated/prisma/enums';
import { type CommonKitStatus, InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { type RecommenderMode, SoftInactiveCountService } from '../reports/soft-inactive-count.service';
import { CandidateSelectionService } from './candidate-selection.service';
import { type CandidateTicket, type CompanyTier, type DeviceBucket, canonicalSort, installSort } from './canonical-sort';
import { type SeCandidateReadiness, applyHardFilters } from './hard-filters';
import { type ScoringWeights, scoreCandidate } from './scoring';

const DEFAULT_CLUSTER_MULTIPLIER = 1.25;
const DEFAULT_WEIGHT_SET = 'v1';
// PREVENTIVE-mode code defaults (Issue 72), used when no `<ref>_preventive` set is configured in
// `priority_rule_config`. Repeat-failure flips from penalty to bonus and aged devices add — biasing the
// planner toward repeat-offenders and aged devices (CONTEXT §5). Tunable via the DB set.
const PREVENTIVE_SUFFIX = '_preventive';
const PREVENTIVE_REPEAT_BONUS = 0.5;
const PREVENTIVE_AGE_WEIGHT = 0.5;

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
  /** The zone's active Recommender mode this run, switched off the Soft Inactive Count (Issue 40). */
  mode: RecommenderMode;
}

/**
 * A unified processing-order entry: TROUBLESHOOT candidates (canonical-sorted) followed, in PREVENTIVE
 * mode, by the Install backlog (Issue 75). Installs carry a null `deviceBucket` (no SLA bucket) and use
 * their backlog target date as the `ageAnchor` that feeds the PREVENTIVE aged-bias term.
 */
interface RunCandidate {
  ticketId: string;
  plantId: bigint;
  companyTier: CompanyTier;
  companyPriorityRank: string;
  deviceBucket: DeviceBucket | null;
  repeatFailure: boolean;
  ageAnchor: Date | null;
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
    // Defaulted so direct construction in tests need not pass them; Nest injects the providers.
    private readonly inventory: InventoryService = new InventoryService(prisma),
    private readonly availability: SeAvailabilityService = new SeAvailabilityService(prisma),
    private readonly softInactive: SoftInactiveCountService = new SoftInactiveCountService(prisma),
  ) {}

  async runForZone(zoneId: bigint, opts: { now?: Date } = {}): Promise<RunSummary> {
    const now = opts.now ?? new Date();
    // Soft Inactive Count drives the deficit/preventive switch (Issue 40, CONTEXT §5). Recorded on the
    // run + each recommendation's breakdown; full preventive-mode scoring re-prioritisation → follow-up.
    const mode = await this.softInactive.modeForZone(zoneId, now);

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

    // TROUBLESHOOT candidates first (canonical order), then — in PREVENTIVE mode only (Issue 75) — the
    // Install backlog (REQUESTED + UNASSIGNED), ordered by installSort. Installs fill remaining SE capacity.
    const tsRun: RunCandidate[] = sorted.map((t) => ({
      ticketId: t.ticketId,
      plantId: t.plantId,
      companyTier: t.companyTier,
      companyPriorityRank: t.companyPriorityRank,
      deviceBucket: t.deviceBucket,
      repeatFailure: t.repeatFailure,
      ageAnchor: t.latestGpsDatetime,
    }));
    const runList: RunCandidate[] = [...tsRun, ...(mode === 'PREVENTIVE' ? await this.installBacklog(zoneId) : [])];

    const { weights, weightSetRef } = await this.activeWeights(mode);
    const clusterMultiplier = await this.plantClusterMultiplier();
    const capacity = await this.engineerCapacity();

    const assigned = new Map<string, number>(); // se_id → tickets assigned this run
    const seededPlants = new Set<string>(); // plant_id → already has a cluster seed this run
    const plannerByPlant = await this.plannerForDate(zoneId, now); // plant_id → planned se_ids (soft bias)
    const kitStatusBySe = new Map<string, CommonKitStatus>(); // memoised Common-Kit status per SE
    const availabilityBySe = new Map<string, SeAvailabilityStatus>(); // memoised current availability per SE

    let recommended = 0;
    let unassignable = 0;

    for (let i = 0; i < runList.length; i++) {
      const t = runList[i];
      const processingRank = i + 1;
      const ordered = await this.candidates.orderedCandidatesForPlant(t.plantId);

      // Common-Kit completeness (Issue 21) + current SE availability (Issue 25) per candidate —
      // memoised across the run. An SE with an active non-AVAILABLE availability window is dropped
      // (SE_UNAVAILABLE). Vehicle readiness remains a seam (Issue 28); the expected-component leg is
      // deferred until `expected_components` lands (Issue 22).
      await Promise.all(ordered.map((c) => this.ensureKitStatus(c.seId, kitStatusBySe)));
      await this.ensureAvailability(ordered.map((c) => c.seId), availabilityBySe, now);

      const readiness: (SeCandidateReadiness & { seId: string })[] = ordered.map((c) => {
        const cap = capacity.get(c.seId);
        const availStatus = availabilityBySe.get(c.seId) ?? 'AVAILABLE';
        return {
          seId: c.seId,
          vehicleReadiness: 'UNKNOWN',
          available: (cap?.isActive ?? true) && availStatus === 'AVAILABLE',
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
            scoreBreakdown: { reason: 'NO_ELIGIBLE_SE', mode, weightSetRef, companyTier: t.companyTier, deviceBucket: t.deviceBucket } as Prisma.InputJsonValue,
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
          // Install candidates have no SLA bucket → zero dispatch urgency (backlog, not an active outage).
          dispatchUrgency: t.deviceBucket ? urgencyFromBucket(t.deviceBucket) : 0,
          repeatFailure: t.repeatFailure,
          // Age drives the PREVENTIVE aged-bias term (weighted 0 in DEFICIT). For installs the anchor is the
          // backlog target date, so older Install backlog ranks higher.
          inactivityHours: t.ageAnchor ? Math.max(0, (now.getTime() - t.ageAnchor.getTime()) / 3_600_000) : null,
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
            mode,
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

    return { recommended, unassignable, mode };
  }

  /** Memoise Common-Kit completeness for an SE within a run (Issue 21). */
  private async ensureKitStatus(seId: string, cache: Map<string, CommonKitStatus>): Promise<void> {
    if (cache.has(seId)) return;
    cache.set(seId, await this.inventory.commonKitStatus(seId));
  }

  /** Memoise current SE availability across a run (Issue 25) — one batched query for the uncached. */
  private async ensureAvailability(seIds: string[], cache: Map<string, SeAvailabilityStatus>, now: Date): Promise<void> {
    const uncached = seIds.filter((id) => !cache.has(id));
    if (uncached.length === 0) return;
    const statuses = await this.availability.currentStatusMany(uncached, now);
    for (const id of uncached) cache.set(id, statuses.get(id) ?? 'AVAILABLE');
  }

  /**
   * The zone's Install backlog as RunCandidates (Issue 75) — open INSTALL tickets not yet acted on
   * (`status = REQUESTED`, `assignment_state = UNASSIGNED`), ordered by `installSort` (tier → rank →
   * oldest backlog). `ageAnchor` is the install target date (or createdAt), so older backlog ranks higher
   * under the PREVENTIVE aged-bias term. The recommender only *suggests* — the ZM override path (Issue 13)
   * remains the human approval/reorder step, so an install is never double-scheduled here.
   */
  private async installBacklog(zoneId: bigint): Promise<RunCandidate[]> {
    const installs = await this.prisma.ticket.findMany({
      where: { workType: 'INSTALL', status: 'REQUESTED', assignmentState: 'UNASSIGNED', plant: { zoneId } },
      include: { company: { select: { companyTier: true, companyPriorityRank: true } } },
    });
    const ordered = installSort(
      installs.map((t) => ({
        ticketId: t.ticketId,
        companyTier: t.company.companyTier,
        companyPriorityRank: t.company.companyPriorityRank,
        backlogAnchor: t.installTargetDate ?? t.createdAt,
      })),
    );
    const byId = new Map(installs.map((t) => [t.ticketId, t]));
    return ordered.map((c) => {
      const t = byId.get(c.ticketId)!;
      return {
        ticketId: t.ticketId,
        plantId: t.plantId,
        companyTier: t.company.companyTier,
        companyPriorityRank: t.company.companyPriorityRank,
        deviceBucket: null,
        repeatFailure: false,
        ageAnchor: c.backlogAnchor,
      };
    });
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

  /**
   * Active weight set for the run's mode → component→weight map + its ref (stamped into each
   * score_breakdown). DEFICIT uses the base active set. PREVENTIVE (Issue 72) uses a configured
   * `<base>_preventive` set if one is active, else a code-default derived from the base: repeat-failure
   * penalty dropped, a repeat-failure **bonus** and a device-age term added (biasing repeat-offenders +
   * aged devices). The base/DEFICIT set is never mutated, so DEFICIT scoring is unchanged.
   */
  private async activeWeights(mode: RecommenderMode): Promise<{ weights: ScoringWeights; weightSetRef: string }> {
    const active = await this.prisma.priorityRuleConfig.findMany({ where: { active: true }, orderBy: { id: 'asc' } });
    const baseRef =
      active.find((r) => r.component === 'company_priority_rank' && !r.weightSetRef.endsWith(PREVENTIVE_SUFFIX))?.weightSetRef ??
      active.find((r) => !r.weightSetRef.endsWith(PREVENTIVE_SUFFIX))?.weightSetRef ??
      DEFAULT_WEIGHT_SET;
    const weightsFor = (ref: string): ScoringWeights => {
      const w: ScoringWeights = {};
      for (const r of active) if (r.weightSetRef === ref) w[r.component] = Number(r.weight);
      return w;
    };

    if (mode !== 'PREVENTIVE') return { weights: weightsFor(baseRef), weightSetRef: baseRef };

    const preventiveRef = `${baseRef}${PREVENTIVE_SUFFIX}`;
    const configured = weightsFor(preventiveRef);
    if (Object.keys(configured).length > 0) return { weights: configured, weightSetRef: preventiveRef };

    const weights: ScoringWeights = {
      ...weightsFor(baseRef),
      repeat_failure_penalty: 0,
      repeat_failure_bonus: PREVENTIVE_REPEAT_BONUS,
      device_age: PREVENTIVE_AGE_WEIGHT,
    };
    return { weights, weightSetRef: preventiveRef };
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
