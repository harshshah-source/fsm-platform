import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  apiAssignableWork,
  type AssignablePlantRow,
  type AssignableWorkView,
} from '../../api/assignWork';
import { apiCandidates, type CandidatesView, type PlantCandidates } from '../../api/candidates';
import {
  apiAssignBatch,
  apiAssignableTickets,
  apiZoneEngineers,
  type AssignBatchLaneResult,
  type DistributeResult,
  type DistributeUnplaced,
  type ZoneEngineer,
} from '../../api/schedules';
import { MetricStrip, SearchInput, type Metric } from '../../components/data';
import { Badge, Button, LoadBadge } from '../../components/ui';
import { engineerOptionLabel, isOverCapacity } from '../../lib/capacity';
import { cn } from '../../lib/cn';
import { formatPlantDisplayName } from '../../lib/plantNames';
import { CandidateColumn } from './CandidateColumn';
import { DistributePanel } from './DistributePanel';
import { CHIP_FORM, CHIP_MEANING_LABEL, GrammarLegend, chipMeaning } from './grammar';
import { LaneHeader, laneCoverage } from './LaneCoverage';
import { ReviewCommitScreen, type ReviewLane } from './ReviewCommitScreen';

/**
 * **The assign workspace** — pool → draft lanes → distribute → review → commit (#273, approved
 * direction #272; the authoritative design is
 * `docs/ui/desktop/approved-designs/assign-work-console.html`).
 *
 * **Two surfaces, one implementation.** This began as the whole of `/assign` and was lifted out of it
 * whole when the Scheduler Console gained Assign mode (slice §13 Phase 4, approved as §14 **D2**).
 * The Console does not rebuild the draft — it renders *this*, narrowed to one zone and handed the
 * roster it already holds. A second copy of a state machine whose entire contract is "nothing is
 * written until commit" is the one duplication this programme cannot afford: the two would diverge,
 * and the half that diverged would be the half that writes.
 *
 * The two callers differ in exactly three ways, and each is a prop:
 *  - **{@link AssignWorkspaceProps.zoneId}** — the Console is zone-scoped (§14 **D4**), `/assign`
 *    keeps the pan-India pool for a CSM or Operations Head.
 *  - **{@link AssignWorkspaceProps.engineers}** — the Console passes the roster from its own lifted
 *    `GET /dispatch/today`; `/assign` reads `GET /schedules/engineers`.
 *  - **{@link AssignWorkspaceProps.header}** — a page header on one, a mode banner on the other.
 *
 * Seven surfaces in this app could already move work to an engineer and **not one showed a count**:
 * the volume arrived afterwards, in a toast. Each is shaped N→1 — many tickets, one engineer, written
 * immediately, no preview and no residual — while a dispatcher's job is M→N. This is the M→N surface,
 * and the ledger across the top is the answer none of the seven could give: *how much is left?*
 *
 * **Nothing is written until commit (#272 R2).** That is what makes the residual live rather than
 * retrospective, and it is why the draft is client state and the ledger is arithmetic rather than a
 * second read.
 *
 * **The draft is session-local (#272 Q2, ruled).** Leaving the page loses it, and the page says so
 * rather than implying a durability it does not have. A shared, resumable draft needs its own table,
 * an owner and a staleness rule for when the underlying tickets move; that is not v1.
 *
 * **Four of five slices.** #273 built the pool, the ledger and the commit; **#274** added the
 * candidate column (the engine's own ordered eligibility list, dropped candidates included with their
 * reason), coverage badges per engineer-and-plant, and the `committed → after / capacity` load each
 * lane would carry. **#275** replaced the direct-commit with a review-and-commit screen over the
 * transactional `assign-batch`. **#276** added Distribute: project several plants across several
 * engineers before anything enters the draft, from the real selection logic, with the remainder it
 * could not place held in the draft's own **no-eligible-engineer rail**. **#277** absorbed the
 * orphaned manual-assignment surfaces.
 */

/** The unit of selection. A plant serves several companies, so neither id alone identifies a row. */
const rowKey = (companyId: string, plantId: string) => `${companyId}:${plantId}`;

interface Lane {
  id: number;
  seId: string;
  /** Plant ids, deduplicated — the write's unit (see {@link plantTotals}). */
  plantIds: string[];
  /**
   * #276 — ticket ids Distribute placed at a plant it did **not** hand over whole (a strategy split
   * the plant, or handed only part of it to this lane). Only set for such plants; a manually-built
   * lane (#273/#274) never populates this, and a Distribute lane that received a plant's *entire*
   * assignable set leaves it unset too — both fall back to resolving the whole plant at review time
   * (`GET /schedules/assignable-tickets`), exactly as before. The override exists so a partial
   * placement is not silently widened back out to the whole plant at commit.
   */
  ticketOverrides?: Record<string, string[]>;
}

/**
 * Every company row folded down to the **plant**, because `assignPlants` is plant-shaped: it moves all
 * of a plant's assignable work regardless of which company's row was ticked.
 *
 * This is the slice's one sharp edge and it is surfaced rather than hidden. Drafting UltraTech's 4
 * devices at a site it shares with Acme commits Acme's 6 as well, so the ledger has to count 10 — a
 * draft that counted only the ticked row would under-report its own commit, which is the failure R3
 * exists to prevent, reappearing one layer up. Ticket-level selection arrives with #275's
 * `assign-batch`; until then the honest move is to count what the button does and say why.
 */
function plantTotals(view: AssignableWorkView | null) {
  const totals = new Map<string, { openUnassigned: number; criticalCount: number; companies: Set<string> }>();
  for (const c of view?.companies ?? []) {
    for (const p of c.plants) {
      const entry = totals.get(p.plantId) ?? { openUnassigned: 0, criticalCount: 0, companies: new Set<string>() };
      entry.openUnassigned += p.openUnassigned;
      entry.criticalCount += p.criticalCount;
      entry.companies.add(c.companyId);
      totals.set(p.plantId, entry);
    }
  }
  return totals;
}

/** `61 h silent` / `—` — the age of the oldest thing waiting at a site. */
function silentFor(hours: number | null): string | null {
  return hours === null ? null : `oldest ${Math.round(hours)} h silent`;
}

/**
 * The two ways Distribute can fail to place work, in the transparency surfaces' own words (#276
 * required-change 4). `NO_COVERAGE` — not one of the chosen engineers covers the plant at any tier.
 * `ALL_DROPPED` — some do, and every one of them failed a hard filter. They are different problems
 * (a coverage gap versus a readiness gap) and the rail must not blur them into "unassignable".
 */
const UNPLACED_REASON_TEXT: Record<DistributeUnplaced['reason'], string> = {
  NO_COVERAGE: 'no coverage',
  ALL_DROPPED: 'all dropped',
};

/**
 * Narrow a pool to one zone, ledger included — the Console's half of §14 **D4**.
 *
 * `GET /schedules/assignable-work` clamps to a zone only for a ZM (or for a CSM/OH *acting* in one).
 * For a CSM or Operations Head standing in their own role it answers pan-India, which is right for
 * `/assign` and wrong beside a one-zone deck: the busiest row in the country would sit at the top of
 * a zone's screen. The rows already carry `zoneId`, so the narrowing is exact rather than a guess.
 *
 * **The totals are re-derived, not carried.** They are the server's sum over the wider set; keeping
 * them would print "21 unassigned" above five rows totalling five, on the one surface whose purpose
 * is to answer *how much is left*. The re-derivation is the same accumulation the server does — one
 * addition per (company, plant) pair — over a strict subset of the same rows.
 */
export function narrowToZone(
  view: AssignableWorkView | null,
  zoneId: string | null | undefined,
): AssignableWorkView | null {
  if (view === null || zoneId == null) return view;
  const companies = view.companies
    .map((c) => ({ ...c, plants: c.plants.filter((p) => p.zoneId === zoneId) }))
    // A company with nothing left in this zone is not an empty heading — it is not in this zone.
    .filter((c) => c.plants.length > 0);
  const totals = { openUnassigned: 0, criticalCount: 0, heldCount: 0, plants: 0 };
  for (const c of companies) {
    for (const p of c.plants) {
      totals.openUnassigned += p.openUnassigned;
      totals.criticalCount += p.criticalCount;
      totals.heldCount += p.heldCount;
      totals.plants += 1;
    }
  }
  return { ...view, totals, companies };
}

export interface AssignWorkspaceProps {
  /**
   * Narrow the pool and its ledger to this zone (§14 **D4**). Omitted — `/assign`'s case — the pool
   * is whatever scope the caller's own claims and acting header give them.
   */
  zoneId?: string | null;
  /**
   * The lane targets. Omitted, the workspace reads `GET /schedules/engineers` itself.
   *
   * The Console passes its own roster instead, and the reason is the same one behind `zoneId`: that
   * route is **also** pan-India for a CSM who is not acting in a zone, so it would offer another
   * zone's engineers as lane targets for this zone's work. The Console already holds the zone's
   * active roster with `committed` from the definition the recommender enforces against — asking
   * again would be a wider answer to a question already answered.
   */
  engineers?: ZoneEngineer[];
  /** Chrome above the workspace. Drafting and reviewing are two different screens and say so. */
  header?: (stage: 'draft' | 'review') => ReactNode;
  /**
   * A commit landed. The workspace always reloads its own pool; this is for a caller that has other
   * state to invalidate — the Console's single lifted `GET /dispatch/today` (§8.4), whose board must
   * already show the work the operator just handed out when they leave Assign mode.
   */
  onCommitted?: () => void;
}

export function AssignWorkspace({
  zoneId = null,
  engineers: engineersProp,
  header,
  onCommitted,
}: AssignWorkspaceProps = {}) {
  const [view, setView] = useState<AssignableWorkView | null>(null);
  const [fetchedEngineers, setFetchedEngineers] = useState<ZoneEngineer[]>([]);
  const ownsRoster = engineersProp === undefined;
  const engineers = engineersProp ?? fetchedEngineers;
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  /** #277 — absorbs `CriticalQueue`'s grouping into a pool filter; the `criticalCount` badge already
   *  on every row is the same cluster-size signal that component uniquely carried. */
  const [criticalOnly, setCriticalOnly] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // One empty lane from the start. A console that opens with no lane offers a pool you can tick and
  // nowhere to put it — a dead end on the first screen, and the dispatcher always needs at least one.
  const [lanes, setLanes] = useState<Lane[]>([{ id: 1, seId: '', plantIds: [] }]);
  const [nextLaneId, setNextLaneId] = useState(2);
  const [committing, setCommitting] = useState(false);
  /**
   * The plant the candidate column is answering for (#274 item 2 — "focus follows the plant or chip
   * the operator is working on"). Null until the pool arrives, then the first row, so the column is
   * useful on load rather than an instruction to click something.
   */
  const [focusedPlantId, setFocusedPlantId] = useState<string | null>(null);
  const [candidateView, setCandidateView] = useState<CandidatesView | null>(null);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  /**
   * The review-and-commit screen (#275). Null = drafting; set once the operator asks to review — the
   * ready lanes' plants are resolved to ticket ids first, so the diff and the commit act on the exact
   * same set. Nothing is written by entering review; only {@link commitBatch} writes.
   */
  const [reviewLanes, setReviewLanes] = useState<ReviewLane[] | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [batchResults, setBatchResults] = useState<AssignBatchLaneResult[] | null>(null);
  /** #276 — the Distribute panel. Closed by default; opened from the footer over the ticked pool rows. */
  const [distributing, setDistributing] = useState(false);
  /**
   * #276 — work a projection could not place, kept in the draft's own rail (`#272`'s approved design)
   * rather than dying with the panel that reported it. This is draft state, not panel state: the
   * operator has to be able to close Distribute, keep editing, and still see what nobody can take.
   *
   * Keyed by ticket so a second run over an overlapping selection **replaces** its verdict instead of
   * double-counting it — the same ticket cannot be both `NO_COVERAGE` and placed.
   */
  const [unplaced, setUnplaced] = useState<Map<string, DistributeUnplaced>>(new Map());

  const load = useCallback(() => {
    let alive = true;
    apiAssignableWork()
      // Narrowed **on arrival**, so nothing downstream — the ledger, the plant totals, the search,
      // the draft — can be handed a row the operator was never shown.
      .then((v) => alive && setView(narrowToZone(v, zoneId)))
      .catch(() => alive && setError('Failed to load the work pool'));
    if (ownsRoster) {
      apiZoneEngineers()
        .then((e) => alive && setFetchedEngineers(e))
        .catch(() => alive && setFetchedEngineers([]));
    }
    return () => {
      alive = false;
    };
    // `ownsRoster`, never `engineersProp` itself: an array prop is a fresh identity on every render
    // of the caller, and this callback is an effect dependency — closing over the array would make
    // the pool refetch in a loop for any caller that did not memoise.
  }, [zoneId, ownsRoster]);

  useEffect(() => load(), [load]);

  const totals = useMemo(() => plantTotals(view), [view]);

  /** Plants already drafted, across every lane — a plant cannot be handed to two engineers. */
  const drafted = useMemo(() => new Set(lanes.flatMap((l) => l.plantIds)), [lanes]);

  /** #276 — the ticked pool rows, folded to distinct plant ids: Distribute's own input unit. */
  const selectedPlantIds = useMemo(() => [...new Set([...selected].map((k) => k.split(':')[1]))], [selected]);

  /**
   * Which plants the column needs an answer for: the focused one, plus every plant already drafted —
   * the lanes need per-(engineer, plant) coverage and the same load figures, and asking for them in
   * the one request the column already makes is cheaper than a second read per lane.
   */
  const askFor = useMemo(() => {
    const ids = new Set(drafted);
    if (focusedPlantId) ids.add(focusedPlantId);
    return [...ids].sort();
  }, [drafted, focusedPlantId]);

  // The pool arrives busiest-first, so the first row is where the operator's eye already is.
  useEffect(() => {
    if (focusedPlantId !== null) return;
    const first = view?.companies[0]?.plants[0]?.plantId;
    if (first) setFocusedPlantId(first);
  }, [view, focusedPlantId]);

  useEffect(() => {
    if (askFor.length === 0) {
      setCandidateView(null);
      return;
    }
    let alive = true;
    setCandidatesLoading(true);
    apiCandidates(askFor)
      .then((v) => alive && setCandidateView(v))
      .catch(() => alive && setCandidateView(null))
      .finally(() => alive && setCandidatesLoading(false));
    return () => {
      alive = false;
    };
  }, [askFor]);

  /**
   * The focused plant's candidate list, or null while it is still in flight.
   *
   * Read defensively on purpose. The candidate column is **additive** — #274's rollback is "hide the
   * column and the console degrades to #273's behaviour" — so a candidates read that answers with an
   * unexpected shape must cost the operator the column and nothing else. Reaching into `plants`
   * unguarded took the whole page down with it: the pool, the ledger and the Commit button, none of
   * which depend on this read at all.
   */
  const focusedCandidates: PlantCandidates | null =
    candidateView?.plants?.find((p) => p.plantId === focusedPlantId) ?? null;

  const inDraft = useMemo(() => {
    let open = 0;
    let critical = 0;
    const countedForCritical = new Set<string>();
    for (const lane of lanes) {
      for (const plantId of lane.plantIds) {
        // #276 — a plant Distribute only partly placed here counts its own ticket ids, not the whole
        // plant's total, or a split site would overcount "in draft" by however much landed elsewhere.
        const override = lane.ticketOverrides?.[plantId];
        open += override ? override.length : (totals.get(plantId)?.openUnassigned ?? 0);
        // Critical count has no per-ticket breakdown on the client (the pool only carries a per-plant
        // aggregate) — counted once per distinct plant, same as before #276. A plant a strategy split
        // across two lanes is therefore an approximation here; the review screen's own per-ticket
        // resolution is what the commit actually acts on.
        if (!countedForCritical.has(plantId)) {
          countedForCritical.add(plantId);
          critical += totals.get(plantId)?.criticalCount ?? 0;
        }
      }
    }
    return { open, critical };
  }, [lanes, totals]);

  /**
   * What the draft has actually placed, at the granularity the draft knows it.
   *
   * A lane holding a plant with **no** override has taken that plant *whole*, so every ticket there is
   * placed even though the ids are not resolved until review — recorded as a plant id. A lane holding
   * an override has taken exactly those ids and no more.
   */
  const placed = useMemo(() => {
    const wholePlants = new Set<string>();
    const ticketIds = new Set<string>();
    for (const lane of lanes) {
      for (const plantId of lane.plantIds) {
        const override = lane.ticketOverrides?.[plantId];
        if (override) for (const id of override) ticketIds.add(id);
        else wholePlants.add(plantId);
      }
    }
    return { wholePlants, ticketIds };
  }, [lanes]);

  /**
   * The rail's live contents — everything the projection could not place that the draft has not since
   * picked up.
   *
   * **Per ticket, not per plant.** The approved design draws Pali Works simultaneously in an
   * engineer's lane *and* in the rail, which is the real and common case: a plant whose work is
   * partly coverable and partly not. Filtering the rail by "is this plant drafted anywhere" would
   * erase exactly that row. Placing work by hand still clears it, because a hand-drafted plant is
   * taken whole (R2 — the operator may always overrule the projection).
   *
   * Derived rather than stored, so it self-corrects as the operator edits: removing a chip puts its
   * unplaceable work back on the rail without Distribute having to be re-run.
   */
  const unplacedVisible = useMemo(
    () =>
      [...unplaced.values()].filter(
        (u) => !placed.wholePlants.has(u.plantId) && !placed.ticketIds.has(u.ticketId),
      ),
    [unplaced, placed],
  );

  /**
   * One chip per (plant, reason) — the design's own grouping. Two reasons at one plant stay two
   * chips: they are different failures and merging them would hide a coverage gap behind a
   * readiness one. Busiest first, then by plant, so the order is stable across re-renders.
   */
  const unplacedGroups = useMemo(() => {
    const groups = new Map<string, { plantId: string; reason: DistributeUnplaced['reason']; count: number }>();
    for (const u of unplacedVisible) {
      const key = `${u.plantId}:${u.reason}`;
      const row = groups.get(key) ?? { plantId: u.plantId, reason: u.reason, count: 0 };
      row.count += 1;
      groups.set(key, row);
    }
    return [...groups.values()].sort((a, b) => b.count - a.count || a.plantId.localeCompare(b.plantId));
  }, [unplacedVisible]);

  const openTotal = view?.totals.openUnassigned ?? 0;


  const metrics: Metric[] = [
    // "zone scope" was true of every caller when there was only one. It is not true of `/assign`,
    // whose pool is pan-India for a CSM or Operations Head — and a ledger that mislabels its own
    // denominator is the one thing this strip cannot do.
    {
      label: 'Open unassigned',
      value: openTotal,
      hint: view ? `${zoneId === null ? 'your scope' : 'this zone'} · ${view.date}` : '—',
      tone: 'info',
      testId: 'ledger-open',
    },
    { label: 'In this draft', value: inDraft.open, hint: `${drafted.size} plants · ${lanes.length} engineers`, tone: 'brand', testId: 'ledger-draft' },
    {
      label: 'Left after commit',
      value: openTotal - inDraft.open,
      hint: openTotal > 0 ? `${Math.round(((openTotal - inDraft.open) / openTotal) * 100)}% still unassigned` : 'nothing outstanding',
      tone: 'neutral',
      testId: 'ledger-left',
    },
    {
      label: 'Critical+ in draft',
      value: inDraft.critical,
      hint: `of ${view?.totals.criticalCount ?? 0} ${zoneId === null ? 'in scope' : 'in this zone'}`,
      tone: inDraft.critical > 0 ? 'critical' : 'neutral',
      testId: 'ledger-critical',
    },
  ];

  const matches = (company: string, plant: AssignablePlantRow) => {
    if (criticalOnly && plant.criticalCount === 0) return false;
    const term = search.trim().toLowerCase();
    if (!term) return true;
    return company.toLowerCase().includes(term) || plant.plantName.toLowerCase().includes(term);
  };

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  /** Move the ticked rows into a lane, as plants — the unit the commit will use. */
  const addToDraft = (laneId: number) => {
    const plantIds = [...selected].map((k) => k.split(':')[1]);
    setLanes((prev) =>
      prev.map((l) =>
        l.id === laneId ? { ...l, plantIds: [...new Set([...l.plantIds, ...plantIds])] } : l,
      ),
    );
    setSelected(new Set());
  };

  /**
   * Pick this engineer for the focused plant (#274 item 2 — the column's arrow into the draft).
   *
   * Reuses the engineer's existing lane if they already have one, otherwise the first empty lane,
   * otherwise a new one. A second lane for the same engineer would split their load across two rows
   * and make the `→ after / cap` figure on each of them a lie.
   *
   * **Never refused**, whatever the candidate's verdict: the engine's hard filters decide what
   * *dispatch* does, and #258 Q2 rules manual overload an administrative right. The row states the
   * drop and the load; the decision is the operator's.
   */
  const assignCandidate = (seId: string) => {
    if (!focusedPlantId) return;
    // The "did we open a new lane?" decision is made **once**, inside the updater that has the
    // authoritative `prev`. Asking it twice — once over `prev`, once over the render's `lanes` to
    // decide whether to bump the id — is two copies of one predicate that have to agree forever, and
    // the day they stop agreeing two lanes share an id.
    let opened = false;
    setLanes((prev) => {
      const existing = prev.find((l) => l.seId === seId) ?? prev.find((l) => !l.seId && l.plantIds.length === 0);
      if (existing) {
        return prev.map((l) =>
          l.id === existing.id
            ? { ...l, seId, plantIds: [...new Set([...l.plantIds, focusedPlantId])] }
            : l,
        );
      }
      opened = true;
      return [...prev, { id: nextLaneId, seId, plantIds: [focusedPlantId] }];
    });
    if (opened) setNextLaneId((n) => n + 1);
  };

  const addLane = () => {
    setLanes((prev) => [...prev, { id: nextLaneId, seId: '', plantIds: [] }]);
    setNextLaneId((n) => n + 1);
  };

  /**
   * #276 — merge a Distribute projection into the draft. It is a starting point, not a commit (R2):
   * the operator can still move chips, add plants, or drop a lane before ever reviewing. Reuses the
   * engineer's existing lane exactly as {@link assignCandidate} does — a second lane for one engineer
   * would split their load and make the `→ after / cap` figure on each row a lie.
   *
   * A plant a strategy handed over **whole** (its ticket ids match the pool's full assignable set)
   * needs no override — it behaves exactly like a manually-drafted plant, resolved fresh at review
   * time. A plant it only **partly** placed (`CAPACITY_HEADROOM` splitting a busy site, or a second
   * lane also drafted into the same plant) keeps its explicit ticket ids so the review screen commits
   * precisely what was projected, not the whole plant.
   */
  const addDistributeResultToDraft = (result: DistributeResult) => {
    let created = 0;
    setLanes((prev) => {
      let next = [...prev];
      let cursor = nextLaneId;
      for (const dLane of result.lanes) {
        for (const stop of dLane.plants) {
          const wholePlant = stop.ticketIds.length === (totals.get(stop.plantId)?.openUnassigned ?? -1);
          const existingIdx = next.findIndex((l) => l.seId === dLane.seId);
          const emptyIdx = existingIdx === -1 ? next.findIndex((l) => !l.seId && l.plantIds.length === 0) : -1;
          const targetIdx = existingIdx !== -1 ? existingIdx : emptyIdx;

          const applyTo = (lane: Lane): Lane => {
            const plantIds = lane.plantIds.includes(stop.plantId) ? lane.plantIds : [...lane.plantIds, stop.plantId];
            const overrides = wholePlant
              ? lane.ticketOverrides
              : { ...lane.ticketOverrides, [stop.plantId]: stop.ticketIds };
            return { ...lane, seId: dLane.seId, plantIds, ticketOverrides: overrides };
          };

          if (targetIdx !== -1) {
            next = next.map((l, i) => (i === targetIdx ? applyTo(l) : l));
          } else {
            next = [...next, applyTo({ id: cursor, seId: '', plantIds: [] })];
            cursor += 1;
            created += 1;
          }
        }
      }
      return next;
    });
    if (created > 0) setNextLaneId((n) => n + created);
    // #276 required-change 4 — the unplaced remainder moves into the draft's rail with the lanes, in
    // the same action, instead of dying with the panel that reported it. Keyed by ticket, so a second
    // run over an overlapping selection replaces its earlier verdict rather than double-counting it.
    // Nothing is removed here: {@link unplacedVisible} filters against the live draft, so a ticket
    // this run placed drops off the rail on its own — and comes back if the operator undoes it.
    setUnplaced((prev) => {
      const next = new Map(prev);
      for (const u of result.unplaced) next.set(u.ticketId, u);
      return next;
    });
    setDistributing(false);
  };

  /** Drop the draft *and* the rail: both describe a projection the operator has just abandoned. */
  const clearDraft = () => {
    setLanes([{ id: nextLaneId, seId: '', plantIds: [] }]);
    setUnplaced(new Map());
  };

  const engineerName = (seId: string) => engineers.find((e) => e.engineerId === seId)?.name ?? seId;
  const plantName = (plantId: string) =>
    view?.companies.flatMap((c) => c.plants).find((p) => p.plantId === plantId)?.plantName ?? `Plant ${plantId}`;

  /**
   * #290 AC5 — the ledger's fifth cell: what should worry you about *this draft*.
   *
   * The four numbers beside it answer "how much work"; none of them answers "and is any of it a
   * problem". Derived from the very same `laneCoverage` the lanes render and the same `isOverCapacity`
   * the load uses, so the summary can never disagree with the board underneath it — a rollup computed
   * a second way is a rollup that will eventually contradict its own detail.
   */
  const draftWarnings = useMemo(() => {
    let overCapacity = 0;
    let crossings = 0;
    let noCoverage = 0;
    for (const lane of lanes) {
      if (!lane.seId || lane.plantIds.length === 0) continue;
      const eng = engineers.find((e) => e.engineerId === lane.seId);
      const after =
        (eng?.committed ?? 0) +
        lane.plantIds.reduce(
          (n, id) => n + (lane.ticketOverrides?.[id]?.length ?? totals.get(id)?.openUnassigned ?? 0),
          0,
        );
      if (typeof eng?.dailyCapacity === 'number' && isOverCapacity({ committed: after, dailyCapacity: eng.dailyCapacity })) {
        overCapacity += 1;
      }
      for (const c of laneCoverage(lane.seId, lane.plantIds, candidateView, plantName)) {
        if (c.coverageType === null) noCoverage += 1;
        else if (c.tierCrossing) crossings += 1;
      }
    }
    return { overCapacity, crossings, noCoverage };
  }, [lanes, engineers, totals, candidateView, plantName]);

  const readyLanes = lanes.filter((l) => l.seId && l.plantIds.length > 0);

  /**
   * Resolve each ready lane's drafted plants into the ticket ids the commit will actually move, then
   * hand the diff to the review screen (#275). Nothing is written here — #272 R2 holds until
   * {@link commitBatch}; this is a read, same as the pool and candidate reads already are.
   */
  const openReview = async () => {
    setReviewing(true);
    setBatchResults(null);
    try {
      const built: ReviewLane[] = [];
      for (const lane of readyLanes) {
        // #276 — a plant Distribute placed only part of keeps its explicit ticket ids; only the
        // plants with no override (every manually-built lane, and any Distribute handed whole) go
        // through the whole-plant resolver.
        const toResolve = lane.plantIds.filter((id) => !lane.ticketOverrides?.[id]);
        const resolved = await apiAssignableTickets(toResolve);
        const ticketIds = [
          ...resolved.flatMap((r) => r.ticketIds),
          ...lane.plantIds.flatMap((id) => lane.ticketOverrides?.[id] ?? []),
        ];
        const eng = engineers.find((e) => e.engineerId === lane.seId);
        const committed = eng?.committed ?? 0;
        const criticalCount = lane.plantIds.reduce((n, id) => n + (totals.get(id)?.criticalCount ?? 0), 0);
        built.push({
          seId: lane.seId,
          engineerName: engineerName(lane.seId),
          plantNames: lane.plantIds.map(plantName),
          ticketIds,
          criticalCount,
          coverage: laneCoverage(lane.seId, lane.plantIds, candidateView, plantName),
          committed,
          after: committed + ticketIds.length,
          dailyCapacity: typeof eng?.dailyCapacity === 'number' ? eng.dailyCapacity : null,
        });
      }
      setReviewLanes(built);
    } catch {
      setError('Failed to build the review — try again');
    } finally {
      setReviewing(false);
    }
  };

  /** The one write (#275) — `assign-batch`, one transaction per lane, one result row per lane. */
  const commitBatch = async (reasonCode: string) => {
    if (!reviewLanes) return;
    setCommitting(true);
    try {
      const out = await apiAssignBatch(
        reasonCode,
        reviewLanes.map((l) => ({ seId: l.seId, ticketIds: l.ticketIds })),
      );
      setBatchResults(out.lanes);
      setLanes([{ id: nextLaneId, seId: '', plantIds: [] }]);
      // The rail described a projection over the pre-commit pool; that pool has just moved. Keeping
      // it would leave stale "nobody can take this" claims on screen beside a freshly reloaded pool.
      setUnplaced(new Map());
      load();
      // §8.4 — the caller's own reads have just gone stale too. The Console invalidates the one
      // payload its four regions share here; `/assign` has nothing else to invalidate and passes
      // nothing. Called after `load()` and inside the try, so a failed commit invalidates nothing.
      onCommitted?.();
    } catch {
      setError('Commit failed before any lane result came back — check the audit trail before retrying.');
    } finally {
      setCommitting(false);
    }
  };

  const backToDraft = () => {
    setReviewLanes(null);
    setBatchResults(null);
  };

  if (reviewLanes) {
    return (
      <div>
        {header?.('review')}
        {error && (
          <p role="alert" className="mb-4 text-sm text-critical">
            {error}
          </p>
        )}
        <ReviewCommitScreen
          lanes={reviewLanes}
          stillUnassignedAfter={Math.max(0, openTotal - reviewLanes.reduce((n, l) => n + l.ticketIds.length, 0))}
          // #276 — of what is left after this commit, how much nobody in the selection can take. The
          // rail's own live count, so the review screen and the draft cannot disagree about it.
          noEligibleEngineerCount={unplacedVisible.length}
          committing={committing}
          results={batchResults}
          onBack={backToDraft}
          onCommit={commitBatch}
          onTicketResolved={load}
        />
      </div>
    );
  }

  return (
    <div>
      {header?.('draft')}

      {error && (
        <p role="alert" className="mb-4 text-sm text-critical">
          {error}
        </p>
      )}

      <MetricStrip metrics={metrics} />

      {/* #290 AC5 — the ledger's fifth cell. Silent on a clean draft: a row of "0 over capacity ·
          0 crossings" trains the operator to stop reading the one place a real warning will appear. */}
      <div data-testid="ledger-summary" className="flex flex-wrap items-center gap-2 text-[11px]">
        {draftWarnings.overCapacity > 0 && (
          <Badge tone="warning" data-testid="summary-over-capacity">
            {draftWarnings.overCapacity} {draftWarnings.overCapacity === 1 ? 'engineer' : 'engineers'} over capacity
          </Badge>
        )}
        {draftWarnings.crossings > 0 && (
          <Badge tone="tierCross" data-testid="summary-crossings">
            {draftWarnings.crossings} tier {draftWarnings.crossings === 1 ? 'crossing' : 'crossings'}
          </Badge>
        )}
        {draftWarnings.noCoverage > 0 && (
          <Badge tone="critical" data-testid="summary-no-coverage">
            {draftWarnings.noCoverage} no coverage
          </Badge>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* ---------------- Work pool ---------------- */}
        <section className="rounded-card border border-line bg-surface-card p-3" aria-label="Work pool">
          <header className="mb-2 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-ink-strong">Work pool</h2>
            <span className="text-xs text-ink-muted">{openTotal} unassigned</span>
          </header>

          <SearchInput
            className="w-full"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search company or plant…"
            aria-label="Search the work pool"
          />

          {/* #277 — the Critical+ preset that absorbs the orphaned `CriticalQueue` grouping. */}
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button
              type="button"
              data-testid="filter-critical-plus"
              aria-pressed={criticalOnly}
              onClick={() => setCriticalOnly((v) => !v)}
              className={cn(
                'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                criticalOnly
                  ? 'border-critical bg-critical-bg text-critical'
                  : 'border-line bg-surface-raised text-ink-muted hover:text-ink-strong',
              )}
            >
              Critical+
            </button>
          </div>

          <div className="mt-3 space-y-4">
            {(view?.companies ?? []).map((company) => {
              const plants = company.plants.filter((p) => matches(company.companyName, p));
              if (plants.length === 0) return null;
              return (
                <div key={company.companyId}>
                  <div className="mb-1 flex items-baseline justify-between text-xs">
                    <span className="font-semibold text-ink-strong">{company.companyName}</span>
                    <span className="text-ink-muted">
                      {plants.length} plants · {plants.reduce((n, p) => n + p.openUnassigned, 0)}
                    </span>
                  </div>
                  <ul className="space-y-1">
                    {plants.map((p) => {
                      const key = rowKey(company.companyId, p.plantId);
                      const shared = (totals.get(p.plantId)?.companies.size ?? 1) > 1;
                      const already = drafted.has(p.plantId);
                      const silent = silentFor(p.oldestInactivityHours);
                      return (
                        <li
                          key={key}
                          data-testid={`pool-plant-${company.companyId}-${p.plantId}`}
                          className={cn(
                            'flex items-start gap-2 rounded-md border border-line px-2 py-1.5 text-sm',
                            selected.has(key) && 'bg-brand-300/20',
                            already && 'opacity-60',
                          )}
                        >
                          <input
                            type="checkbox"
                            className="mt-1"
                            aria-label={`Select ${p.plantName} for ${company.companyName}`}
                            checked={selected.has(key)}
                            disabled={p.openUnassigned === 0 || already}
                            onChange={() => {
                              toggle(key);
                              setFocusedPlantId(p.plantId);
                            }}
                          />
                          <span className="min-w-0 flex-1">
                            {/* The name is the focus control, kept separate from the checkbox: ticking
                                a row drafts it, clicking its name asks "who can cover this?" — two
                                different questions the dispatcher alternates between. */}
                            <button
                              type="button"
                              aria-label={`Candidates for ${p.plantName}`}
                              onClick={() => setFocusedPlantId(p.plantId)}
                              className={cn(
                                'block w-full truncate text-left font-medium text-ink-strong hover:underline',
                                focusedPlantId === p.plantId && 'underline decoration-brand-600 decoration-2',
                              )}
                            >
                              {formatPlantDisplayName(p.plantName)}
                            </button>
                            <span className="block text-[11px] text-ink-muted">
                              {silent ?? 'age not recorded'}
                              {/* The plant-shaped commit, said out loud on the row it applies to. */}
                              {shared && ' · serves 2 companies — all of its unassigned work moves together'}
                            </span>
                          </span>
                          <span className="flex shrink-0 items-center gap-1.5 text-right">
                            <span className="tabular-nums font-semibold text-ink-strong">{p.openUnassigned}</span>
                            <span className="tabular-nums text-[11px] text-ink-muted">/ {p.totalDevices}</span>
                            {p.criticalCount > 0 && <Badge tone="critical">{p.criticalCount} crit</Badge>}
                            {p.heldCount > 0 && <Badge tone="warning">{p.heldCount} held</Badge>}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
            {view && view.companies.length === 0 && (
              <p className="text-sm text-ink-muted">Nothing unassigned in your scope right now.</p>
            )}
            {view &&
              view.companies.length > 0 &&
              view.companies.every((c) => c.plants.every((p) => !matches(c.companyName, p))) && (
                <p className="text-sm text-ink-muted">
                  {criticalOnly ? 'No CRITICAL+ work in scope.' : 'Nothing matches this search.'}
                </p>
              )}
          </div>
        </section>

        {/* ---------------- Draft plan ---------------- */}
        <section className="rounded-card border border-line bg-surface-card p-3" aria-label="Draft plan">
          <header className="mb-2 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-ink-strong">Draft plan</h2>
            <span className="text-xs text-ink-muted">{inDraft.open === 0 ? 'nothing written yet' : `${inDraft.open} devices`}</span>
          </header>

          <div className="space-y-2">
            {lanes.map((lane) => {
              const eng = engineers.find((e) => e.engineerId === lane.seId);
              // One computation of the draft's effect on this engineer, shared by the header, the lane
              // treatment and the chips — three renderings of one fact, never three derivations of it.
              const laneAfter =
                (eng?.committed ?? 0) +
                lane.plantIds.reduce(
                  (n, id) => n + (lane.ticketOverrides?.[id]?.length ?? totals.get(id)?.openUnassigned ?? 0),
                  0,
                );
              const laneOver =
                typeof eng?.dailyCapacity === 'number' &&
                isOverCapacity({ committed: laneAfter, dailyCapacity: eng.dailyCapacity });
              const coverageFacts = eng ? laneCoverage(eng.engineerId, lane.plantIds, candidateView, plantName) : [];
              const factFor = (plantId: string) => coverageFacts.find((c) => c.plantId === plantId) ?? null;

              return (
                <div
                  key={lane.id}
                  data-testid={`lane-${lane.id}`}
                  data-over-capacity={String(laneOver)}
                  // #290 — the lane itself carries the over-capacity state, not only the number in its
                  // header. The design draws an amber lane because "this engineer is past their cap" is
                  // a fact about the whole row, and an operator scanning six lanes reads the row before
                  // they read any figure inside it. **A state, never a barrier** (#258 Q2): nothing here
                  // disables anything, and the Review & commit button stays live.
                  className={cn(
                    'rounded-md border p-2',
                    laneOver ? 'border-warning bg-warning-bg/30' : 'border-line',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <select
                      aria-label={`Engineer for lane ${lane.id}`}
                      value={lane.seId}
                      onChange={(e) =>
                        setLanes((prev) => prev.map((l) => (l.id === lane.id ? { ...l, seId: e.target.value } : l)))
                      }
                      className="min-w-0 flex-1 rounded-md border border-line px-2 py-1 text-xs"
                    >
                      <option value="">Select engineer…</option>
                      {engineers.map((e) => (
                        <option key={e.engineerId} value={e.engineerId}>
                          {engineerOptionLabel(e)}
                        </option>
                      ))}
                    </select>
                    {eng && (
                      <LoadBadge seId={eng.engineerId} committed={eng.committed ?? 0} dailyCapacity={eng.dailyCapacity} />
                    )}
                  </div>

                  {/* #274 — coverage per (engineer, plant) and the load this draft would add. Both are
                      states the dispatcher reads before committing, and neither is a gate. */}
                  {eng && lane.plantIds.length > 0 && (
                    <LaneHeader
                      seId={eng.engineerId}
                      coverage={laneCoverage(eng.engineerId, lane.plantIds, candidateView, plantName)}
                      committed={eng.committed ?? 0}
                      after={
                        (eng.committed ?? 0) +
                        lane.plantIds.reduce(
                          (n, id) => n + (lane.ticketOverrides?.[id]?.length ?? totals.get(id)?.openUnassigned ?? 0),
                          0,
                        )
                      }
                      dailyCapacity={typeof eng.dailyCapacity === 'number' ? eng.dailyCapacity : null}
                    />
                  )}

                  <div className="mt-2 flex flex-wrap gap-1">
                    {lane.plantIds.map((plantId) => {
                      const t = totals.get(plantId);
                      const override = lane.ticketOverrides?.[plantId];
                      const name =
                        view?.companies.flatMap((c) => c.plants).find((p) => p.plantId === plantId)?.plantName ??
                        `Plant ${plantId}`;
                      const fact = factFor(plantId);
                      const placed = override ? override.length : (t?.openUnassigned ?? 0);
                      /**
                       * #290 AC3 — critical work is its **own chip**, as the design draws it
                       * (`Kotputli Works ×3 crit` beside `Kotputli Works ×1`). One chip totalling both
                       * hides the only number a dispatcher triages by: a plant reading `×15` says
                       * nothing about whether any of it is on a clock.
                       *
                       * The split is suppressed when a strategy handed this lane only part of the
                       * plant (#276's `ticketOverrides`): the plant's critical count is a fact about
                       * the *plant*, and asserting it of an arbitrary subset would be a fabricated
                       * number — exactly what #282 R6 forbids.
                       */
                      const critical = override ? 0 : Math.min(t?.criticalCount ?? 0, placed);
                      const remainder = placed - critical;
                      const remove = () =>
                        setLanes((prev) =>
                          prev.map((l) =>
                            l.id === lane.id ? { ...l, plantIds: l.plantIds.filter((p) => p !== plantId) } : l,
                          ),
                        );
                      /**
                       * The remove control belongs to the **plant**, not to a chip, so exactly one is
                       * rendered even when the plant splits into a critical chip and a remainder. Two
                       * buttons doing the identical thing to the identical object would claim a
                       * granularity the draft does not have — a lane holds plants, and there is no way
                       * to drop "the critical half" of one. (It also produced two controls with the
                       * same accessible name, which is how the suite found this.)
                       */
                      const chip = (opts: {
                        testId: string;
                        meaning: ReturnType<typeof chipMeaning>;
                        qty: string;
                        removable: boolean;
                      }) => (
                        <span
                          key={opts.testId}
                          data-testid={opts.testId}
                          data-tier-crossing={String(fact?.tierCrossing ?? false)}
                          title={`${formatPlantDisplayName(name)} — ${CHIP_MEANING_LABEL[opts.meaning]}`}
                          className={cn(
                            'inline-flex items-center gap-1 rounded-md bg-surface px-2 py-0.5 text-[11px]',
                            CHIP_FORM[opts.meaning],
                          )}
                        >
                          {/* The dot is the grammar's own mark for "inside the engineer's own
                              coverage"; a critical chip carries a flag instead, so the two are
                              distinguishable with the colour removed. */}
                          {opts.meaning === 'CRITICAL' ? (
                            <span aria-hidden>⚑</span>
                          ) : (
                            <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
                          )}
                          {formatPlantDisplayName(name)}
                          <span className="tabular-nums opacity-80">
                            ×{opts.qty}
                            {/* #276 — a strategy that only handed part of this plant's work here, said out loud. */}
                            {override && ` of ${t?.openUnassigned ?? '?'}`}
                          </span>
                          {opts.removable && (
                            <button
                              type="button"
                              aria-label={`Remove ${name} from lane ${lane.id}`}
                              onClick={remove}
                              className="opacity-70 hover:opacity-100"
                            >
                              ×
                            </button>
                          )}
                        </span>
                      );
                      const base = chipMeaning({
                        critical: false,
                        tierCrossing: fact?.tierCrossing ?? false,
                        noCoverage: fact?.coverageType === null && fact !== null,
                      });
                      const showRemainder = remainder > 0 || critical === 0;
                      return (
                        <span key={plantId} className="contents">
                          {critical > 0 &&
                            chip({
                              testId: `chip-${lane.id}-${plantId}-critical`,
                              meaning: 'CRITICAL',
                              qty: `${critical} crit`,
                              removable: !showRemainder,
                            })}
                          {showRemainder &&
                            chip({
                              testId: `chip-${lane.id}-${plantId}`,
                              meaning: base,
                              qty: String(remainder),
                              removable: true,
                            })}
                        </span>
                      );
                    })}
                    <Button size="sm" variant="ghost" disabled={selected.size === 0} onClick={() => addToDraft(lane.id)}>
                      Add to draft
                    </Button>
                  </div>
                </div>
              );
            })}

            <Button size="sm" variant="ghost" onClick={addLane}>
              + Add engineer lane
            </Button>

            {/* #290 AC4 — the legend the design puts beneath the lanes, drawn from the same `CHIP_FORM`
                table the chips above use, so it can never describe a border they stopped using. */}
            <GrammarLegend />

            {/*
              #276 required-change 4 / the approved design's "No eligible engineer" rail. Work the
              projection could not place sits **in the draft column**, not in the panel that reported
              it — a dispatcher who closes Distribute has not solved the coverage gap, and a console
              that dropped it here would be under-reporting its own residual on the one screen whose
              job is to answer "what is left".

              Dashed, muted and un-actionable by design: these chips are not draggable and carry no
              Assign button, because nothing in this selection *can* take them. The fix is coverage or
              a freed-up engineer, not another click here.
            */}
            {unplacedGroups.length > 0 && (
              <div
                data-testid="unplaced-rail"
                className="rounded-md border border-dashed border-critical/60 bg-surface-card p-2"
              >
                <div
                  data-testid="unplaced-rail-total"
                  className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.08em] text-critical"
                >
                  No eligible engineer · {unplacedVisible.length} device{unplacedVisible.length === 1 ? '' : 's'}
                </div>
                <div className="flex flex-wrap gap-1">
                  {unplacedGroups.map((g) => (
                    <span
                      key={`${g.plantId}-${g.reason}`}
                      data-testid={`unplaced-${g.plantId}-${g.reason}`}
                      className="inline-flex items-center gap-1 rounded-full border border-dashed border-line-strong px-2 py-0.5 text-[11px] text-ink-muted"
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          'h-1.5 w-1.5 shrink-0 rounded-full',
                          g.reason === 'NO_COVERAGE' ? 'bg-critical' : 'bg-warning',
                        )}
                      />
                      {formatPlantDisplayName(plantName(g.plantId))}
                      <span className="tabular-nums">×{g.count}</span>
                      <span>· {UNPLACED_REASON_TEXT[g.reason]}</span>
                    </span>
                  ))}
                </div>
                <p className="mt-1.5 text-[11px] text-ink-muted">
                  Not in the draft and not committed. “No coverage” means none of the engineers you chose
                  covers that plant; “all dropped” means they do and every one failed a readiness check.
                </p>
              </div>
            )}
          </div>
        </section>

        {/* ---------------- Candidates (#274) ---------------- */}
        <CandidateColumn plant={focusedCandidates} loading={candidatesLoading} onAssign={assignCandidate} />
      </div>

      {distributing && (
        <DistributePanel
          plantIds={selectedPlantIds}
          plantName={plantName}
          engineers={engineers}
          resolveTicketIds={async (ids) => (await apiAssignableTickets(ids)).flatMap((r) => r.ticketIds)}
          onAddToDraft={addDistributeResultToDraft}
          onClose={() => setDistributing(false)}
        />
      )}

      <footer className="mt-4 flex flex-wrap items-center gap-2 rounded-card border border-line bg-surface-card p-3 text-sm">
        <span>
          <b className="text-ink-strong">{inDraft.open} devices</b> → {readyLanes.length} engineers ·{' '}
          {drafted.size} plants
        </span>
        <span className="ml-auto flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={selectedPlantIds.length === 0}
            onClick={() => setDistributing(true)}
          >
            Distribute across selected engineers…
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={drafted.size === 0 && unplacedVisible.length === 0}
            onClick={clearDraft}
          >
            Clear draft
          </Button>
          <Button size="sm" disabled={readyLanes.length === 0 || reviewing} loading={reviewing} onClick={() => void openReview()}>
            Review &amp; commit
          </Button>
        </span>
      </footer>
    </div>
  );
}
