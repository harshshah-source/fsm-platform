import { Injectable } from '@nestjs/common';
import { istDate } from '../common/ist-day';
import { SeAvailabilityService } from '../engineers/se-availability.service';
import { Prisma } from '../generated/prisma/client';
import { type SeAvailabilityStatus } from '../generated/prisma/enums';
import { type CommonKitStatus, InventoryService } from '../inventory/inventory.service';
import { type ActiveOverride, resolveActiveOverrides, tierOverrideKey } from '../org/effective-tier';
import { PrismaService } from '../prisma/prisma.service';
import { type RecommenderMode, SoftInactiveCountService } from '../reports/soft-inactive-count.service';
import { readAssignmentThresholdHours } from '../settings/assignment-threshold';
import {
  type CommittedDayEntry,
  committedDayLoad,
  committedDayPlan,
} from '../scheduling/committed-day-load';
import { notDeferredOn, returnDateArrivedBefore } from '../ticketing/deferral';
import { componentBlockedTickets, notComponentBlocked } from '../ticketing/component-blocked';
import { CandidateSelectionService, type CoverageType } from './candidate-selection.service';
import {
  type CandidateTicket,
  type CompanyTier,
  type DeviceBucket,
  canonicalSort,
  installSort,
  urgencyFromBucket,
} from './canonical-sort';
import { buildCandidateReadiness } from './candidate-readiness';
import { type SeCandidateReadiness, applyHardFilters } from './hard-filters';
import { type ScoringWeights, scoreCandidate } from './scoring';
import { chooseWithinTier } from './tier-score-chooser';
import {
  PREVENTIVE_SUFFIX,
  readBaseActiveWeights,
  readEngineerCapacity,
  readPlantClusterMultiplier,
} from './scoring-config';

/** Bounded trace: at most this many runners-up are recorded per ticket (drop COUNTS cover the rest). */
const TRACE_RUNNERS_UP = 5;
// PREVENTIVE-mode code defaults (Issue 72), used when no `<ref>_preventive` set is configured in
// `priority_rule_config`. Repeat-failure flips from penalty to bonus and aged devices add — biasing the
// planner toward repeat-offenders and aged devices (CONTEXT §5). Tunable via the DB set.
const PREVENTIVE_REPEAT_BONUS = 0.5;
const PREVENTIVE_AGE_WEIGHT = 0.5;

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
  /** #238 — the SE-assignment threshold in force for this run (hours), stamped for explainability. */
  assignmentThresholdHours: number;
  /**
   * #238 — open, unassigned Troubleshoot tickets in this zone whose device has not yet been silent
   * long enough to dispatch. Counted separately from `unassignable` on purpose: an unassignable
   * ticket is a **coverage or capacity failure** somebody must act on, whereas a withheld ticket is
   * the configured policy working as intended and needs no action at all. Folding the two together
   * would make every threshold increase look like a fleet-wide dispatch outage on the run ledger.
   */
  withheldBelowThreshold: number;
  /**
   * #242 — open, unassigned tickets this run dropped **before deciding anything**, because their device
   * carried no computed `sla_bucket` for the canonical sort to rank on (a state row with a NULL bucket,
   * or no state row at all).
   *
   * These tickets have always fallen out silently: no recommendation, no UNASSIGNABLE row, no decision
   * trace — on the run report they did not exist. Recycling (#242) makes that grow rather than sit
   * still, because an unworked ticket now returns to `UNASSIGNED` every night, so one with an
   * un-recomputed device state cycles back into the gap indefinitely. Reported separately from both
   * `unassignable` (the engine looked and found nobody — Ops) and `withheldBelowThreshold` (it
   * deliberately did not look yet — policy): this one means it *could not* look, which is a data fault.
   */
  bucketlessDropped: number;
  /**
   * #177 — open, unassigned tickets this zone is holding back because their failure cycle is
   * `WAITING_COMPONENT`: the part is on order, the SLA is paused, and the ticket is still OPEN by
   * design (ADR-0008). Dispatching one costs a capacity slot, a wasted visit, and a second live
   * `component_request` when the SE resubmits on site.
   *
   * The third member of the same family as the two figures above, and separate for the same reason.
   * `unassignable` is an Ops problem (the engine looked and found nobody); `withheldBelowThreshold`
   * is nobody's problem (policy working as intended); this one is the warehouse's — the work is
   * real, it is waiting on a part, and no amount of coverage will move it. Folding it into the first
   * would make a supplier delay read as a fleet-wide dispatch outage.
   */
  componentBlockedWithheld: number;
  /**
   * #250 — populated **only** on a dry run. The real path leaves it undefined, so its type and every
   * existing caller are untouched.
   */
  projection?: ZoneProjection;
}

/**
 * One ticket's decision as the run reached it (#250) — the same substance the run would have written
 * to `recommendations` + `dispatch_decision_traces`, carried in memory instead. Deliberately mirrors
 * the persisted trace shape rather than inventing a preview-only vocabulary: #251 renders "why this
 * SE" from this, and two different explanations of the same decision is exactly the drift the
 * "project the real recommender" decision exists to prevent.
 */
export interface PreviewDecision {
  ticketId: string;
  plantId: string;
  processingRank: number;
  companyTier: CompanyTier;
  deviceBucket: DeviceBucket | null;
  tierOverrideId: string | null;
  /** null ⟺ unassignable; `poolEmptyReason` then says which kind. */
  seId: string | null;
  coverageType: string | null;
  score: number | null;
  candidatesTotal: number;
  passedCount: number;
  dropCounts: Record<string, number>;
  poolEmptyReason: PoolEmptyReason | null;
  /** True only when the SE Planner soft bias actually changed the pick (ADR-0022). */
  plannerBias: boolean;
  /**
   * #266 Q-A — true when the winner is going to this plant for the FIRST time today, so no cluster
   * multiplier applied. Per candidate since Q-A; it used to be run-level ("is this the first ticket at
   * this plant this run", whoever it went to), which recorded a fallback SE as a cluster follow-on for
   * a plant they had never visited.
   */
  clusterSeed: boolean;
  capacityAtDecision: { used: number; cap: number | null } | null;
}

/** The projected day plan: SE → plant stop → tickets, in the order the run decided them. */
export interface PreviewPlanStop {
  plantId: string;
  ticketIds: string[];
}
export interface PreviewPlanEntry {
  seId: string;
  plants: PreviewPlanStop[];
}

export interface ZoneProjection {
  zoneId: string;
  /** The IST calendar day the projection is *for*, `YYYY-MM-DD`. */
  targetDate: string;
  /**
   * How current the ranking inputs are — the newest `device_states.computed_at` among the devices
   * this run actually ranked, or null when nothing was ranked.
   *
   * This is the projection's honest limit and #251 must display it. `slaBucket` and `inactivityHours`
   * are **materialised** as of the last recompute; no as-of-date variant exists and none is being
   * built. So a D+1 preview moves the deferral/planner/capacity/availability reads to tomorrow but
   * still ranks on today's buckets. A preview that hid this would look authoritative about an
   * ordering it cannot know.
   */
  bucketsAsOf: string | null;
  /**
   * The run-level tallies, carried on the projection rather than left on `RunSummary` (#251).
   *
   * `previewActiveZones` returns projections, not summaries, so without these the preview would have
   * to re-derive the figures client-side — and two of them cannot be re-derived at all:
   * `withheldBelowThreshold` is a separate count with no per-ticket decision behind it (that is the
   * point of #238's distinction — withheld means the engine deliberately did not look), and `mode`
   * decides whether the Install backlog appears at all. The staleness token signs these numbers, so
   * "has the world moved" is defined in exactly the terms the operator was shown.
   */
  mode: RecommenderMode;
  recommended: number;
  unassignable: number;
  withheldBelowThreshold: number;
  /** #177 — held back for a part on order, not for coverage and not for policy. */
  componentBlockedWithheld: number;
  /** Why the unassignable ones were unassignable — coverage gap vs filters emptying the pool. */
  unassignableReasons: UnassignableReasons;
  decisions: PreviewDecision[];
  plan: PreviewPlanEntry[];
}

/**
 * Group decided tickets into the projected day plan (#250).
 *
 * Mirrors what `BatchAssignmentService.dispatchForZone` would build — SE, then a plant stop per
 * distinct plant, tickets in decision order — but derives it from the decisions rather than calling
 * the dispatcher, because the dispatcher is transactional and consumes recommendation rows a dry run
 * deliberately never wrote. Insertion order is preserved throughout, so the projected stop order
 * matches the processing order the real run would have dispatched in.
 */
function buildPreviewPlan(decisions: PreviewDecision[]): PreviewPlanEntry[] {
  const bySe = new Map<string, Map<string, string[]>>();
  for (const d of decisions) {
    if (d.seId === null) continue;
    const plants = bySe.get(d.seId) ?? new Map<string, string[]>();
    const tickets = plants.get(d.plantId) ?? [];
    tickets.push(d.ticketId);
    plants.set(d.plantId, tickets);
    bySe.set(d.seId, plants);
  }
  return [...bySe].map(([seId, plants]) => ({
    seId,
    plants: [...plants].map(([plantId, ticketIds]) => ({ plantId, ticketIds })),
  }));
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

  async runForZone(
    zoneId: bigint,
    opts: { now?: Date; runId?: bigint; dryRun?: boolean; targetDate?: Date } = {},
  ): Promise<RunSummary> {
    const now = opts.now ?? new Date();
    // #250 — the preview seam. `dryRun` suppresses every write and returns the projection instead;
    // `targetDate` moves the date-bound reads onto another IST day. Both default off/today, so the
    // real path below is bit-identical to before (pinned by the today-parity test).
    const dryRun = opts.dryRun === true;
    const today = istDate(now);
    const targetDay = opts.targetDate ? istDate(opts.targetDate) : today;
    /**
     * The instant at which "is this window active right now" predicates are evaluated for the target
     * day: the same time-of-day as `now`, shifted onto the target IST day.
     *
     * For a preview of **today** this is exactly `now`, which is what makes the today-parity
     * guarantee hold *by construction* rather than by coincidence — the alternative (probing at the
     * target day's midnight) would silently disagree with the real run for every availability window
     * that opens during the working day. For D+1 it reads as "this time tomorrow".
     */
    const asOf = new Date(now.getTime() + (targetDay.getTime() - today.getTime()));

    // Soft Inactive Count drives the deficit/preventive switch (Issue 40, CONTEXT §5). Recorded on the
    // run + each recommendation's breakdown; full preventive-mode scoring re-prioritisation → follow-up.
    //
    // Threaded with `asOf` for intent, but note honestly: `modeForZone` ignores its date argument
    // (`soft-inactive-count.service.ts:74` — the parameter is `_now`), because the count is read from
    // materialised `device_states`. The mode is therefore as-of-last-recompute for exactly the same
    // reason the buckets are, and `bucketsAsOf` is the caveat that covers both.
    const mode = await this.softInactive.modeForZone(zoneId, asOf);
    // Issue 157 AC-4 — one batched lookup per run: every ACTIVE, unexpired override in THIS zone,
    // reduced to the newest per company (Q-A newest-wins). Company reads below stay untouched; the
    // override (if any) simply takes precedence over the global companyTier they carry.
    const overrides = await resolveActiveOverrides(this.prisma, [zoneId], asOf);
    // #238 — read per run, never cached, exactly like every other engine setting: an operator's edit
    // takes effect on the next dispatch with no restart (audit V10, `ticket-and-assignment-review`).
    const assignmentThresholdHours = await readAssignmentThresholdHours(this.prisma);

    const ticketWhere = {
      workType: 'TROUBLESHOOT',
      status: 'OPEN',
      assignmentState: 'UNASSIGNED',
      // #177 — a ticket whose failure cycle is WAITING_COMPONENT is OPEN by design (the failure is
      // real and the part is on order), so `status` alone has never said whether it can be worked.
      // Dispatching one hands the SE a job they cannot finish and, because the submit gate is also
      // just `status === 'OPEN'`, earns a second live `component_request` when they resubmit on site.
      // Excluded here in the shared `ticketWhere` so the withheld count below inherits it: a ticket
      // that is both blocked and below the age threshold belongs to the blocked figure, and counting
      // it in both would make the two columns sum past the pool they partition.
      //
      // Nested under `AND` rather than spread flat, and that is load-bearing: this predicate and
      // `notDeferredOn` both express themselves as a top-level `OR`, so spreading the two into one
      // object silently keeps only the last — measured, not feared. It cost one confusing red run
      // where the exclusion appeared to do nothing at all.
      AND: [notComponentBlocked()],
    } satisfies Prisma.TicketWhereInput;

    const tickets = await this.prisma.ticket.findMany({
      where: {
        ...ticketWhere,
        // #146 — a ZM-deferred ticket is UNASSIGNED precisely so it can come back, but not before the
        // date the ZM chose. Without this it would be re-dispatched on the same run that removed it.
        ...notDeferredOn(targetDay),
        // Deactivated plants (Issue 119) are skipped by dispatch — no SE is sent to a shut plant.
        plant: { zoneId, deactivations: { none: { reactivatedAt: null } } },
        device: {
          // Departed devices (Issue 128) — no SE is sent to a device that left the fleet. Defence in
          // depth: the departure pass already cancels these tickets, but this closes the window
          // between a device departing and the next sync, and any ticket raced in after it.
          departures: { none: { restoredAt: null } },
          // #238 — the dispatch-side gate. Ticket creation already applies the same threshold, so on a
          // steady configuration this is redundant; it is here for the case that is neither steady nor
          // rare — an operator RAISING the threshold. Tickets opened under the old, lower value are
          // already sitting OPEN/UNASSIGNED, and without this they would keep being dispatched at the
          // very moment the operator declared they should not be. The gate makes the new policy apply
          // to the existing backlog on the next run, which is what "changed the threshold" has to mean.
          // Lowering it needs no equivalent: creation opens the newly-qualifying tickets itself.
          //
          // The gate withholds only on POSITIVE evidence that a device is below the threshold — the
          // opposite burden of proof to ticket creation's (`gte` excludes NULL, so creation needs
          // positive evidence to OPEN work). The asymmetry is deliberate: the two answer different
          // questions and each has to fail safe in a different direction. An unmeasurable device must
          // not manufacture work; an already-open ticket must not be withheld from dispatch forever on
          // the strength of a figure nobody can compute.
          //
          // Spelled out as an explicit OR rather than the more natural
          // `NOT: { state: { is: { inactivityHours: { lt: n } } } }`, which is WRONG here and was
          // measured to be: Prisma renders the negated to-one relation filter such that a state row
          // with a NULL `inactivity_hours` matches neither the filter nor its negation, so every
          // NULL-houred device is silently dropped instead of passing. The three branches below say
          // what is meant — measurably at or past the threshold, measurably unknown, or no state row
          // at all — and each was verified against the database rather than reasoned about.
          OR: [
            { state: { inactivityHours: { gte: assignmentThresholdHours } } },
            { state: { inactivityHours: null } },
            { state: { is: null } },
          ],
        },
      },
      include: {
        company: { select: { companyTier: true, companyPriorityRank: true } },
        // `computedAt` rides along for the projection's `bucketsAsOf` watermark (#250) — the
        // ranking inputs' staleness, taken from the very rows that were ranked, at no extra query.
        device: { select: { state: { select: { slaBucket: true, latestGpsDatetime: true, computedAt: true } } } },
      },
    });

    // #238 — how many dispatchable-but-for-the-threshold tickets this zone is holding. Same predicate
    // as the read above with the age gate inverted, so the two cannot drift apart; counted rather than
    // fetched because nothing downstream needs the rows, only the figure the run ledger reports.
    const withheldBelowThreshold = await this.prisma.ticket.count({
      where: {
        ...ticketWhere,
        ...notDeferredOn(targetDay),
        plant: { zoneId, deactivations: { none: { reactivatedAt: null } } },
        device: {
          departures: { none: { restoredAt: null } },
          state: { inactivityHours: { lt: assignmentThresholdHours } },
        },
      },
    });

    // #177 — what the cycle exclusion above just held back. Counted rather than fetched (nothing
    // downstream needs the rows) and counted from the SAME clauses as the read with only the cycle
    // predicate flipped, so the two cannot drift into disagreeing about which tickets were in scope.
    //
    // Deliberately NOT `ticketWhere` spread with an override: `ticketWhere` now carries the exclusion
    // itself, so reusing it here would count the tickets that survived it. The zone/plant/device
    // guards are repeated instead, which is the same shape `withheldBelowThreshold` already uses.
    const componentBlockedWithheld = await this.prisma.ticket.count({
      where: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        assignmentState: 'UNASSIGNED',
        ...notDeferredOn(targetDay),
        plant: { zoneId, deactivations: { none: { reactivatedAt: null } } },
        device: { departures: { none: { restoredAt: null } } },
        AND: [componentBlockedTickets()],
      },
    });

    // Build the canonical-sort candidate list (skip tickets with no computed bucket — unrankable).
    const rankable = tickets.filter((t) => t.device.state?.slaBucket != null);
    // #242 — how many the line above just dropped. Until this figure existed the drop was invisible on
    // every surface: these tickets get no recommendation, no UNASSIGNABLE row and no trace, so a run
    // report showed no trace of them at all. Recycling grows this population's exposure, so it is
    // counted at the point of loss rather than reconstructed later from the tickets that survived.
    const bucketlessDropped = tickets.length - rankable.length;
    // #250 — the projection's staleness watermark, taken from the rows that were actually ranked, so
    // it costs nothing and describes precisely the inputs the ordering came from.
    const bucketsAsOf = rankable.reduce<Date | null>((max, t) => {
      const at = t.device.state!.computedAt;
      return max === null || at > max ? at : max;
    }, null);
    // #248 — Option C's input, read once for the whole run. `returnDueToday` is derived, never stored:
    // it is a pure function of one column and the run's day, and a stored flag would need writing on
    // filing, rewriting on a manager's date change, and clearing on dispatch or supersession — four
    // writers for one derived fact, any of which going missing leaves a ticket jumping the queue for
    // good. Evaluated against `asOf` rather than `now` so a D+1 preview (#250) asks the same question
    // about the day it is previewing, exactly as `notDeferredOn(targetDay)` does above.
    const returnDue = await this.returnDueTickets(rankable.map((t) => t.ticketId), asOf);
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
        returnDueToday: returnDue.has(t.ticketId),
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
      ...(mode === 'PREVENTIVE' ? await this.installBacklog(zoneId, targetDay, overrides) : []),
    ];

    const { weights, weightSetRef } = await this.activeWeights(mode);
    const clusterMultiplier = await this.plantClusterMultiplier();
    const capacity = await this.engineerCapacity();

    // NEW-A1 — seed the capacity counter from the SE's ALREADY-committed day plan (other zones this run,
    // and any earlier run today), so `daily_capacity` caps the whole day rather than this zone-run in
    // isolation. Without this a cross-zone floating/multi-plant SE is dispatched up to capacity in every
    // zone the daily loop visits (each `runForZone` started the map at 0). The in-run increments below add
    // this zone's suggestions on top, giving a running whole-day total to check against the cap.
    // #266 Q-A — one read, both figures: the capacity counter AND each SE's set of plants for the day.
    // Clustering is seeded from exactly the rows capacity is seeded from, then grown by in-run wins in
    // the same place the counter is incremented, so "how much is this engineer carrying" and "where are
    // they already going" can never drift apart.
    const committed = await this.committedDayPlan(targetDay);
    const assigned = new Map<string, number>(); // se_id → tickets on the SE's day plan
    const plantsBySe = new Map<string, Set<string>>(); // se_id → plants already on that day plan
    for (const [seId, entry] of committed) {
      assigned.set(seId, entry.count);
      plantsBySe.set(seId, entry.plants);
    }
    const plannerByPlant = await this.plannerForDate(zoneId, targetDay); // plant_id → planned se_ids (soft bias)
    const kitStatusBySe = new Map<string, CommonKitStatus>(); // memoised Common-Kit status per SE
    const availabilityBySe = new Map<string, SeAvailabilityStatus>(); // memoised current availability per SE

    /**
     * The ticket's scoring features — one definition, used both to score every candidate in the
     * winning tier and to persist the winner's breakdown, so the number that selected an SE and the
     * number stored to explain that selection are the same computation rather than two derivations.
     *
     * Every field comes from the TICKET, which is the structural fact behind #258 Q-A: candidates for
     * one ticket share an identical `baseScore`, so without a per-candidate term the score cannot
     * order them at all. `distanceFromPrevStopKm` is the other per-candidate term and stays null until
     * #267 gives it real geometry.
     */
    const featuresFor = (c: RunCandidate) => ({
      companyPriorityRank: c.companyPriorityRank,
      // Install candidates have no SLA bucket → zero dispatch urgency (backlog, not an active outage).
      dispatchUrgency: c.deviceBucket ? urgencyFromBucket(c.deviceBucket) : 0,
      repeatFailure: c.repeatFailure,
      // Age drives the PREVENTIVE aged-bias term (weighted 0 in DEFICIT). For installs the anchor is the
      // backlog target date, so older Install backlog ranks higher.
      inactivityHours: c.ageAnchor ? Math.max(0, (now.getTime() - c.ageAnchor.getTime()) / 3_600_000) : null,
      distanceFromPrevStopKm: null, // Floating distance-from-previous-stop deferred (needs day-plan geo)
    });

    let recommended = 0;
    let unassignable = 0;
    // Transparency trace (observe-only): collected per ticket, batch-inserted after the loop when a
    // dispatch-run ledger id is supplied. Selection/scoring above and below is untouched.
    const traceRows: Prisma.DispatchDecisionTraceCreateManyInput[] = [];
    const unassignableReasons: UnassignableReasons = { NO_COVERAGE: 0, ALL_DROPPED: 0, dropBuckets: {} };
    // #250 — the dry run's output. Accumulated on every path (cheap: one object per ticket) and
    // returned only when `dryRun`, so the real run pays a negligible cost and its result shape is
    // unchanged. Collected here rather than reconstructed afterwards because several inputs
    // (drop counts, the capacity counter at the moment of decision) exist only inside the loop.
    const decisions: PreviewDecision[] = [];

    // #126 — clear crash-window orphan SUGGESTED recs before (re)suggesting this zone. A live
    // SUGGESTED whose owning dispatch_run is already finalized (or is null / pre-ledger) is a leftover
    // from a rolled-back dispatch that nothing consumed; left in place it collides with the
    // one-SUGGESTED-per-ticket unique below and P2002-wedges the whole zone every run. Deleting it lets
    // this run re-evaluate the ticket fresh — a stale decision (prior availability/capacity) is never
    // consumed. Recs owned by a still-RUNNING run (a concurrent live dispatch) are deliberately left
    // alone; the per-create guard below skips those tickets instead. Trace rows cascade on delete.
    // #250 — suppressed on a dry run, and this is the mutation that most needs it: the delete is
    // ZONE-WIDE, so a preview that ran it would silently destroy a concurrent live run's SUGGESTED
    // rows. Skipping it is also why a dry run cannot hit the P2002 path below — it never creates.
    if (!dryRun) await this.clearFinalizedOrphans(zoneId);

    for (let i = 0; i < runList.length; i++) {
      const t = runList[i];
      const processingRank = i + 1;
      const ordered = await this.candidates.orderedCandidatesForPlant(t.plantId);

      // Common-Kit completeness (Issue 21) + current SE availability (Issue 25) per candidate —
      // memoised across the run. An SE with an active non-AVAILABLE availability window is dropped
      // (SE_UNAVAILABLE). Vehicle readiness remains a seam (Issue 28); the expected-component leg is
      // deferred until `expected_components` lands (Issue 22).
      await Promise.all(ordered.map((c) => this.ensureKitStatus(c.seId, kitStatusBySe)));
      await this.ensureAvailability(ordered.map((c) => c.seId), availabilityBySe, asOf);

      // #266 — the tier rides along with each candidate's readiness so `applyHardFilters` (generic over
      // this shape) hands it back on `passed`, and the winning-tier grouping needs no second lookup.
      //
      // #274 — the rule itself now lives in `buildCandidateReadiness`, because the Assign Console's
      // candidate column asks this identical question of these identical facts and its whole value is
      // that its answer is *this* answer. Sharing `applyHardFilters` alone was never sufficient: that
      // function takes readiness as given, so two callers could feed it two different readings of one
      // engineer and still agree perfectly on the rule. The only difference between the two callers is
      // the counter — a live run passes its in-run `assigned` tally, a read passes #269's
      // `committedDayLoad`, and NEW-A1 seeds the first from the second so they start equal.
      const readiness: (SeCandidateReadiness & { seId: string; coverageType: CoverageType })[] = ordered.map((c) =>
        buildCandidateReadiness({
          seId: c.seId,
          coverageType: c.coverageType,
          availabilityStatus: availabilityBySe.get(c.seId) ?? 'AVAILABLE',
          committed: assigned.get(c.seId) ?? 0,
          capacity: capacity.get(c.seId),
          commonKitComplete: kitStatusBySe.get(c.seId)?.complete ?? true,
        }),
      );
      // SE Planner soft bias (ADR-0022): among eligible candidates, prefer the planner-named SE for
      // this plant/date; otherwise keep strict precedence (passed[0]). Activity-ping staleness is NOT
      // a filter — `last_activity_at` never gates scoring (CONTEXT §3/§16).
      const filtered = applyHardFilters(readiness);
      const passed = filtered.passed;
      const planned = plannerByPlant.get(String(t.plantId));
      const ticketPlant = String(t.plantId);

      // #266 Q-A — the multiplier is per candidate, and means what its name says: does THIS engineer
      // already go to this plant today? (The old test asked whether ANY SE had been seeded at the
      // plant this run — one value applied to every candidate, so it cancelled out of every comparison
      // and could decide nothing.)
      const clusterFor = (seId: string): number =>
        plantsBySe.get(seId)?.has(ticketPlant) ? clusterMultiplier : 1;

      // #266/#268 — winning tier, within-tier score, pin-or-top-score selection: one shared
      // implementation (`chooseWithinTier`), so the morning batch and the CRITICAL direct-assign sweep
      // choose an SE by the identical discipline. `features` is built from the TICKET, so `baseScore`
      // is identical across candidates and the cluster term is the only thing separating them until
      // #267 gives `distance` a real per-candidate value.
      //
      // **The pin is searched across ALL passing candidates, not just the winning tier, and that is a
      // deliberate operator ruling rather than an oversight.** ADR-0022's bias has crossed tiers since
      // Issue 14a — `recommender-planner-bias.e2e-spec.ts` pins a planner-named MULTI_PLANT SE beating
      // an eligible DEDICATED one — and restricting it to the winning tier would silently retire that,
      // overriding a manager's explicit choice with an SE they did not name and giving them no signal
      // their pin was discarded. So Q1's "precedence is inviolable" binds the SCORE, which is all this
      // issue needed: a higher score can never cross a tier, while a human's pin still can.
      const { chosen, winningTier, tierCandidates, tierScores } = chooseWithinTier({
        passed,
        scoreFor: (c) => scoreCandidate(featuresFor(t), weights, clusterFor(c.seId)).score,
        pinnedSeIds: planned,
      });

      const multiplier = chosen ? clusterFor(chosen.seId) : 1;
      // Retained for the trace/preview field of the same name, now with its Q-A meaning: this decision
      // was NOT a cluster follow-on for the winner (they were not already going to this plant).
      const isSeed = multiplier === 1;

      // Per-filter drop COUNTS across the whole pool — the trace never stores dropped rows verbatim.
      const dropCounts: Record<string, number> = {};
      for (const d of filtered.dropped) dropCounts[d.reason] = (dropCounts[d.reason] ?? 0) + 1;
      const dropReasonBySe = new Map(filtered.dropped.map((d) => [d.candidate.seId, d.reason]));
      const passedSet = new Set(passed.map((c) => c.seId));

      if (chosen === null) {
        const rec = dryRun ? null : await this.prisma.recommendation.create({
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
        if (opts.runId !== undefined && rec !== null) {
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
        if (kitDrop && !dryRun) {
          const missing = kitStatusBySe.get(kitDrop.candidate.seId)?.missing ?? [];
          await this.inventory.recordComponentBlock(t.ticketId, kitDrop.candidate.seId, missing);
        }
        decisions.push({
          ticketId: t.ticketId,
          plantId: String(t.plantId),
          processingRank,
          companyTier: t.companyTier,
          deviceBucket: t.deviceBucket,
          tierOverrideId: t.tierOverrideId,
          seId: null,
          coverageType: null,
          score: null,
          candidatesTotal: ordered.length,
          passedCount: 0,
          dropCounts,
          poolEmptyReason,
          plannerBias: false,
          clusterSeed: isSeed,
          capacityAtDecision: null,
        });
        unassignable++;
        continue;
      }

      // The ticket is assignable now — clear any stale Component-Blocked row for it.
      if (!dryRun) await this.inventory.resolveComponentBlock(t.ticketId, now);

      const coverageType = chosen.coverageType;
      const features = featuresFor(t);
      // The winner's persisted breakdown is the same computation that selected them — same helper,
      // same multiplier — rather than a second derivation that could quietly disagree with it.
      const scored = scoreCandidate(features, weights, multiplier);

      // #126 — guard-not-throw. Stale orphans from finalized/aborted runs were cleared before the
      // loop, so a one-SUGGESTED-per-ticket collision surviving to here can only be a concurrent,
      // still-RUNNING dispatch run that already holds a live SUGGESTED for this ticket. That run owns
      // it → skip rather than throw and wedge the whole zone. Capacity is credited only on success.
      let recommendationId: bigint | null = null;
      try {
        const created = dryRun ? null : await this.prisma.recommendation.create({
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
        recommendationId = created?.recommendationId ?? null;
      } catch (e) {
        // A dry run never creates, so it can never land here — the collision this absorbs is a
        // concurrent still-RUNNING dispatch that already owns this ticket's SUGGESTED row. That is a
        // real (if narrow) divergence: under concurrency the preview shows a ticket the live run has
        // already claimed. It cannot be closed without reading the other run's state, and reading it
        // would make the preview's answer depend on when it was asked.
        if ((e as { code?: string }).code === 'P2002') continue;
        throw e;
      }

      assigned.set(chosen.seId, (assigned.get(chosen.seId) ?? 0) + 1);
      // #266 Q-A — grow the winner's plant set in-run, mirroring the capacity counter one line above:
      // an SE who has just been given this plant carries the clustering benefit into the next ticket
      // here, exactly as an SE who arrived with it already on their day plan does.
      const wonPlants = plantsBySe.get(chosen.seId) ?? new Set<string>();
      wonPlants.add(ticketPlant);
      plantsBySe.set(chosen.seId, wonPlants);
      recommended++;

      const plannerPlannedChosen = planned?.has(chosen.seId) ?? false;
      decisions.push({
        ticketId: t.ticketId,
        plantId: String(t.plantId),
        processingRank,
        companyTier: t.companyTier,
        deviceBucket: t.deviceBucket,
        tierOverrideId: t.tierOverrideId,
        seId: chosen.seId,
        coverageType,
        score: scored.score,
        candidatesTotal: ordered.length,
        passedCount: passed.length,
        dropCounts,
        poolEmptyReason: null,
        plannerBias: plannerPlannedChosen && passed[0]?.seId !== chosen.seId,
        clusterSeed: isSeed,
        capacityAtDecision: {
          used: assigned.get(chosen.seId) ?? 1,
          cap: capacity.get(chosen.seId)?.dailyCapacity ?? null,
        },
      });

      if (opts.runId !== undefined && recommendationId !== null) {
        // #266 — derived from the scores this ticket ACTUALLY produced, not from distance alone.
        //
        // It used to read `distanceFromPrevStopKm === null || weights.distance === 0`, on the reasoning
        // that distance was the only per-SE component, so everything tied and precedence decided. Q-A
        // broke that without touching the expression: the cluster multiplier is per candidate, so two
        // candidates in the winning tier genuinely differ and the score genuinely decides — while the
        // old flag still announced that precedence had. That is worse than a stale field, because an
        // operator reading "precedence decided" goes looking for a coverage explanation that does not
        // exist. Computing it from the spread keeps it true as further per-candidate terms arrive
        // (#267's distance is next), which the distance-shaped expression could never do.
        const tierScoreValues = [...tierScores.values()];
        const scoreDegenerate =
          tierScoreValues.length < 2 ||
          Math.max(...tierScoreValues) - Math.min(...tierScoreValues) < 1e-9;
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
              // #266 — the winner's own score and the breakdown that produced it, so "why this SE"
              // can be read against the runner-ups below rather than inferred. Additive JSON; the
              // recommendation row keeps carrying the same breakdown for its own consumers.
              score: scored.score,
              breakdown: scored.breakdown,
              /** Which coverage tier the score was consulted within — everything below it was never reached. */
              tierEvaluated: winningTier,
            },
            runnersUp: ordered
              .filter((c) => c.seId !== chosen.seId)
              .slice(0, TRACE_RUNNERS_UP)
              .map((c) => ({
                seId: c.seId,
                coverageType: c.coverageType,
                precedenceRank: ordered.findIndex((o) => o.seId === c.seId) + 1,
                // #266 — three outcomes, not two. A candidate that passed every hard filter but sits in
                // a tier below the winning one was never scored: the tier is chosen first and the score
                // is only ever consulted inside it. Calling that PASSED-with-a-score said it had been
                // weighed and lost on merit; calling it DROPPED would say a filter rejected it. Neither
                // happened, so it gets the verdict that describes what did.
                verdict: !passedSet.has(c.seId)
                  ? 'DROPPED'
                  : tierScores.has(c.seId)
                    ? 'PASSED'
                    : 'TIER_NOT_REACHED',
                dropReason: dropReasonBySe.get(c.seId) ?? null,
                plannerPlanned: planned?.has(c.seId) ?? false,
                // #266 — the runner-up's OWN score, closing the defect the TODO here used to admit.
                // Every passing runner-up was previously scored with `multiplier` — the multiplier
                // computed for the CHOSEN SE — which was merely redundant while all candidates scored
                // alike, and became actively wrong the moment Q-A made clustering candidate-specific: a
                // runner-up who has never been to this plant was shown carrying the winner's cluster
                // bonus, so the trace reported a tie the engine never saw. These come from the same map
                // the selection itself used, so the explanation cannot drift from the decision.
                score: tierScores.get(c.seId) ?? null,
              })),
            scoreDegenerate,
            poolEmptyReason: null,
            // Via `unknown` because the winner's breakdown carries `weights: Record<string, number>`,
            // whose index signature does not structurally overlap Prisma's `InputJsonValue` union —
            // the same cast `dispatch-run.service.ts` already uses for `unassignableReasons`.
          } as unknown as Prisma.InputJsonValue,
        });
      }
    }

    if (opts.runId !== undefined && traceRows.length > 0 && !dryRun) {
      await this.prisma.dispatchDecisionTrace.createMany({ data: traceRows });
    }

    return {
      ...(dryRun
        ? {
            projection: {
              zoneId: String(zoneId),
              targetDate: targetDay.toISOString().slice(0, 10),
              bucketsAsOf: bucketsAsOf?.toISOString() ?? null,
              mode,
              recommended,
              unassignable,
              withheldBelowThreshold,
              componentBlockedWithheld,
              unassignableReasons,
              decisions,
              plan: buildPreviewPlan(decisions),
            },
          }
        : {}),
      recommended,
      unassignable,
      mode,
      weightSetRef,
      ticketsConsidered: runList.length,
      unassignableReasons,
      assignmentThresholdHours,
      withheldBelowThreshold,
      bucketlessDropped,
      componentBlockedWithheld,
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
  /**
   * #248 — which of this run's candidates have a vehicle **due back** (Option C's only new input).
   *
   * True when the ticket carries an OPEN vehicle-unavailability report whose *authoritative*
   * `expected_from` has reached the run's IST day — the #245 date, not the SE's proposal, so a
   * manager's override moves the priority with it. The bound comes from `returnDateArrivedBefore`,
   * which is `deferralDateFor`'s complement: the ticket becomes return-due at exactly the moment its
   * deferral stops holding it back, because those are the same event seen from two sides.
   *
   * One query per run, not per ticket (AC2). `distinct` because a ticket's supersession chain can hold
   * more than one row and only OPEN membership matters — the set is a membership test, not a count.
   * Nothing clears the flag on dispatch: assignment removes the ticket from the selectable set
   * entirely, so the question stops being asked rather than needing a different answer.
   */
  private async returnDueTickets(ticketIds: string[], asOf: Date): Promise<Set<string>> {
    if (ticketIds.length === 0) return new Set();
    const rows = await this.prisma.vehicleUnavailabilityReport.findMany({
      where: { ticketId: { in: ticketIds }, status: 'OPEN', expectedFrom: { lt: returnDateArrivedBefore(asOf) } },
      select: { ticketId: true },
      distinct: ['ticketId'],
    });
    return new Set(rows.map((r) => r.ticketId));
  }

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

  /**
   * SE Planner entries for the run date, as plant_id → planned se_ids (soft bias, ADR-0022).
   *
   * The run date is the **IST** calendar day (#240; CONTEXT.md Decisions §19) — `planned_date` is a
   * `@db.Date`, and deriving it from UTC components read the *previous* day's rows for every run
   * between 00:00 and 05:29 IST, dropping the bias with nothing logged.
   */
  private async plannerForDate(zoneId: bigint, day: Date): Promise<Map<string, Set<string>>> {
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
  /**
   * #268 — the base/DEFICIT read is {@link readBaseActiveWeights}, shared with intraday direct-assign;
   * this layers the PREVENTIVE-mode branch on top, which stays private to the morning batch (no other
   * caller runs in PREVENTIVE mode).
   */
  private async activeWeights(mode: RecommenderMode): Promise<{ weights: ScoringWeights; weightSetRef: string }> {
    const { weights: baseWeights, weightSetRef: baseRef } = await readBaseActiveWeights(this.prisma);
    if (mode !== 'PREVENTIVE') return { weights: baseWeights, weightSetRef: baseRef };

    const preventiveRef = `${baseRef}${PREVENTIVE_SUFFIX}`;
    const active = await this.prisma.priorityRuleConfig.findMany({ where: { active: true }, orderBy: { id: 'asc' } });
    const configured: ScoringWeights = {};
    for (const r of active) if (r.weightSetRef === preventiveRef) configured[r.component] = Number(r.weight);
    if (Object.keys(configured).length > 0) return { weights: configured, weightSetRef: preventiveRef };

    const weights: ScoringWeights = {
      ...baseWeights,
      repeat_failure_penalty: 0,
      repeat_failure_bonus: PREVENTIVE_REPEAT_BONUS,
      device_age: PREVENTIVE_AGE_WEIGHT,
    };
    return { weights, weightSetRef: preventiveRef };
  }

  private plantClusterMultiplier(): Promise<number> {
    return readPlantClusterMultiplier(this.prisma);
  }

  private engineerCapacity(): Promise<Map<string, { dailyCapacity: number; isActive: boolean }>> {
    return readEngineerCapacity(this.prisma);
  }

  /**
   * NEW-A1 — an SE's already-committed workload for `day`, counted as active batch stops across ALL their
   * live work schedules covering that date (every zone, every prior run today, plus intraday inserts —
   * all of which land as day-plan stops). Read once at run start to seed the per-run `assigned`
   * counter; the current zone's own suggestions are not yet dispatched (they add via the in-run
   * increment), so there is no double count.
   *
   * **#269 moved the predicate out of this class** to `scheduling/committed-day-load.ts`. Enforcement
   * used to agree with display by coincidence — three services counted "committed" three different
   * ways and nothing rendered any of them beside `daily_capacity`, so the disagreement never showed.
   * #269 renders it on every manager picker, so the two must now be the *same* function, and
   * `capacity-overload-visibility.e2e-spec.ts` asserts they stay that way through both public seams.
   * Keep delegating: a private re-implementation here is the exact drift that test exists to catch.
   *
   * #153 — "live" includes OVERRIDDEN. A ZM adjusting a day plan does not un-commit the work still on
   * it; counting only ACTIVE zeroed the SE's load and let the next run hand them a whole second day.
   */
  private committedDayPlan(day: Date): Promise<Map<string, CommittedDayEntry>> {
    return committedDayPlan(this.prisma, day);
  }

  private committedDayLoad(day: Date): Promise<Map<string, number>> {
    return committedDayLoad(this.prisma, day);
  }
}

