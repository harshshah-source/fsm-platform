import { useEffect, useRef, useState } from 'react';
import { apiDispatchCardSummaries, type CardSummary } from '../../../api/dispatchToday';
import { apiListSchedules, type ScheduleRowStop } from '../../../api/schedules';
import { getSchedulerPreview, type ZoneProjection } from '../../../api/schedulerPreview';
import { semanticOf } from './dayAxis';

/**
 * **Per-day context for the board's non-today columns** (composition correction §6).
 *
 * Today's column reads the one lifted `GET /dispatch/today` payload and nothing here. Every other
 * visible column reads the source that can honestly answer for its day:
 *
 * - **Committed counts** (`GET /schedules?date=`) for every past *and* future column. A past day
 *   renders at count fidelity — `batchCount`/`ticketCount` per engineer is the whole of what any
 *   existing read returns for it, and rendering counts *as counts* is honest where a chip board
 *   would be an invention (correction §6.3 rule 5). A future day's committed rows also win over its
 *   projection (§6.3 rule 3): where a live `WorkSchedule` already covers the date, that column is
 *   committed, not conditional.
 * - **The projection** (`GET /schedules/preview?date=`) for the **focused future day only**. The
 *   preview runs the real recommender with writes suppressed — it is the honest source for "would
 *   be assigned", and it is also the most expensive read the Console can issue, so context columns
 *   do not fire it. They render committed counts plus an explicit "focus to project" affordance,
 *   and the ghost chips arrive when the operator actually asks for that day.
 *
 * Responses are cached per `(zone, day)` and the whole cache drops on `version` — the lifted
 * fetch's invalidation counter — because a committed override can change any day's committed rows.
 */

/** One engineer's committed work on a non-today day: the counts, and the stops behind them. */
export interface DayCommitment {
  stops: number;
  devices: number;
  /**
   * The stops themselves, so a future column can draw the work rather than only count it.
   *
   * **Why this is here now.** A cross-day move writes a real `work_schedules` row for the target day,
   * and an operator who has just dropped a ticket onto Wednesday has to see *that ticket* in that
   * cell. `1 stop · 1 device` is true and is not an answer: it is indistinguishable from any other
   * stop appearing, which is how the old defer's silence felt like being ignored. The rows come from
   * the same `GET /schedules?date=` this column already fetched — `detail=stops` widens the select on
   * rows the count path walked anyway, so this costs no additional request.
   */
  plan: ScheduleRowStop[];
}

export interface DayCounts {
  /** Committed plan counts keyed by seId, for the engineers on this zone's roster. */
  bySe: Record<string, DayCommitment>;
  /**
   * Committed rows for engineers *not* on today's roster. Dropped silently they would make a past
   * day look lighter than it was — the row count is a fact about that day, not about today's roster.
   */
  others: { engineers: number; stops: number; devices: number };
  state: 'loading' | 'loaded' | 'failed';
}

export interface DayProjection {
  projection: ZoneProjection | null;
  state: 'loading' | 'loaded' | 'failed';
}

/**
 * #295 — identity for the cards on one committed future column, fetched **once for the column**.
 *
 * `GET /schedules?date=&detail=stops` hands this column its ticket ids and nothing physical, so
 * without this the choice is an eight-character hash or one request per card. The `state` is
 * rendered, not hidden: a column that could not read its enrichment falls back to the compact
 * committed chip rather than a card frame with five blank rows.
 */
export interface DaySummaries {
  byTicket: Record<string, CardSummary>;
  state: 'loading' | 'loaded' | 'failed';
}

export interface DayContext {
  counts: Record<string, DayCounts>;
  projection: Record<string, DayProjection>;
  summaries: Record<string, DaySummaries>;
}

const NO_COUNTS: DayCounts['others'] = { engineers: 0, stops: 0, devices: 0 };

export function useDayContext(
  zoneId: string,
  days: string[],
  today: string,
  focused: string,
  /** The roster the board renders — used to split committed rows into `bySe` vs `others`. */
  rosterSeIds: string[],
  /** The lifted fetch's invalidation counter; a bump drops the cache so no column shows stale state. */
  version: number,
): DayContext {
  const [counts, setCounts] = useState<Record<string, DayCounts>>({});
  const [projection, setProjection] = useState<Record<string, DayProjection>>({});
  const [summaries, setSummaries] = useState<Record<string, DaySummaries>>({});
  /** Whether this hook is still mounted. See the summaries effect for why it is not a per-effect flag. */
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  /** Which `(zone, version, day)` fetches have been issued — the cache-identity guard. */
  const requested = useRef(new Set<string>());
  const generation = useRef('');

  const roster = rosterSeIds.join(',');
  const daysKey = days.join('|');

  useEffect(() => {
    const gen = `${zoneId}|${version}`;
    if (generation.current !== gen) {
      generation.current = gen;
      requested.current.clear();
      setCounts({});
      setProjection({});
      setSummaries({});
    }

    let live = true;
    const rosterSet = new Set(roster.split(',').filter(Boolean));

    for (const day of daysKey.split('|').filter(Boolean)) {
      if (semanticOf(day, today) === 'today') continue;
      const key = `counts|${gen}|${day}`;
      if (requested.current.has(key)) continue;
      requested.current.add(key);
      setCounts((p) => ({ ...p, [day]: { bySe: {}, others: NO_COUNTS, state: 'loading' } }));
      // `detail=stops` on every non-today column, not only the focused one. The stops ride along on
      // rows this request already returns, so the cheap-context-column bargain (§6.3 rule 5) is
      // untouched — what the column *renders* still depends on focus; what it *knows* no longer has to.
      void apiListSchedules(day, 'stops')
        .then((rows) => {
          if (!live || generation.current !== gen) return;
          const bySe: DayCounts['bySe'] = {};
          const others = { engineers: 0, stops: 0, devices: 0 };
          for (const r of rows.filter((row) => String(row.zoneId) === String(zoneId))) {
            if (rosterSet.has(r.seId)) {
              const cur = bySe[r.seId] ?? { stops: 0, devices: 0, plan: [] };
              bySe[r.seId] = {
                stops: cur.stops + r.batchCount,
                devices: cur.devices + r.ticketCount,
                // An engineer can hold more than one live schedule covering a day (a multi-day plan
                // beside a single-day one), so the stops accumulate rather than replace.
                plan: [...cur.plan, ...(r.stops ?? [])],
              };
            } else {
              others.engineers += 1;
              others.stops += r.batchCount;
              others.devices += r.ticketCount;
            }
          }
          setCounts((p) => ({ ...p, [day]: { bySe, others, state: 'loaded' } }));
        })
        .catch(() => {
          if (!live || generation.current !== gen) return;
          setCounts((p) => ({ ...p, [day]: { bySe: {}, others: NO_COUNTS, state: 'failed' } }));
        });
    }

    // The projection: the focused future day only — see this file's docblock.
    if (semanticOf(focused, today) === 'future') {
      const key = `projection|${gen}|${focused}`;
      if (!requested.current.has(key)) {
        requested.current.add(key);
        setProjection((p) => ({ ...p, [focused]: { projection: null, state: 'loading' } }));
        void getSchedulerPreview(focused)
          .then((res) => {
            if (!live || generation.current !== gen) return;
            const zone = res.zones.find((z) => String(z.zoneId) === String(zoneId)) ?? null;
            setProjection((p) => ({ ...p, [focused]: { projection: zone, state: 'loaded' } }));
          })
          .catch(() => {
            if (!live || generation.current !== gen) return;
            setProjection((p) => ({ ...p, [focused]: { projection: null, state: 'failed' } }));
          });
      }
    }

    return () => {
      live = false;
    };
  }, [zoneId, daysKey, today, focused, roster, version]);

  /**
   * #295 — **one batched identity read for the focused committed-future column.**
   *
   * A separate effect, keyed on *focus* rather than chained onto the counts response, and that is the
   * whole point. Counts are cached per `(zone, version, day)` and fetched once for every visible
   * column, so by the time an operator clicks tomorrow its rows are already in hand and no request is
   * re-issued. Enrichment hung off the counts arriving would therefore fire only for a day that was
   * *already* focused when its counts loaded — a column reached by deep link would show cards while
   * the same column reached by clicking it showed compact chips for ever. One screen, disagreeing
   * with itself about what it knows.
   *
   * **Focused only**, which is composition rule 5 unchanged: a context column stays a strip of counts,
   * so the expensive question is asked about the day the operator is actually looking at. Past columns
   * never reach here at all — their fidelity is counts by design, and painting today's live
   * inactivity onto a day that has already happened would fabricate historical operational state.
   */
  useEffect(() => {
    if (semanticOf(focused, today) !== 'future') return;
    const day = counts[focused];
    if (day?.state !== 'loaded') return;

    const gen = `${zoneId}|${version}`;
    const key = `summaries|${gen}|${focused}`;
    if (requested.current.has(key)) return;

    const ticketIds = [
      ...new Set(
        Object.values(day.bySe)
          .flatMap((c) => c.plan)
          .flatMap((s) => s.tickets.map((t) => t.ticketId)),
      ),
    ];
    if (ticketIds.length === 0) return;

    requested.current.add(key);
    setSummaries((p) => ({ ...p, [focused]: { byTicket: {}, state: 'loading' } }));
    void apiDispatchCardSummaries(ticketIds, zoneId)
      .then((rows) => {
        if (!mounted.current || generation.current !== gen) return;
        setSummaries((p) => ({
          ...p,
          [focused]: { byTicket: Object.fromEntries(rows.map((r) => [r.ticketId, r])), state: 'loaded' },
        }));
      })
      .catch(() => {
        if (!mounted.current || generation.current !== gen) return;
        // The column keeps its compact chips. Reduced is honest; blank card rows are not.
        setSummaries((p) => ({ ...p, [focused]: { byTicket: {}, state: 'failed' } }));
      });

    /**
     * **No per-effect cancel flag here, deliberately** — and this is the bug that taught it.
     *
     * `counts` is a dependency, and every *other* visible column calls `setCounts` as its own request
     * lands, replacing that object. A `let live = true` cleared in this effect's cleanup would then be
     * cleared by an unrelated column resolving a moment later, and the summaries response — already in
     * flight and perfectly valid — would be thrown away. The column showed compact chips for ever,
     * intermittently, depending on which day's fetch won the race.
     *
     * The two guards that are actually about staleness do the work instead: `generation` invalidates
     * on a zone or version change (the only events that make an answer wrong), and `requested`
     * prevents a duplicate request. `mounted` covers teardown.
     */
  }, [zoneId, focused, today, counts, version]);

  return { counts, projection, summaries };
}
