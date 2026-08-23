import { Prisma } from '../generated/prisma/client';
import { type SlaPauseReason } from '../generated/prisma/enums';
import { transitionOrConflict } from '../common/transition-or-conflict';

/**
 * #271 — the ONE fold-and-resume implementation, extracted from three near-identical spellings
 * (`vehicle-return-resume.service.ts`, `component-request.service.ts`, `vehicle-unavailability.service.ts`)
 * and now shared by those three plus the two new callers this issue adds
 * (`troubleshoot-submission.service.ts`, `verification.service.ts`).
 *
 * **What "fold" means.** A Failure Cycle's primary SLA clock is `opened_at` plus wall-clock, minus
 * every interval it has ever been paused. A pause is "open" while `sla_paused_at` is set; ending it
 * folds `now - sla_paused_at` into the running total (`sla_accumulated_pause_seconds`) and clears the
 * pause columns. Skipping the fold — clearing `sla_paused` without adding the interval — is the #247
 * AC2/component-unavailable overwrite bug this issue exists to close: the seconds the pause actually
 * ran simply vanish from the accounting.
 *
 * **Reason-guarded by default.** `onlyReason`, when given, refuses to touch a pause standing for any
 * OTHER reason — the #247 AC1 asymmetry fix (a vehicle-side writer must never clear a
 * `WAITING_COMPONENT` pause) generalised to every caller. Omit it only where the caller's own domain
 * already guarantees which pause it owns (the component-request receipt/resubmit resume, which fires
 * exactly where a `WAITING_COMPONENT` pause is the only kind that flow can have opened) or where the
 * check is meant to be generic (the verification terminal backstop, which must clear a pause of ANY
 * reason that should not exist on closed work).
 *
 * **Race-safe by construction, not by locking.** The write is a {@link transitionOrConflict} guarded
 * `updateMany` keyed on the exact `(slaPaused: true, slaPausedAt: <value just read>)` — plus
 * `slaPauseReason` when `onlyReason` is set — so a concurrent resume of the SAME pause (submission
 * racing the nightly sweep, the sweep racing a manual resume) can win at most once: the loser's guard
 * matches zero rows, it reports `resumed: false, addedSeconds: 0`, and folds nothing. This is the same
 * pattern `intraday-insertion.service.ts` uses for its Accept/Reroute race — a `find → act` idiom under
 * READ COMMITTED lets two callers both pass the JS check, and only a WHERE-clause guard lets the
 * database pick the single winner.
 *
 * Always called with the surrounding write's own transaction client, so the read and the guarded write
 * commit atomically with whatever else that writer is doing (re-pausing for a different reason,
 * transitioning the ticket, writing the caller's own audit row).
 */
export interface SlaFoldResult {
  /** True iff THIS call performed the fold — either it found nothing to race, or it won the race. */
  resumed: boolean;
  /** Seconds folded into `sla_accumulated_pause_seconds`. Always 0 when `resumed` is false. */
  addedSeconds: number;
}

export async function foldAndResumeSlaPause(
  tx: Pick<Prisma.TransactionClient, 'failureCycle'>,
  cycleId: string,
  now: Date,
  opts: { onlyReason?: SlaPauseReason } = {},
): Promise<SlaFoldResult> {
  const cycle = await tx.failureCycle.findUnique({
    where: { cycleId },
    select: { slaPaused: true, slaPausedAt: true, slaPauseReason: true, slaAccumulatedPauseSeconds: true },
  });
  if (!cycle || !cycle.slaPaused || !cycle.slaPausedAt) return { resumed: false, addedSeconds: 0 };
  if (opts.onlyReason && cycle.slaPauseReason !== opts.onlyReason) return { resumed: false, addedSeconds: 0 };

  const addedSeconds = Math.floor((now.getTime() - cycle.slaPausedAt.getTime()) / 1000);
  const { won } = await transitionOrConflict(
    tx.failureCycle,
    {
      cycleId,
      slaPaused: true,
      slaPausedAt: cycle.slaPausedAt,
      ...(opts.onlyReason ? { slaPauseReason: opts.onlyReason } : {}),
    },
    {
      slaPaused: false,
      slaPauseReason: null,
      slaPausedAt: null,
      slaPauseSource: null,
      slaAccumulatedPauseSeconds: cycle.slaAccumulatedPauseSeconds + BigInt(addedSeconds),
    },
  );
  return won ? { resumed: true, addedSeconds } : { resumed: false, addedSeconds: 0 };
}
