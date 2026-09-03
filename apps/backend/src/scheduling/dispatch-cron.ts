/**
 * The daily dispatch schedule's vocabulary — the constants, the bootstrap rule, and the one place that
 * knows how to parse a cron expression (#213, CONTEXT.md Decisions §19).
 *
 * Kept as its own module rather than living on `DispatchSchedulerService` so both the scheduler and the
 * settings-backed writer can import it without a cycle: the writer owns the job's lifecycle and needs
 * the scheduler as its tick handler, so the dependency has to run one way only.
 */

/**
 * The business timezone (CONTEXT.md Decisions §19). Every scheduled business job that means a
 * wall-clock hour to an operator must pin this — an unpinned `@Cron` fires in the host process
 * timezone, and no `TZ` is set in any compose/Dockerfile/env in this repo, so "05:00" landed at 10:30
 * IST on a UTC host: hours *into* the field day the run is meant to precede.
 */
export const BUSINESS_TIMEZONE = 'Asia/Kolkata';

/** 05:00 IST — before the field day starts (Schedule Cadence: daily). */
export const DEFAULT_DISPATCH_CRON = '0 5 * * *';

/** The `system_settings` key that is the **source of truth** for the schedule (#213 AC-1). */
export const DISPATCH_CRON_SETTING_KEY = 'dispatch_cron';

/** The registered job's name — the handle `SchedulerRegistry` re-registration works through. */
export const DISPATCH_JOB_NAME = 'business-dispatch';

/**
 * #261 — the reap sweep's own job name and cadence. Deliberately NOT settings-backed the way
 * `dispatch_cron` is: the dispatch hour is a business decision an operator owns, while how often the
 * system checks for its own wreckage is an implementation detail with one right answer.
 *
 * Every three minutes against a ten-minute threshold: frequent enough that an abandoned claim is freed
 * in about the time a human takes to notice it, and cheap enough to ignore — the query is an indexed
 * scan of the RUNNING dispatch runs, of which there is normally zero or one.
 */
export const DISPATCH_REAPER_JOB_NAME = 'business-dispatch-reaper';
export const DEFAULT_DISPATCH_REAPER_CRON = '*/3 * * * *';

/**
 * #286 — the same-day recovery collector's job name and cadence.
 *
 * Five minutes, against the reaper's three: the mark has to exist before there is anything to collect,
 * so a collector that ran faster than the reaper would mostly find an empty table. Not settings-backed,
 * for the reason the reaper is not — when the system repairs itself is an implementation detail, while
 * *whether* it does is #282 R3, already ruled.
 */
export const DISPATCH_RECOVERY_JOB_NAME = 'business-dispatch-recovery';
export const DEFAULT_DISPATCH_RECOVERY_CRON = '*/5 * * * *';

/**
 * How many re-dispatch runs one zone may draw in one operating day (#286 AC5).
 *
 * Three, because the failures worth retrying are transient (a lock held a moment too long, a
 * connection dropped) and a fourth attempt against a zone that has failed three times is not
 * diagnosis, it is a loop. A zone that spends its budget is recorded EXHAUSTED and surfaced —
 * the bound exists so somebody gets told, not so the system goes quiet.
 */
export const DEFAULT_DISPATCH_RECOVERY_MAX_ATTEMPTS = 3;

/**
 * The operating-day cutoff, as an IST hour (#286 AC5). After it, outstanding marks EXPIRE rather than
 * dispatch: a day plan pushed to an engineer at 19:00 is not a recovered field day, it is work nobody
 * will do, and #258 Q6's ordinal-only plan has no way to say "tomorrow morning" either.
 *
 * 18:00 IST, one hour before the field day's own close, so a recovery started at the cutoff still has
 * somewhere to land.
 */
export const DEFAULT_DISPATCH_RECOVERY_CUTOFF_HOUR_IST = 18;

/** The two bounds on same-day recovery (#286). Both configurable; neither is optional. */
export interface DispatchRecoveryPolicy {
  maxAttempts: number;
  cutoffHourIst: number;
}

/**
 * Resolve the recovery bounds. Read from the environment on the same terms as the retry policy: how
 * hard the system tries to repair itself is an implementation detail, not an operator's business hour.
 *
 * `maxAttempts = 0` disables same-day recovery entirely — the documented rollback switch. Marks are
 * still written (they are the evidence a zone lost its day) and the collector retires them EXHAUSTED
 * without dispatching, so turning this off degrades to exactly #261's behaviour plus a record.
 */
export function readDispatchRecoveryPolicy(env: NodeJS.ProcessEnv = process.env): DispatchRecoveryPolicy {
  const attempts = Number(env.DISPATCH_RECOVERY_MAX_ATTEMPTS);
  const cutoff = Number(env.DISPATCH_RECOVERY_CUTOFF_HOUR_IST);
  return {
    // `>= 0`: zero is the off switch and must survive the fallback that rescues garbage.
    maxAttempts:
      Number.isInteger(attempts) && attempts >= 0 ? attempts : DEFAULT_DISPATCH_RECOVERY_MAX_ATTEMPTS,
    cutoffHourIst:
      Number.isInteger(cutoff) && cutoff >= 0 && cutoff <= 24
        ? cutoff
        : DEFAULT_DISPATCH_RECOVERY_CUTOFF_HOUR_IST,
  };
}

/**
 * The **bootstrap** default, consulted only when no setting row exists yet (#213 AC-1). After the row
 * is created the environment variable is not a parallel source and is never read again — which is the
 * whole point of the ruling: changing the dispatch hour must not require a redeploy.
 */
export function bootstrapDispatchCron(env: NodeJS.ProcessEnv = process.env): string {
  return env.BUSINESS_SWEEP_DISPATCH_CRON?.trim() || DEFAULT_DISPATCH_CRON;
}

/**
 * The shape of a registered cron job that this module needs. `SchedulerRegistry.getCronJob` returns a
 * `cron` `CronJob`, but `@nestjs/schedule` v4 does not re-export that package's types and `cron` is not
 * a direct dependency of this app, so the contract is declared structurally here.
 */
export interface ReschedulableCronJob {
  cronTime: object;
  setTime(time: object): void;
  start(): void;
  nextDate(): { toJSDate?: () => Date };
}

/** A `cron` `CronTime` constructor, reached without importing `cron`. See {@link cronTimeCtorOf}. */
export type CronTimeCtor = new (source: string, timeZone?: string) => object;

/**
 * The `CronTime` constructor, taken off a live job instance rather than imported.
 *
 * `cron` is a transitive dependency of `@nestjs/schedule`, which does not re-export it, so importing it
 * directly would mean declaring a second, independently-versioned copy. Reaching through the job avoids
 * that — and buys a property that matters more than tidiness: **the parser that validates an operator's
 * expression is byte-for-byte the parser that will run it.** A separately-resolved `cron` could accept
 * an expression the scheduler then rejects, which is exactly the accepted-then-silently-dead schedule
 * #213 exists to prevent. If `@nestjs/schedule` ever swaps libraries this fails loudly at the first
 * write, and `dispatch-schedule-config.e2e-spec.ts` pins it.
 */
export function cronTimeCtorOf(job: ReschedulableCronJob): CronTimeCtor {
  return job.cronTime.constructor as CronTimeCtor;
}

export type CronValidation = { valid: true } | { valid: false; reason: string };

/**
 * Validate an operator-supplied expression **before** it is stored (#213 AC-4). A schedule that is
 * quietly dead is worse than one that is wrong, because nothing surfaces it until someone notices there
 * is no day plan — so this runs at write time and the caller leaves the previous schedule untouched.
 *
 * Note this accepts any expression `cron` accepts, including sub-daily ones (`* * * * *` is a valid
 * every-minute schedule). Narrowing the *sensible* range is a product question #213 does not rule on;
 * the guarantee here is only that what is stored will actually fire.
 */
export function validateDispatchCron(expression: unknown, CronTime: CronTimeCtor): CronValidation {
  if (typeof expression !== 'string' || expression.trim() === '') {
    return { valid: false, reason: 'A cron expression is required.' };
  }
  try {
    new CronTime(expression.trim(), BUSINESS_TIMEZONE);
    return { valid: true };
  } catch (e) {
    return { valid: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** The absolute instant the job next fires, normalised across `cron` v2 (Date) and v3 (Luxon). */
export function nextFireAt(job: ReschedulableCronJob): Date {
  const next = job.nextDate();
  return typeof next.toJSDate === 'function' ? next.toJSDate() : (next as unknown as Date);
}

/**
 * #261 / #260 — the two dispatch timing thresholds, stated together because they are only correct
 * relative to each other.
 *
 * The reap threshold is how long a dispatch run may go silent before it is presumed dead and its zone
 * claims are freed. #260's retry deadline is how long the 05:00 cron keeps re-attempting a zone that
 * was contended. **The invariant is `reap <= retry deadline`:** if a crashed holder could outlive the
 * cron's whole retry window, the morning run would spend that window being refused by a zombie and
 * then give up — the exact starvation the reaper exists to prevent. 10 against 15 leaves the retry
 * window a full reap cycle of slack.
 *
 * Ten minutes is well above any observed real run: the beat is stamped at admission and after every
 * zone, so a live run of any length is silent only for as long as its slowest single zone takes.
 */
export const DEFAULT_DISPATCH_STALE_RUN_MIN = 10;

/** #260's bounded-retry deadline, in minutes. Stated here so the invariant above is checkable. */
export const DEFAULT_DISPATCH_RETRY_DEADLINE_MIN = 15;

/** #260 — how often the patient CRON re-asks for a zone it was refused. */
export const DEFAULT_DISPATCH_RETRY_INTERVAL_MS = 60_000;

/** How long the automatic run stays patient, and how often it re-asks (#260). */
export interface DispatchRetryPolicy {
  intervalMs: number;
  deadlineMs: number;
}

/**
 * Resolve the patience policy (#260). `deadlineMs = 0` disables retrying entirely and restores
 * try-once behaviour — the issue's stated rollback, so it is a supported configuration rather than a
 * degenerate one.
 *
 * Read from the environment the way the rest of the scheduler config is, and **not** from
 * `system_settings`: the dispatch *hour* is a business decision an operator owns and #213 moved it into
 * the settings registry for that reason, whereas how long the run is willing to wait for a lock is an
 * implementation detail of how it copes with itself.
 */
export function readDispatchRetryPolicy(env: NodeJS.ProcessEnv = process.env): DispatchRetryPolicy {
  const interval = Number(env.DISPATCH_RETRY_INTERVAL_MS);
  const deadline = Number(env.DISPATCH_RETRY_DEADLINE_MS);
  return {
    intervalMs: Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_DISPATCH_RETRY_INTERVAL_MS,
    // `>= 0` rather than `> 0`: zero is the documented off switch, so it must survive the fallback that
    // rescues garbage. Anything unparseable still falls back to the default.
    deadlineMs:
      Number.isFinite(deadline) && deadline >= 0 ? deadline : DEFAULT_DISPATCH_RETRY_DEADLINE_MIN * 60_000,
  };
}

/**
 * #303 — how long a `business-dispatch` tick claim may sit with **no admitted run** before the janitor
 * calls the tick dead.
 *
 * Derived from the two knobs that already bound the tick's honest silence, rather than invented as a
 * third: a patient run (#260) holds its claim for up to `deadlineMs` while every zone is contended,
 * and #259's rule is that a run which never happened leaves no history — so during that whole window
 * a perfectly healthy tick has a claim and no `dispatch_runs` row. Adding the stale-run threshold on
 * top leaves a full reap cycle of slack beyond it, the same margin
 * {@link DEFAULT_DISPATCH_STALE_RUN_MIN}'s own comment reasons about. Default 15 + 10 = 25 minutes.
 *
 * Anything shorter would mistake patience for death and re-dispatch a zone somebody is still working.
 */
export function readAbandonedTickGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  return readDispatchRetryPolicy(env).deadlineMs + readDispatchStaleRunMs(env);
}

/** Reap cutoff in ms, env-overridable via `DISPATCH_STALE_RUN_MIN` (minutes). */
export function readDispatchStaleRunMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.DISPATCH_STALE_RUN_MIN);
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DISPATCH_STALE_RUN_MIN;
  return minutes * 60_000;
}

/**
 * The liveness half of the dispatch reaper's `where` — the direct analogue of the ingestion
 * `staleRunFilter`, kept separate because the two carry different thresholds for good reason: an
 * AutoPlant sync waits on a remote system, a dispatch run does not.
 *
 * A run that has never beaten falls back to `started_at`, so the reaper still covers every row written
 * before `heartbeat_at` existed.
 */
export function staleDispatchRunFilter(
  now: Date,
  env: NodeJS.ProcessEnv = process.env,
): { OR: [{ heartbeatAt: { lt: Date } }, { heartbeatAt: null; startedAt: { lt: Date } }] } {
  const cutoff = new Date(now.getTime() - readDispatchStaleRunMs(env));
  return { OR: [{ heartbeatAt: { lt: cutoff } }, { heartbeatAt: null, startedAt: { lt: cutoff } }] };
}
