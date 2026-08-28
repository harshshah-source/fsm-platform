import { useCallback, useEffect, useRef, useState } from 'react';
import {
  apiDispatchChangesToday,
  apiDispatchToday,
  type DispatchChangesTodayView,
  type DispatchTodayView,
} from '../../../api/dispatchToday';

/**
 * **The single lifted fetch** — Scheduler Console §8.4, and the one architectural addition the Console
 * needs that no page before it needed.
 *
 * The admin app has no query cache: fetching is per-component and a mutation refetches one or two
 * reads by hand. That is survivable on a page with one pane. The Console has four regions — People
 * rail, board, Work rail, Inspector — reading *overlapping slices of the same payload*, and the moment
 * an override commits, a hand-rolled refresh updates whichever pane remembered to ask. The rest go
 * stale silently, and two panes disagreeing about an engineer's committed load is precisely the class
 * of defect #269 exists to prevent.
 *
 * So the contract here is deliberately narrow and deliberately mandatory:
 *
 * 1. `GET /dispatch/today` is fetched **once**, by the shell, and every region reads that one object.
 * 2. **Every mutation calls `invalidate()`.** Not "refreshes its own pane" — invalidates the fetch.
 *    There is no supported path by which a region refetches independently.
 *
 * This is one hook, not a caching library. It is enough because the Console has exactly one query key
 * (`zoneId`) and one read that matters; reaching for a cache library to express that would be a larger
 * change with no additional guarantee.
 *
 * **The change ledger is fetched alongside but graded differently.** It is secondary content, so its
 * failure sets `changes` to null and leaves the deck standing — a rail that cannot load must not take
 * the operating day down with it. The primary read's failure *is* the page's failure and is reported
 * as such.
 */
export interface ConsoleData {
  view: DispatchTodayView | null;
  changes: DispatchChangesTodayView | null;
  loading: boolean;
  error: string | null;
  /**
   * Refetch the payload every region reads. **Call this after any write**, including writes issued
   * from the Inspector — it is the only supported way to make a mutation visible.
   */
  invalidate: () => void;
  /** Bumped on every completed invalidation; a region can key an effect on it without refetching. */
  version: number;
}

export function useConsoleData(
  zoneId: string | undefined,
  /**
   * `false` suspends the fetch entirely — used while a CSM/OH has not yet named a zone.
   *
   * This is not an optimisation. `GET /dispatch/today` **refuses** to guess a zone for a multi-zone
   * role, so calling it with no `zoneId` is a guaranteed `400 ZONE_REQUIRED` — the very failure the
   * zone chooser exists to prevent. Firing it anyway would put an error in the network log every time
   * a CSM opens the Console, and would race the chooser's first real fetch.
   */
  enabled = true,
): ConsoleData {
  const [view, setView] = useState<DispatchTodayView | null>(null);
  const [changes, setChanges] = useState<DispatchChangesTodayView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  // A request counter rather than a boolean: an invalidation fired while a slower earlier fetch is
  // still in flight must not have that earlier response land on top of it. Comparing sequence numbers
  // discards the stale one; an `alive` flag alone cannot, because both requests are "alive".
  const seq = useRef(0);

  const fetchAll = useCallback(() => {
    const mine = ++seq.current;
    if (!enabled) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);

    void apiDispatchToday(zoneId)
      .then((v) => {
        if (seq.current !== mine) return;
        setView(v);
        setVersion((n) => n + 1);
      })
      .catch((e: Error) => {
        if (seq.current !== mine) return;
        // The zone is cleared on failure so a CSM who picked a zone they cannot read does not keep
        // staring at the previous zone's deck under the new zone's name.
        setView(null);
        setError(e.message || 'Failed to load the operating day');
      })
      .finally(() => {
        if (seq.current === mine) setLoading(false);
      });

    void apiDispatchChangesToday(zoneId)
      .then((c) => seq.current === mine && setChanges(c))
      .catch(() => seq.current === mine && setChanges(null));
  }, [zoneId, enabled]);

  useEffect(() => {
    fetchAll();
    // Cancel in-flight responses on unmount/zone change by moving the counter past them.
    return () => {
      seq.current++;
    };
  }, [fetchAll]);

  return { view, changes, loading, error, invalidate: fetchAll, version };
}
