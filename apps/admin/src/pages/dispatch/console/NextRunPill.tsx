import { useEffect, useState } from 'react';
import { getDispatchSchedule } from '../../../api/dispatchSchedule';

/**
 * **When the next run fires** (Scheduler Console B2).
 *
 * The question this answers is a real one a Zonal Manager could not previously ask anywhere:
 * *"why is my deck empty at 04:55?"* The run hour is **configurable** — an Operations Head can move it
 * and the job re-registers without a restart — so it cannot be inferred from a constant, and
 * `GET /schedules/dispatch-schedule` was the only place it is published. That endpoint was OH-only,
 * which left a hole in the ZM's own primary screen. B2 widened the **read** to the three manager roles
 * and left the write where it was: knowing when the run fires and being able to move it are different
 * permissions, and only the first was the gap.
 *
 * **It degrades to absent, never to a guess.** A role that still cannot read the schedule, or a
 * backend that predates the widening, renders nothing at all. A hard-coded "05:00" here would be a
 * fabricated answer to precisely the question this exists to answer truthfully.
 */
export function NextRunPill() {
  const [nextFireAt, setNextFireAt] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void getDispatchSchedule()
      .then((s) => live && setNextFireAt(s.nextFireAt))
      .catch(() => live && setNextFireAt(null));
    return () => {
      live = false;
    };
  }, []);

  if (!nextFireAt) return null;
  const when = new Date(nextFireAt);
  if (Number.isNaN(when.getTime())) return null;

  const today = when.toDateString() === new Date().toDateString();

  return (
    <span data-testid="console-next-run" className="text-[11px] text-ink-muted">
      Next run{' '}
      <span className="tabular-nums text-ink">
        {when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </span>
      {/* Said out loud when it is not today's — "next run 05:00" on a deck at 23:00 reads as
          "in five minutes" unless the day is named. */}
      {!today && ` ${when.toLocaleDateString([], { day: 'numeric', month: 'short' })}`}
    </span>
  );
}
