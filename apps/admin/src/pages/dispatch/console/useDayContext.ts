import { useEffect, useRef, useState } from 'react';
import { apiListSchedules } from '../../../api/schedules';
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

export interface DayCounts {
  /** Committed plan counts keyed by seId, for the engineers on this zone's roster. */
  bySe: Record<string, { stops: number; devices: number }>;
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

export interface DayContext {
  counts: Record<string, DayCounts>;
  projection: Record<string, DayProjection>;
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
    }

    let live = true;
    const rosterSet = new Set(roster.split(',').filter(Boolean));

    for (const day of daysKey.split('|').filter(Boolean)) {
      if (semanticOf(day, today) === 'today') continue;
      const key = `counts|${gen}|${day}`;
      if (requested.current.has(key)) continue;
      requested.current.add(key);
      setCounts((p) => ({ ...p, [day]: { bySe: {}, others: NO_COUNTS, state: 'loading' } }));
      void apiListSchedules(day)
        .then((rows) => {
          if (!live || generation.current !== gen) return;
          const bySe: DayCounts['bySe'] = {};
          const others = { engineers: 0, stops: 0, devices: 0 };
          for (const r of rows.filter((row) => String(row.zoneId) === String(zoneId))) {
            if (rosterSet.has(r.seId)) {
              const cur = bySe[r.seId] ?? { stops: 0, devices: 0 };
              bySe[r.seId] = { stops: cur.stops + r.batchCount, devices: cur.devices + r.ticketCount };
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

  return { counts, projection };
}
