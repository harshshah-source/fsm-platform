import { Injectable } from '@nestjs/common';
import { istDate } from '../common/ist-day';
import { SeAvailabilityService } from '../engineers/se-availability.service';
import { Prisma } from '../generated/prisma/client';
import { type SeAvailabilityStatus } from '../generated/prisma/enums';
import { type CommonKitStatus, InventoryService } from '../inventory/inventory.service';
import { type ActiveOverride, resolveActiveOverrides, tierOverrideKey } from '../org/effective-tier';
import { PrismaService } from '../prisma/prisma.service';
import { type RecommenderMode, SoftInactiveCountService } from '../reports/soft-inactive-count.service';
import { liveScheduleFilter } from '../scheduling/schedule-status';
import { notDeferredOn } from '../ticketing/deferral';
import { CandidateSelectionService } from './candidate-selection.service';
import { type CandidateTicket, type CompanyTier, type DeviceBucket, canonicalSort, installSort } from './canonical-sort';
import { type SeCandidateReadiness, applyHardFilters } from './hard-filters';
import { type ScoringWeights, scoreCandidate } from './scoring';

const DEFAULT_CLUSTER_MULTIPLIER = 1.25;
const DEFAULT_WEIGHT_SET = 'v1';
/** Bounded trace: at most this many runners-up are recorded per ticket (drop COUNTS cover the rest). */
const TRACE_RUNNERS_UP = 5;
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

/** Why an unassignable ticket's candidate pool ended up empty (transparency trace). */
export type PoolEmptyReason = 'NO_COVERAGE' | 'ALL_DROPPED';

/**
 * Zone-level unassignable reason buckets: NO_COVERAGE (the plant returned zero candidates — an Ops
 * coverage gap) vs ALL_DROPPED (candidates existed; `dropBuckets` counts which hard filters emptied
 * the pool). Feeds the dispatch_run_zones card, aggregated over unassignable tickets only.
 */
export interface UnassignableReasons {
  NO_COVERAGE: number;
  ALL_DROPPED: number;
  dropBuckets: Record<string, number>;
}

export interface RunSummary {
  recommended: number;
  unassignable: number;
  /** The zone's active Recommender mode this run, switched off the Soft Inactive Count (Issue 40). */
  mode: RecommenderMode;
  /** The weight set that actually applied — stamped per-zone on the dispatch-run ledger. */
  weightSetRef: string;
  /** Tickets entering the processing loop (canonical-sorted TROUBLESHOOT + PREVENTIVE installs). */
  ticketsConsidered: number;
  unassignableReasons: UnassignableReasons;
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
  /** Issue 157 AC-4 — the zone-scoped override that produced `companyTier`, when one applied. */
  tierOverrideId: string | null;
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

  async runForZone(zoneId: bigint, opts: { now?: Date; runId?: bigint } = {}): Promise<RunSummary> {
    const now = opts.now ?? new Date();
    // Soft Inactive Count drives the deficit/preventive switch (Issue 40, CONTEXT §5). Recorded on the
    // run + each recommendation's breakdown; full preventive-mode scoring re-prioritisation → follow-up.
    const mode = await this.softInactive.modeForZone(zoneId, now);
    // Issue 157 AC-4 — one batched lookup per run: every ACTIVE, unexpired override in THIS zone,
    // reduced to the newest per company (Q-A newest-wins). Company reads below stay untouched; the
    // override (if any) simply takes precedence over the global companyTier they carry.
    const overrides = await resolveActiveOverrides(this.prisma, [zoneId], now);

    const tickets = await this.prisma.ticket.findMany({
      where: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        assignmentState: 'UNASSIGNED',
        // #146 — a ZM-deferred ticket is UNASSIGNED precisely so it can come back, but not before the
        // date the ZM chose. Without this it would be re-dispatched on the same run that removed it.
        ...notDeferredOn(istDate(now)),
        // Deactivated plants (Issue 119) are skipped by dispatch — no SE is sent to a shut plant.
        plant: { zoneId, deactivations: { none: { reactivatedAt: null } } },
        // Departed devices (Issue 128) likewise — no SE is sent to a device that left the fleet.
        // Defence in depth: the departure pass already cancels these tickets, but this closes the
        // window between a device departing and the next sync, and any ticket raced in after it.
        device: { departures: { none: { restoredAt: null } } },
      },
      include: {
        company: { select: { companyTier: true, companyPriorityRank: true } },
        device: { select: { state: { select: { slaBucket: true, latestGpsDatetime: true } } } },
      },
    });

    // Build the canonical-sort candidate list (skip tickets with no computed bucket — unrankable).
    const rankable = tickets.filter((t) => t.device.state?.slaBucket != null);
    const candidateTickets: (CandidateTicket & {
      plantId: bigint;
      repeatFailure: boolean;
      tierOverrideId: string | null;
    })[] = rankable.map((t) => {
      const override = overrides.get(tierOverrideKey(t.companyId, zoneId));
      return {
        ticketId: t.ticketId,
        companyTier: override?.tier ?? t.company.companyTier,
        deviceBucket: t.device.state!.slaBucket as DeviceBucket,
        companyPriorityRank: t.company.companyPriorityRank,
        latestGpsDatetime: t.device.state!.latestGpsDatetime,
        deviceId: t.deviceId,
        plantId: t.plantId,
        repeatFailure: t.repeatFailure,
        tierOverrideId: override?.overrideId ?? null,
      };
    });
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
      tierOverrideId: t.tierOverrideId,
    }));
    const runList: RunCandidate[] = [
      ...tsRun,
      ...(mode === 'PREVENTIVE' ? await this.installBacklog(zoneId, istDate(now), overrides) : []),
    ];

    const { weights, weightSetRef } = await this.activeWeights(mode);
    const clusterMultiplier = await this.plantClusterMultiplier();
    const capacity = await this.engineerCapacity();

    // NEW-A1 — seed the capacity counter from the SE's ALREADY-committed day plan (other zones this run,
    // and any earlier run today), so `daily_capacity` caps the whole day rather than this zone-run in
    // isolation. Without this a cross-zone floating/multi-plant SE is dispatched up to capacity in every
    // zone the daily loop visits (each `runForZone` started the map at 0). The in-run increments below add
    // this zone's suggestions on top, giving a running whole-day total to check against the cap.
    const assigned = await this.committedDayLoad(istDate(now)); // se_id → tickets on the SE's day plan
    const seededPlants = new Set<string>(); // plant_id → already has a cluster seed this run
    const plannerByPlant = await this.plannerForDate(zoneId, now); // plant_id → planned se_ids (soft bias)
    const kitStatusBySe = new Map<string, CommonKitStatus>(); // memoised Common-Kit status per SE
    const availabilityBySe = new Map<string, SeAvailabilityStatus>(); // memoised current availability per SE

    let recommended = 0;
    let unassignable = 0;
    // Transparency trace (observe-only): collected per ticket, batch-inserted after the loop when a
    // dispatch-run ledger id is supplied. Selection/scoring above and below is untouched.
    const traceRows: Prisma.DispatchDecisionTraceCreateManyInput[] = [];
    const unassignableReasons: UnassignableReasons = { NO_COVERAGE: 0, ALL_DROPPED: 0, dropBuckets: {} };

    // #126 — clear crash-window orphan SUGGESTED recs before (re)suggesting this zone. A live
    // SUGGESTED whose owning dispatch_run is already finalized (or is null / pre-ledger) is a leftover
    // from a rolled-back dispatch that nothing consumed; left in place it collides with the
    // one-SUGGESTED-per-ticket unique below and P2002-wedges the whole zone every run. Deleting it lets
    // this run re-evaluate the ticket fresh — a stale decision (prior availability/capacity) is never
    // consumed. Recs owned by a still-RUNNING run (a concurrent live dispatch) are deliberately left
    // alone; the per-create guard below skips those tickets instead. Trace rows cascade on delete.
    await this.clearFinalizedOrphans(zoneId);

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

      // Per-filter drop COUNTS across the whole pool — the trace never stores dropped rows verbatim.
      const dropCounts: Record<string, number> = {};
      for (const d of filtered.dropped) dropCounts[d.reason] = (dropCounts[d.reason] ?? 0) + 1;
      const dropReasonBySe = new Map(filtered.dropped.map((d) => [d.candidate.seId, d.reason]));
      const passedSet = new Set(passed.map((c) => c.seId));

      if (chosen === null) {
        const rec = await this.prisma.recommendation.create({
          data: {
            ticketId: t.ticketId,
            seId: null,
            companyTier: t.companyTier,
            deviceBucket: t.deviceBucket,
            scoreBreakdown: {
              reason: 'NO_ELIGIBLE_SE',
              mode,
              weightSetRef,
              companyTier: t.companyTier,
              deviceBucket: t.deviceBucket,
              tierOverrideId: t.tierOverrideId,
            } as Prisma.InputJsonValue,
            processingRank,
            status: 'UNASSIGNABLE',
            path: 'MORNING_BATCH',
            runId: opts.runId ?? null,
          },
        });
        // Coverage gap vs capacity/filter problem — first-class in the trace and the zone rollup.
        const poolEmptyReason: PoolEmptyReason = ordered.length === 0 ? 'NO_COVERAGE' : 'ALL_DROPPED';
        unassignableReasons[poolEmptyReason]++;
        for (const [reason, n] of Object.entries(dropCounts))
          unassignableReasons.dropBuckets[reason] = (unassignableReasons.dropBuckets[reason] ?? 0) + n;
        if (opts.runId !== undefined) {
          traceRows.push({
            runId: opts.runId,
            recommendationId: rec.recommendationId,
            ticketId: t.ticketId,
            zoneId,
            seId: null,
            trace: {
              candidatesTotal: ordered.length,
              passedCount: 0,
              dropCounts,
              chosen: null,
              runnersUp: ordered.slice(0, TRACE_RUNNERS_UP).map((c, idx) => ({
                seId: c.seId,
                coverageType: c.coverageType,
                precedenceRank: idx + 1,
                verdict: 'DROPPED',
                dropReason: dropReasonBySe.get(c.seId) ?? null,
                plannerPlanned: planned?.has(c.seId) ?? false,
                score: null,
              })),
              scoreDegenerate: true,
              poolEmptyReason,
            } as Prisma.InputJsonValue,
          });
        }
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
      const features = {
        companyPriorityRank: t.companyPriorityRank,
        // Install candidates have no SLA bucket → zero dispatch urgency (backlog, not an active outage).
        dispatchUrgency: t.deviceBucket ? urgencyFromBucket(t.deviceBucket) : 0,
        repeatFailure: t.repeatFailure,
        // Age drives the PREVENTIVE aged-bias term (weighted 0 in DEFICIT). For installs the anchor is the
        // backlog target date, so older Install backlog ranks higher.
        inactivityHours: t.ageAnchor ? Math.max(0, (now.getTime() - t.ageAnchor.getTime()) / 3_600_000) : null,
        distanceFromPrevStopKm: null, // Floating distance-from-previous-stop deferred (needs day-plan geo)
      };
      const scored = scoreCandidate(features, weights, multiplier);

      // #126 — guard-not-throw. Stale orphans from finalized/aborted runs were cleared before the
      // loop, so a one-SUGGESTED-per-ticket collision surviving to here can only be a concurrent,
      // still-RUNNING dispatch run that already holds a live SUGGESTED for this ticket. That run owns
      // it → skip rather than throw and wedge the whole zone. Capacity is credited only on success.
      let recommendationId: bigint;
      try {
        const created = await this.prisma.recommendation.create({
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
              tierOverrideId: t.tierOverrideId,
            } as Prisma.InputJsonValue,
            processingRank,
            status: 'SUGGESTED',
            path: 'MORNING_BATCH',
            runId: opts.runId ?? null,
          },
        });
        recommendationId = created.recommendationId;
      } catch (e) {
        if ((e as { code?: string }).code === 'P2002') continue;
        throw e;
      }

      assigned.set(chosen.seId, (assigned.get(chosen.seId) ?? 0) + 1);
      recommended++;

      if (opts.runId !== undefined) {
        // Distance-from-previous-stop is the only per-SE score component and is deferred-null, so all
        // of a ticket's candidates score identically — precedence decides, and the trace says so.
        const scoreDegenerate = features.distanceFromPrevStopKm === null || (weights['distance'] ?? 0) === 0;
        const chosenRank = ordered.findIndex((c) => c.seId === chosen.seId) + 1;
        const plannerPlanned = planned?.has(chosen.seId) ?? false;
        traceRows.push({
          runId: opts.runId,
          recommendationId,
          ticketId: t.ticketId,
          zoneId,
          seId: chosen.seId,
          trace: {
            candidatesTotal: ordered.length,
            passedCount: passed.length,
            dropCounts,
            chosen: {
              seId: chosen.seId,
              coverageType,
              precedenceRank: chosenRank,
              plannerPlanned,
              // True only when the SE Planner soft bias actually changed the pick (ADR-0022).
              plannerBias: plannerPlanned && passed[0]?.seId !== chosen.seId,
              capacityAtDecision: {
                used: assigned.get(chosen.seId) ?? 1,
                cap: capacity.get(chosen.seId)?.dailyCapacity ?? null,
              },
              clusterSeed: isSeed,
            },
            runnersUp: ordered
              .filter((c) => c.seId !== chosen.seId)
              .slice(0, TRACE_RUNNERS_UP)
              .map((c) => ({
                seId: c.seId,
                coverageType: c.coverageType,
                precedenceRank: ordered.findIndex((o) => o.seId === c.seId) + 1,
                verdict: passedSet.has(c.seId) ? 'PASSED' : 'DROPPED',
                dropReason: dropReasonBySe.get(c.seId) ?? null,
                plannerPlanned: planned?.has(c.seId) ?? false,
                // PASSED runners-up are scored purely for the trace (pure function, observe-only);
                // identical to the winner's score while `scoreDegenerate` holds.
                // TODO: when distance scoring lands (weights.distance > 0 && distanceFromPrevStopKm !== null),
                // scoreCandidate MUST receive per-candidate features, not the ticket's features. Otherwise
                // scoreDegenerate flips off and runner-up scores become misleadingly equal to the winner's —
                // the trace becomes an actively wrong 'why this SE' explanation. Reference: transparency
                // audit 2026-07-15, note 1.
                score: passedSet.has(c.seId) ? scoreCandidate(features, weights, multiplier).score : null,
              })),
            scoreDegenerate,
            poolEmptyReason: null,
          } as Prisma.InputJsonValue,
        });
      }
    }

    if (opts.runId !== undefined && traceRows.length > 0) {
      await this.prisma.dispatchDecisionTrace.createMany({ data: traceRows });
    }

    return {
      recommended,
      unassignable,
      mode,
      weightSetRef,
      ticketsConsidered: runList.length,
      unassignableReasons,
    };
  }

  /**
   * #126 — delete crash-window orphan SUGGESTED recs for a zone before (re)suggesting. A live
   * SUGGESTED whose owning `dispatch_run` is already finalized (or whose `run_id` is null / pre-ledger)
   * is a leftover from a rolled-back or never-consumed dispatch; clearing it lets this run re-evaluate
   * fresh and frees the one-SUGGESTED-per-ticket unique so the zone can never wedge. Recs owned by a
   * still-RUNNING run (a concurrent live dispatch) are left untouched — the per-create guard skips
   * those tickets instead. `dispatch_decision_traces` rows cascade on delete. Returns the count cleared.
   */
  private async clearFinalizedOrphans(zoneId: bigint): Promise<number> {
    const { count } = await this.prisma.recommendation.deleteMany({
      where: {
        status: 'SUGGESTED',
        ticket: { plant: { zoneId } },
        OR: [{ runId: null }, { run: { status: { not: 'RUNNING' } } }],
      },
    });
    return count;
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
  private async installBacklog(
    zoneId: bigint,
    day: Date,
    overrides: Map<string, ActiveOverride>,
  ): Promise<RunCandidate[]> {
    const installs = await this.prisma.ticket.findMany({
      where: {
        workType: 'INSTALL',
        status: 'REQUESTED',
        assignmentState: 'UNASSIGNED',
        // #146 — an INSTALL can sit in a batch and be deferred like any other ticket, so the same
        // date gate applies here. Deferrals are rare on this path; the predicate is not.
        ...notDeferredOn(day),
        plant: { zoneId, deactivations: { none: { reactivatedAt: null } } },
        // NOTE: deliberately NOT filtered on device departure (Issue 128), unlike the Troubleshoot
        // selection above. An Install exists to bring a device INTO the fleet, so "not currently
        // deployed at source" is its normal starting state — excluding it would block exactly the
        // work that makes the device deployed.
      },
      include: { company: { select: { companyTier: true, companyPriorityRank: true } } },
    });
    // Issue 157 AC-4 — the same zone-scoped override applies to the Install backlog: it reads the
    // same live company join as the TROUBLESHOOT path above (the issue's evidence section flags
    // both as the "two copies" tier is consumed from), so it must resolve the same way.
    const effectiveTier = (t: (typeof installs)[number]) =>
      overrides.get(tierOverrideKey(t.companyId, zoneId))?.tier ?? t.company.companyTier;
    const tierOverrideId = (t: (typeof installs)[number]) =>
      overrides.get(tierOverrideKey(t.companyId, zoneId))?.overrideId ?? null;

    const ordered = installSort(
      installs.map((t) => ({
        ticketId: t.ticketId,
        companyTier: effectiveTier(t),
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
        companyTier: effectiveTier(t),
        companyPriorityRank: t.company.companyPriorityRank,
        deviceBucket: null,
        repeatFailure: false,
        ageAnchor: c.backlogAnchor,
        tierOverrideId: tierOverrideId(t),
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

  /**
   * NEW-A1 — an SE's already-committed workload for `day`, counted as active batch stops across ALL their
   * live work schedules covering that date (every zone, every prior run today, plus intraday inserts —
   * all of which land as day-plan stops). This is the same "used" unit the transparency ledger displays
   * (`capacityUsed.used` = the SE's non-removed batch tickets), so enforcement and display agree. It is
   * read once at run start and used to seed the per-run `assigned` counter; the current zone's own
   * suggestions are not yet dispatched (they add via the in-run increment), so there is no double count.
   *
   * #153 — "live" includes OVERRIDDEN. A ZM adjusting a day plan does not un-commit the work still on
   * it; counting only ACTIVE zeroed the SE's load and let the next run hand them a whole second day.
   */
  private async committedDayLoad(day: Date): Promise<Map<string, number>> {
    const rows = await this.prisma.batchAssignmentTicket.findMany({
      where: {
        removedAt: null,
        batch: { schedule: { ...liveScheduleFilter(), dateFrom: { lte: day }, dateTo: { gte: day } } },
      },
      select: { batch: { select: { seId: true } } },
    });
    const load = new Map<string, number>();
    for (const r of rows) load.set(r.batch.seId, (load.get(r.batch.seId) ?? 0) + 1);
    return load;
  }
}

