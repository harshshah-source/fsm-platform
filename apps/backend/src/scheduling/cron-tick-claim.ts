import * as os from 'node:os';
import { getBuildInfo } from '../build-info/build-info';

/**
 * #263 — the vocabulary of a **database-side cron tick claim**, kept free of Nest and Prisma so the
 * derivation can be reasoned about (and tested) without a container or a connection.
 *
 * The problem it solves: every `@Cron` in this app fires wherever `BUSINESS_SWEEPS_ENABLED` /
 * `INGESTION_SCHEDULER_ENABLED` is truthy, and the single-in-flight guards that keep a slow tick from
 * overlapping its own successor are process-local — a `Set` on a singleton, or a boolean field. Two
 * enabled instances therefore run every sweep twice: doubled report-cube rebuilds racing
 * delete-then-insert, doubled notification sends, duplicate dispatch runs degraded to LOCK_CONTENDED
 * noise. Correctness must not depend on an ops flag being set on exactly one machine (#258 Q8.7 / G6).
 */

/** How long a spent claim is kept for diagnosis before the retention sweep deletes it. */
export const CRON_TICK_CLAIM_RETENTION_DAYS = 7;

/** One minute, in milliseconds — the tick window width. */
const WINDOW_MS = 60_000;

/**
 * The window a fire instant belongs to: its UTC minute, truncated.
 *
 * Two instances never fire the same job at the identical millisecond, so the claim has to be taken on
 * a *bucket*. A minute is the finest bucket that cannot split one logical fire into two (no cron in
 * this app fires more often than every two minutes) and the coarsest that cannot merge two distinct fires.
 *
 * Deliberately timezone-free. `timeZone: BUSINESS_TIMEZONE` (#240) decides *when* a job fires; once it
 * has fired, all that is left is an instant, and an instant has no timezone — which is also why DST
 * cannot produce a seam here. `Math.floor` rather than `%` so pre-epoch instants (test fixtures reach
 * for them) truncate downward rather than toward zero.
 */
export function tickWindowStart(firedAt: Date): Date {
  return new Date(Math.floor(firedAt.getTime() / WINDOW_MS) * WINDOW_MS);
}

/**
 * Who took the claim — written for a human reading a log line at 05:00, never read by the code that
 * decides anything. Host and pid identify the machine and process; the #98/#130 build fingerprint says
 * which build it was running, which is the part that matters when the two instances disagree because
 * one of them is mid-deploy.
 */
export function claimantId(): string {
  const build = getBuildInfo();
  return `${os.hostname()}/${process.pid}@${build.fingerprint}`;
}

/**
 * The outcome of asking for a tick. `claimed: false` is a **no-op, not a failure** (G7): the window
 * belonged to somebody else, the work is being done, and a scheduler that reported ERROR here would
 * turn correct behaviour into a page.
 */
export type TickClaim = { claimed: true } | { claimed: false; heldBy: string };

/**
 * The narrow slice of {@link CronTickClaimService} a scheduler depends on — the one question a
 * single-flight wrapper asks. Schedulers take this rather than the concrete service so a spec that has
 * no business owning a connection pool can hand over a two-line stub, and so the dependency reads as
 * what it is: "somebody arbitrates my windows", not "I have a database".
 */
export interface TickClaimant {
  /** True ⇒ this window is ours, run the sweep. False ⇒ another instance has it; log it and no-op. */
  claimTickOrLog(jobName: string, firedAt: Date): Promise<boolean>;
}

/**
 * The retention half, needed by exactly one caller — the partition-maintenance tick that hosts the
 * daily prune (AC-4). Kept separate from {@link TickClaimant} so the six schedulers that only ask
 * about their window are not handed the ability to delete claims.
 */
export interface TickClaimPruner {
  /** Deletes claims whose window is older than {@link CRON_TICK_CLAIM_RETENTION_DAYS}; returns the count. */
  pruneExpiredClaims(now?: Date): Promise<number>;
}
