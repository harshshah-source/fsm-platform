import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { apiAssignableWork, type AssignableWorkView } from '../../api/assignWork';
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
import { isOverCapacity } from '../../lib/capacity';
import { laneCoverage } from './LaneCoverage';
import type { ReviewLane } from './ReviewCommitScreen';

/**
 * **The assign draft — the state machine, with no opinion about layout** (#273–#277, #290; approved
 * direction #272).
 *
 * Lifted out of `AssignWorkspace` on 2026-08-31 so the Scheduler Console could render the draft in
 * *its own* composition (`docs/audits/scheduler-console-ui-composition-correction.md` §10) without
 * owning a second copy of it. The reasoning is the same one that lifted the workspace out of
 * `AssignConsolePage` in the first place, one layer down:
 *
 * > A second copy of a state machine whose entire contract is "nothing is written until commit" is
 * > the one duplication this programme cannot afford: the two would diverge, and the half that
 * > diverged would be the half that writes.
 *
 * So there are now **two layouts over one machine** — `AssignWorkspace` (the standalone `/assign`
 * page, pan-India per §14 **D4**) and `console/AssignBoard` (the Console's Assign mode, zone-scoped
 * and composed onto the Console's own three regions). Every semantic below is shared by both, and
 * neither can change one without changing the other:
 *
 *  - **Nothing is written until {@link AssignDraft.commitBatch}** (#272 R2). Entering review resolves
 *    ticket ids — a read — and writes nothing.
 *  - **The draft is session-local** (#272 Q2, ruled). It is React state; leaving loses it.
 *  - **The commit is per-lane, never atomic** (#272 R8): `assign-batch` runs one transaction per
 *    engineer and answers with one result row per engineer.
 *  - **The unit of the write is the plant**, because `assignableTickets` is plant-shaped — except
 *    where Distribute placed only part of one, which keeps explicit `ticketOverrides` (#276).
 *  - **Nothing here is a gate.** Over capacity, a crossed tier and no coverage are all *states* the
 *    operator reads before committing (#258 Q2 — manual overload is an administrative right).
 *
 * Everything in this file was moved rather than rewritten; the comments are the originals, because
 * they record decisions rather than describe code.
 */

/** The unit of selection. A plant serves several companies, so neither id alone identifies a row. */
export const rowKey = (companyId: string, plantId: string) => `${companyId}:${plantId}`;

/**
 * #351 AC6 — the one spelling of the Critical+ console preset, exported so the surface that links to
 * it and the hook that reads it cannot drift apart.
 *
 * #277 removed the ZM dashboard's own critical queue on purpose — `/assign` is the single manual
 * assignment surface (#272 R1) — but left no way back: the dashboard simply stopped mentioning that
 * critical work existed. The Critical+ summary tile links here, and the draft opens with its pool
 * already narrowed to plants carrying CRITICAL+ work, which is the filter `criticalOnly` has applied
 * since #277 absorbed the queue's grouping into it.
 */
const CRITICAL_PLUS_FILTER = 'critical-plus';
export const ASSIGN_CRITICAL_PLUS_PRESET_PATH = `/assign?filter=${CRITICAL_PLUS_FILTER}`;

export interface Lane {
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

/** Per-plant aggregates over the pool, folded across the companies that share a site. */
export interface PlantTotal {
  openUnassigned: number;
  criticalCount: number;
  companies: Set<string>;
}

/**
 * Every company row folded down to the **plant**, because `assignPlants` is plant-shaped: it moves all
 * of a plant's assignable work regardless of which company's row was ticked.
 *
 * This is the slice's one sharp edge and it is surfaced rather than hidden. Drafting UltraTech's 4
 * devices at a site it shares with Acme commits Acme's 6 as well, so the ledger has to count 10 — a
 * draft that counted only the ticked row would under-report its own commit, which is the failure R3
 * exists to prevent, reappearing one layer up.
 */
export function plantTotals(view: AssignableWorkView | null): Map<string, PlantTotal> {
  const totals = new Map<string, PlantTotal>();
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

export interface UseAssignDraftOptions {
  /**
   * Narrow the pool and its ledger to this zone (§14 **D4**). Omitted — `/assign`'s case — the pool
   * is whatever scope the caller's own claims and acting header give them.
   */
  zoneId?: string | null;
  /**
   * The lane targets. Omitted, the draft reads `GET /schedules/engineers` itself.
   *
   * The Console passes its own roster instead, and the reason is the same one behind `zoneId`: that
   * route is **also** pan-India for a CSM who is not acting in a zone, so it would offer another
   * zone's engineers as lane targets for this zone's work.
   */
  engineers?: ZoneEngineer[];
  /**
   * A commit landed. The draft always reloads its own pool; this is for a caller that has other
   * state to invalidate — the Console's single lifted `GET /dispatch/today` (§8.4), whose board must
   * already show the work the operator just handed out when they leave Assign mode.
   */
  onCommitted?: () => void;
}

export type AssignDraft = ReturnType<typeof useAssignDraft>;

export function useAssignDraft({ zoneId = null, engineers: engineersProp, onCommitted }: UseAssignDraftOptions = {}) {
  const [searchParams] = useSearchParams();
  const [view, setView] = useState<AssignableWorkView | null>(null);
  const [fetchedEngineers, setFetchedEngineers] = useState<ZoneEngineer[]>([]);
  const ownsRoster = engineersProp === undefined;
  const engineers = engineersProp ?? fetchedEngineers;
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  /** #277 — absorbs `CriticalQueue`'s grouping into a pool filter; the `criticalCount` badge already
   *  on every row is the same cluster-size signal that component uniquely carried.
   *
   *  #351 — `?filter=critical-plus` **seeds** it. Read once, in a lazy initialiser, rather than
   *  synced to the URL on every render: the preset is where the operator arrives, not a cage. A ZM
   *  who follows the dashboard's Critical+ tile and then unticks the filter must stay unticked. */
  const [criticalOnly, setCriticalOnly] = useState(
    () => searchParams.get('filter') === CRITICAL_PLUS_FILTER,
  );
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
   * unexpected shape must cost the operator the column and nothing else.
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

  // `totals` optional-chained as well as `view`: an unexpected body on the pool read must cost the
  // ledger its figure, not take the whole console down on the first render.
  const openTotal = view?.totals?.openUnassigned ?? 0;

  const matches = useCallback(
    (company: string, plantName: string, criticalCount: number) => {
      if (criticalOnly && criticalCount === 0) return false;
      const term = search.trim().toLowerCase();
      if (!term) return true;
      return company.toLowerCase().includes(term) || plantName.toLowerCase().includes(term);
    },
    [criticalOnly, search],
  );

  const toggle = useCallback(
    (key: string) =>
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      }),
    [],
  );

  /** Move the ticked rows into a lane, as plants — the unit the commit will use. */
  const addToDraft = useCallback(
    (laneId: number) => {
      const plantIds = [...selected].map((k) => k.split(':')[1]);
      setLanes((prev) =>
        prev.map((l) =>
          l.id === laneId ? { ...l, plantIds: [...new Set([...l.plantIds, ...plantIds])] } : l,
        ),
      );
      setSelected(new Set());
    },
    [selected],
  );

  /**
   * Put an engineer on a lane holding these plants — the one path both layouts place work through.
   *
   * Reuses the engineer's existing lane if they already have one, otherwise the first empty lane,
   * otherwise a new one. A second lane for the same engineer would split their load across two rows
   * and make the `→ after / cap` figure on each of them a lie.
   *
   * **Never refused**, whatever the candidate's verdict: the engine's hard filters decide what
   * *dispatch* does, and #258 Q2 rules manual overload an administrative right. The row states the
   * drop and the load; the decision is the operator's.
   */
  const placeOnEngineer = useCallback((seId: string, plantIds: string[]) => {
    if (plantIds.length === 0) return;
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
            ? { ...l, seId, plantIds: [...new Set([...l.plantIds, ...plantIds])] }
            : l,
        );
      }
      opened = true;
      return [...prev, { id: nextLaneId, seId, plantIds: [...new Set(plantIds)] }];
    });
    if (opened) setNextLaneId((n) => n + 1);
  }, [nextLaneId]);

  /** #274 item 2 — the candidate column's arrow into the draft: this engineer, the focused plant. */
  const assignCandidate = useCallback(
    (seId: string) => {
      if (!focusedPlantId) return;
      placeOnEngineer(seId, [focusedPlantId]);
    },
    [focusedPlantId, placeOnEngineer],
  );

  /** Hand the ticked pool rows to this engineer — the Console layout's primary gesture. */
  const assignSelectedTo = useCallback(
    (seId: string) => {
      if (selectedPlantIds.length === 0) return;
      placeOnEngineer(seId, selectedPlantIds);
      setSelected(new Set());
    },
    [placeOnEngineer, selectedPlantIds],
  );

  const setLaneEngineer = useCallback(
    (laneId: number, seId: string) => setLanes((prev) => prev.map((l) => (l.id === laneId ? { ...l, seId } : l))),
    [],
  );

  const removePlant = useCallback(
    (laneId: number, plantId: string) =>
      setLanes((prev) =>
        prev.map((l) => (l.id === laneId ? { ...l, plantIds: l.plantIds.filter((p) => p !== plantId) } : l)),
      ),
    [],
  );

  /** Drop one engineer's whole draft lane — the Console layout's per-lane undo. */
  const clearLane = useCallback(
    (laneId: number) =>
      setLanes((prev) => {
        const next = prev.map((l) => (l.id === laneId ? { ...l, plantIds: [], ticketOverrides: undefined } : l));
        // An emptied lane with an engineer on it is a lane target the operator did not ask to keep.
        // Collapse it away unless it is the only one left, which the pool still needs somewhere to go.
        const kept = next.filter((l) => l.plantIds.length > 0);
        return kept.length > 0 ? kept : [{ id: nextLaneId, seId: '', plantIds: [] }];
      }),
    [nextLaneId],
  );

  const addLane = useCallback(() => {
    setLanes((prev) => [...prev, { id: nextLaneId, seId: '', plantIds: [] }]);
    setNextLaneId((n) => n + 1);
  }, [nextLaneId]);

  /**
   * #276 — merge a Distribute projection into the draft. It is a starting point, not a commit (R2):
   * the operator can still move chips, add plants, or drop a lane before ever reviewing.
   *
   * A plant a strategy handed over **whole** (its ticket ids match the pool's full assignable set)
   * needs no override — it behaves exactly like a manually-drafted plant, resolved fresh at review
   * time. A plant it only **partly** placed (`CAPACITY_HEADROOM` splitting a busy site, or a second
   * lane also drafted into the same plant) keeps its explicit ticket ids so the review screen commits
   * precisely what was projected, not the whole plant.
   */
  const addDistributeResultToDraft = useCallback(
    (result: DistributeResult) => {
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
    },
    [totals, nextLaneId],
  );

  /** Drop the draft *and* the rail: both describe a projection the operator has just abandoned. */
  const clearDraft = useCallback(() => {
    setLanes([{ id: nextLaneId, seId: '', plantIds: [] }]);
    setUnplaced(new Map());
    setSelected(new Set());
  }, [nextLaneId]);

  const engineerName = useCallback(
    (seId: string) => engineers.find((e) => e.engineerId === seId)?.name ?? seId,
    [engineers],
  );
  const plantName = useCallback(
    (plantId: string) =>
      view?.companies.flatMap((c) => c.plants).find((p) => p.plantId === plantId)?.plantName ?? `Plant ${plantId}`,
    [view],
  );

  /** What this lane's draft would take its engineer to — `committed + everything on the lane`. */
  const laneAfter = useCallback(
    (lane: Lane) => {
      const eng = engineers.find((e) => e.engineerId === lane.seId);
      return (
        (eng?.committed ?? 0) +
        lane.plantIds.reduce(
          (n, id) => n + (lane.ticketOverrides?.[id]?.length ?? totals.get(id)?.openUnassigned ?? 0),
          0,
        )
      );
    },
    [engineers, totals],
  );

  /**
   * #290 AC5 — what should worry you about *this draft*.
   *
   * Derived from the very same `laneCoverage` the lanes render and the same `isOverCapacity` the load
   * uses, so the summary can never disagree with the board underneath it — a rollup computed a second
   * way is a rollup that will eventually contradict its own detail.
   */
  const draftWarnings = useMemo(() => {
    let overCapacity = 0;
    let crossings = 0;
    let noCoverage = 0;
    for (const lane of lanes) {
      if (!lane.seId || lane.plantIds.length === 0) continue;
      const eng = engineers.find((e) => e.engineerId === lane.seId);
      const after = laneAfter(lane);
      if (typeof eng?.dailyCapacity === 'number' && isOverCapacity({ committed: after, dailyCapacity: eng.dailyCapacity })) {
        overCapacity += 1;
      }
      for (const c of laneCoverage(lane.seId, lane.plantIds, candidateView, plantName)) {
        if (c.coverageType === null) noCoverage += 1;
        else if (c.tierCrossing) crossings += 1;
      }
    }
    return { overCapacity, crossings, noCoverage };
  }, [lanes, engineers, candidateView, plantName, laneAfter]);

  const readyLanes = useMemo(() => lanes.filter((l) => l.seId && l.plantIds.length > 0), [lanes]);

  /**
   * Resolve each ready lane's drafted plants into the ticket ids the commit will actually move, then
   * hand the diff to the review screen (#275). Nothing is written here — #272 R2 holds until
   * {@link commitBatch}; this is a read, same as the pool and candidate reads already are.
   */
  const openReview = useCallback(async () => {
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
  }, [readyLanes, engineers, totals, engineerName, plantName, candidateView]);

  /** The one write (#275) — `assign-batch`, one transaction per lane, one result row per lane. */
  const commitBatch = useCallback(
    async (reasonCode: string) => {
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
    },
    [reviewLanes, load, onCommitted, nextLaneId],
  );

  const backToDraft = useCallback(() => {
    setReviewLanes(null);
    setBatchResults(null);
  }, []);

  /**
   * Is there anything the operator would lose by walking away? Both halves count: lanes hold work
   * they staged, and the rail holds a projection's verdict they have not acted on yet.
   */
  const isDirty = drafted.size > 0 || unplacedVisible.length > 0;

  return {
    // ── the pool ──────────────────────────────────────────────────────────────────────────────
    view,
    openTotal,
    totals,
    error,
    setError,
    search,
    setSearch,
    criticalOnly,
    setCriticalOnly,
    matches,
    selected,
    selectedPlantIds,
    toggle,
    focusedPlantId,
    setFocusedPlantId,
    focusedCandidates,
    candidateView,
    candidatesLoading,
    load,

    // ── the draft ─────────────────────────────────────────────────────────────────────────────
    engineers,
    lanes,
    readyLanes,
    drafted,
    inDraft,
    draftWarnings,
    isDirty,
    laneAfter,
    engineerName,
    plantName,
    addToDraft,
    addLane,
    setLaneEngineer,
    removePlant,
    clearLane,
    clearDraft,
    placeOnEngineer,
    assignCandidate,
    assignSelectedTo,

    // ── Distribute (#276) ─────────────────────────────────────────────────────────────────────
    distributing,
    setDistributing,
    addDistributeResultToDraft,
    unplacedVisible,
    unplacedGroups,

    // ── review and commit (#275) ──────────────────────────────────────────────────────────────
    reviewLanes,
    reviewing,
    batchResults,
    committing,
    openReview,
    commitBatch,
    backToDraft,
    /** `nextLaneId` is retained only so the two layouts agree on lane numbering in the DOM. */
    nextLaneId,
  };
}
