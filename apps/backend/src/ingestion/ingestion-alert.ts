import type { SnapshotStatus } from '../generated/prisma/enums';

/**
 * #300 — the wedged-ingestion alert state.
 *
 * When ingestion is stuck (AR-1/AR-2, a poison chunk, a source read that dies at the same row every
 * run), the #230 gate correctly refuses to derive device state, auto-recover or open tickets on a
 * partial read. That refusal is the right call and it is loud in the logs — but it surfaces nowhere
 * an operator looks: the freshness banner just reads an ever-older `data_as_of` from the last SUCCESS
 * run, with no statement of *why* it is not advancing. Nothing aggregates the run-to-run streak.
 *
 * This module is that aggregate: a read-only derivation over `snapshot_runs` + `snapshot_run_chunks`
 * (+ #299's per-run rejection tallies), shared by the two surfaces that need it — the OH integration
 * health card and the global freshness banner — so the two can never disagree about whether the
 * pipeline is wedged. Nothing here writes; nothing here changes the gate.
 *
 * Modelled on #218's `quietRunsAlert`, which is the in-repo precedent for "a run of runs saying
 * nothing happened is itself the signal".
 *
 * #348 adds the failure #300 structurally could not see. Everything above counts runs that
 * *happened*: a stopped cron produces none, so a silent pipeline scored `streak: 0`,
 * `downstreamGated: false` and read as perfectly healthy while its newest data aged past a day.
 * {@link IngestionAlertHealth.overdue} closes that by judging the *age* of the newest SUCCESS
 * against the cadence the scheduler is configured for — and {@link IngestionAlertHealth.schedulerPaused}
 * keeps a deliberately-disabled scheduler out of the alert path without letting it read as fresh.
 */

/** How many consecutive non-SUCCESS runs before the alert fires. */
export const DEFAULT_INGESTION_STREAK_THRESHOLD = 3;

/**
 * #348 — the cadence assumed when the configured cron cannot be reduced to one (see
 * {@link cronCadenceMinutes}). Matches `DEFAULT_TELEMETRY_CRON` (`*​/30 * * * *`); it is a fallback,
 * not a second source of truth — the live value is always derived from the cron the scheduler
 * actually registered.
 */
export const DEFAULT_INGESTION_CADENCE_MINUTES = 30;

/**
 * #348 — how many cadences of silence before {@link IngestionAlertHealth.overdue}.
 *
 * Two, not one: one missed tick is a slow run, a restart, or a tick another instance claimed, and
 * paging on it would train operators to ignore the banner. Two consecutive missed windows is no
 * longer explicable by a single late run — something has stopped.
 */
export const OVERDUE_CADENCE_MULTIPLIER = 2;

/**
 * Runs scanned back from the newest to measure the streak. Only the *leading* non-SUCCESS block is
 * ever counted, so this is a cap on the reported number, not on detection: an operator who has let it
 * reach 20 is long past needing a bigger number.
 */
export const INGESTION_STREAK_SCAN_LIMIT = 20;

/**
 * The stages the #230 gate skips when a telemetry read did not finalize SUCCESS. Named here rather
 * than spelled into the FE copy so the card cannot drift from
 * `IntegrationSyncService.runPostIngestStages`, which is what actually skips them.
 */
export const GATED_STAGES = ['device-state derivation', 'auto-recovery', 'ticket creation'] as const;

/**
 * Per-run ingestion tallies as persisted in `snapshot_runs.chunk_stats` (#299 counters, #300 makes
 * them durable). Both maps are reason → row count; absent/`{}` means nothing was dropped or repaired.
 */
export interface SnapshotChunkStats {
  /** Rows DROPPED by the reader — each is a device with no ping for that run. */
  rejected?: Record<string, number>;
  /** Out-of-range FIELDS nulled with the row kept — a data-quality fact, not a lost device. */
  repaired?: Record<string, number>;
}

/** The failing chunk an operator has to go look at, with the error verbatim. */
export interface IngestionFailingChunk {
  runId: string;
  chunkNo: number;
  retryCount: number;
  error: string | null;
}

export interface IngestionAlertHealth {
  /** Consecutive most-recent FINALIZED runs that did not finalize SUCCESS (RUNNING is skipped). */
  streak: number;
  threshold: number;
  /** `streak >= threshold`, or the same chunk error repeating across the streak. */
  alert: boolean;
  /** Status of the newest finalized run; null when no run has ever finished. */
  latestStatus: SnapshotStatus | null;
  /**
   * The newest finalized run did not finalize SUCCESS, so #230 skipped every downstream stage on it.
   * True from the FIRST non-SUCCESS run — the gate is per-pass, and hiding a single gated pass behind
   * the streak threshold would make the banner claim a freshness it does not have (AC2).
   */
  downstreamGated: boolean;
  /** {@link GATED_STAGES} when `downstreamGated`, else empty — what the card names to the operator. */
  gatedStages: string[];
  /** Newest FAILED chunk inside the streak. Null on a read-failure streak (no chunk ever failed). */
  failingChunk: IngestionFailingChunk | null;
  /** The identical chunk error recurs on every run of a ≥2-run streak — a poison window, not a blip. */
  repeatingFailure: boolean;
  /** Rows dropped across the streak, by reason (#299) — `{}` when none. */
  rejected: Record<string, number>;
  /** Fields nulled with their row kept across the streak, by reason (#299) — `{}` when none. */
  repaired: Record<string, number>;

  // ---- #348: silence. Everything above counts runs that HAPPENED; a stopped cron produces none. ----

  /**
   * Whole minutes since the newest SUCCESS run in the scan window; null when there is no SUCCESS to
   * measure from (a fresh database, or {@link INGESTION_STREAK_SCAN_LIMIT} consecutive failures).
   *
   * Reported even while {@link schedulerPaused} — "paused" must never read as "fresh".
   */
  silenceMinutes: number | null;
  /** The scheduler's configured interval in minutes, derived from its cron ({@link cronCadenceMinutes}). */
  expectedCadenceMinutes: number;
  /** `expectedCadenceMinutes × ` {@link OVERDUE_CADENCE_MULTIPLIER} — the age `overdue` is decided at. */
  overdueAfterMinutes: number;
  /**
   * The scheduler master switch is off (`INGESTION_SCHEDULER_ENABLED !== 'true'`). Ingestion is
   * stopped **on purpose**, so nothing is overdue and nothing alerts — but the surface still says
   * "paused" rather than "healthy" (AC4), because an operator who cannot tell those two apart will
   * eventually read a switched-off pipeline as a working one.
   */
  schedulerPaused: boolean;
  /**
   * No SUCCESS run inside {@link overdueAfterMinutes} while the scheduler is supposed to be running —
   * i.e. the pipeline has gone SILENT. This is the state the streak rules structurally cannot see:
   * zero runs means zero non-SUCCESS runs, so `streak` is 0, `downstreamGated` is false, and every
   * field above reports a healthy pipeline whose data is a day old.
   */
  overdue: boolean;
}

/**
 * #348 — what the silence rule needs that the run ledger cannot tell it: how often ingestion is
 * *supposed* to run, and whether it is supposed to be running at all. Both come from
 * `IngestionSchedulerConfig`, resolved by the callers (`SnapshotQueryService`,
 * `AutoPlantHealthService`) so this module stays free of Nest and of `process.env`.
 */
export interface IngestionCadence {
  expectedCadenceMinutes: number;
  /** `IngestionSchedulerConfig.enabled`. */
  schedulerEnabled: boolean;
  /** Injectable clock, so the cadence rule is provable against a frozen `now`. */
  now?: Date;
}

/**
 * The default when a caller supplies no cadence: **paused**.
 *
 * Deliberately the quiet direction. A caller that forgets to thread the scheduler config through
 * must not be able to fabricate a red banner out of nothing — a false silence alarm on every surface
 * is exactly how alerting gets switched off, which would cost more than the gap it closes.
 */
const PAUSED: Required<IngestionCadence> = {
  expectedCadenceMinutes: DEFAULT_INGESTION_CADENCE_MINUTES,
  schedulerEnabled: false,
  now: new Date(0),
};

/**
 * Reduce a cron expression to the interval between its firings, in minutes; null when it has no
 * single interval.
 *
 * The freshness threshold has to move with the ops knob that sets the cadence
 * (`INGESTION_TELEMETRY_CRON` / `INGESTION_MASTERS_CRON`). A hard-coded "stale after 60 minutes"
 * starts lying the first time somebody widens the cron, and lies in the dangerous direction — the
 * banner goes red on a correctly-configured pipeline until it is muted, and then stays muted.
 *
 * Handles the forms the platform actually configures: `*​/N * * * *` (every N minutes), `* * * * *`,
 * `M * * * *` (hourly), `M *​/H * * *` (every H hours) and `M H * * *` (daily). Anything with a
 * day-of-month or day-of-week restriction returns **null** rather than a guess: "every Monday at 2am"
 * has no cadence, and inventing one would fire the alert every weekend. `@nestjs/schedule` also
 * accepts a 6-field form leading with seconds, so that is normalized away first.
 */
export function cronCadenceMinutes(cron: string): number | null {
  const parts = cron.trim().split(/\s+/).filter((p) => p.length > 0);
  // 6 fields = seconds-leading. Sub-minute cadences round to the 1-minute floor below, which is the
  // right answer for a threshold measured in whole minutes.
  const fields = parts.length === 6 ? parts.slice(1) : parts;
  if (fields.length !== 5) return null;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  // A calendar restriction has no interval — see the docblock.
  if (dayOfMonth !== '*' || month !== '*' || dayOfWeek !== '*') return null;

  const step = (field: string): number | null => {
    const m = /^\*\/(\d+)$/.exec(field);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isInteger(n) && n > 0 ? n : null;
  };

  if (hour === '*') {
    if (minute === '*') return 1;
    const minuteStep = step(minute);
    if (minuteStep !== null) return minuteStep;
    return /^\d+$/.test(minute) ? 60 : null;
  }

  // An hour restriction only yields a cadence when the minute is a single fixed value.
  if (!/^\d+$/.test(minute)) return null;
  const hourStep = step(hour);
  if (hourStep !== null) return hourStep * 60;
  return /^\d+$/.test(hour) ? 1440 : null;
}

/** {@link cronCadenceMinutes} with the fallback applied — what every caller actually wants. */
export function cadenceMinutesOrDefault(
  cron: string,
  fallback: number = DEFAULT_INGESTION_CADENCE_MINUTES,
): number {
  return cronCadenceMinutes(cron) ?? fallback;
}

/**
 * Streak length before the alert fires, env-overridable via `INGESTION_PARTIAL_STREAK_RUNS`.
 * Default 3: at the 30-minute telemetry cadence that is ~1.5 h of a gated pipeline — long enough that
 * one flaky read or a single transient VPN blip never pages anybody (the alert-fatigue risk the issue
 * calls out), short enough that a wedge is seen the same shift it starts. A *patience* knob, like
 * {@link readLifecycleQuietRuns} — never a tolerance, since the correct steady state is zero.
 */
export function readIngestionStreakThreshold(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.INGESTION_PARTIAL_STREAK_RUNS);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_INGESTION_STREAK_THRESHOLD;
}

/** A finalized snapshot run, newest-first, as the derivation needs it. */
export interface StreakRun {
  runId: bigint;
  status: SnapshotStatus;
  chunkStats: unknown;
  /**
   * #348 — the run's own clock, so silence is measured **inside the window already being read**
   * rather than by a second query. The scan already returns the newest
   * {@link INGESTION_STREAK_SCAN_LIMIT} finalized runs; the newest SUCCESS among them is exactly the
   * timestamp the freshness threshold needs, and the healthy path stays one query (which it must —
   * this is polled from every admin page on a 60-second timer).
   */
  startedAt: Date;
  finishedAt: Date | null;
}

/** A FAILED chunk row belonging to one of the streak's runs. */
export interface StreakChunk {
  runId: bigint;
  chunkNo: number;
  retryCount: number;
  error: string | null;
}

/** `chunk_stats` is untyped JSON on the way back out of Postgres — read it defensively. */
export function readChunkStats(value: unknown): Required<SnapshotChunkStats> {
  const raw =
    typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return { rejected: readTally(raw.rejected), repaired: readTally(raw.repaired) };
}

function readTally(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [reason, n] of Object.entries(value as Record<string, unknown>)) {
    if (typeof n === 'number' && Number.isFinite(n)) out[reason] = n;
  }
  return out;
}

const fold = (into: Record<string, number>, from: Record<string, number> | undefined): void => {
  for (const [reason, n] of Object.entries(from ?? {})) into[reason] = (into[reason] ?? 0) + n;
};

/**
 * The derivation itself, pure so the streak rules are testable without a database.
 *
 * @param runs finalized runs, newest first (RUNNING rows already excluded — an in-flight run is not
 *   a failure, and letting one reset the streak would hide a wedge behind the very retry that is
 *   failing).
 * @param failedChunks FAILED chunks belonging to the runs in the leading streak, newest run first.
 * @param cadence #348 — the configured cadence + scheduler switch behind the silence rule. Omitted
 *   ⇒ {@link PAUSED}: no cadence means no verdict, and a missing verdict must be quiet, not loud.
 */
export function deriveIngestionAlert(
  runs: readonly StreakRun[],
  failedChunks: readonly StreakChunk[],
  threshold: number,
  cadence: IngestionCadence = PAUSED,
): IngestionAlertHealth {
  const latestStatus = runs[0]?.status ?? null;

  let streak = 0;
  while (streak < runs.length && runs[streak].status !== 'SUCCESS') streak += 1;
  const streakRuns = runs.slice(0, streak);

  const rejected: Record<string, number> = {};
  const repaired: Record<string, number> = {};
  for (const run of streakRuns) {
    const stats = readChunkStats(run.chunkStats);
    fold(rejected, stats.rejected);
    fold(repaired, stats.repaired);
  }

  const inStreak = new Set(streakRuns.map((r) => r.runId.toString()));
  const chunks = failedChunks.filter((c) => inStreak.has(c.runId.toString()));
  const newest = chunks[0] ?? null;

  // "Repeating" means the SAME error on EVERY run of the streak — a chunk that fails, is re-read from
  // the PARTIAL resume floor, and fails identically again. One run failing twice is a retry, not a
  // repeat, so the comparison is per-run and needs the whole streak covered.
  const runsWithThatError = new Set(
    newest === null ? [] : chunks.filter((c) => c.error === newest.error).map((c) => c.runId.toString()),
  );
  const repeatingFailure = streak >= 2 && runsWithThatError.size === streak;

  // #348 — silence. `runs` is already newest-first, so the first SUCCESS in it is the newest one.
  // `finishedAt` is the moment the run's data landed; `startedAt` is the fallback for a legacy row
  // written before the column was always populated, so a missing timestamp can never read as "never".
  const now = cadence.now ?? new Date();
  const lastSuccess = runs.find((r) => r.status === 'SUCCESS');
  const lastSuccessAt = lastSuccess ? (lastSuccess.finishedAt ?? lastSuccess.startedAt) : null;
  const silenceMinutes =
    lastSuccessAt === null ? null : Math.max(0, Math.floor((now.getTime() - lastSuccessAt.getTime()) / 60_000));
  const overdueAfterMinutes = cadence.expectedCadenceMinutes * OVERDUE_CADENCE_MULTIPLIER;
  // No SUCCESS anywhere in the scan window counts as overdue: either nothing has ever run, or the
  // last 20 finalized runs all failed. Both are the pipeline not producing data.
  const overdue = cadence.schedulerEnabled && (silenceMinutes === null || silenceMinutes > overdueAfterMinutes);

  return {
    streak,
    threshold,
    alert: streak >= threshold || repeatingFailure || overdue,
    latestStatus,
    downstreamGated: latestStatus !== null && latestStatus !== 'SUCCESS',
    gatedStages: latestStatus !== null && latestStatus !== 'SUCCESS' ? [...GATED_STAGES] : [],
    failingChunk: newest
      ? {
          runId: newest.runId.toString(),
          chunkNo: newest.chunkNo,
          retryCount: newest.retryCount,
          error: newest.error,
        }
      : null,
    repeatingFailure,
    rejected,
    repaired,
    silenceMinutes,
    expectedCadenceMinutes: cadence.expectedCadenceMinutes,
    overdueAfterMinutes,
    schedulerPaused: !cadence.schedulerEnabled,
    overdue,
  };
}

/**
 * #361 — the two shapes of "ingestion is not producing data" the Operations Head has to be told about.
 *
 * Deliberately two types, not one `INGESTION_ALERT`, because they are two different problems with two
 * different first moves. FAILED means runs are happening and dying — there is a poison chunk or a
 * source read to go and look at, and {@link IngestionAlertHealth.failingChunk} names it. OVERDUE means
 * no run is happening at all — the cron, the process or the VPN is down, and there is no chunk to
 * inspect because nothing got far enough to fail. Collapsing them would send an operator to read
 * chunk errors that do not exist.
 */
export const INGESTION_NOTICE_KINDS = ['FAILED', 'OVERDUE'] as const;
export type IngestionNoticeKind = (typeof INGESTION_NOTICE_KINDS)[number];

/**
 * Which OH notices a given health reading is due — pure, so the rule is provable without a database
 * and without the sweep that carries it.
 *
 * **`alert`, not `streak >= threshold`.** `alert` already folds in the repeating-poison-chunk case,
 * which is a wedge at streak 2 that the raw threshold would not fire on for another hour.
 *
 * **A paused scheduler yields nothing at all.** `deriveIngestionAlert` cannot set `overdue` while
 * `schedulerPaused`, and it must not: ingestion being off is a decision somebody made, and paging them
 * about their own decision every night is how an alert channel dies. The surface still reports
 * "paused" rather than "healthy" (#348 AC4) — that distinction stays where a human is looking, not in
 * a push.
 *
 * **Both can be due at once** and both are returned: three failed runs *and* nothing succeeding for a
 * day are independently true and independently actionable.
 */
export function dueIngestionNotices(health: IngestionAlertHealth): IngestionNoticeKind[] {
  const due: IngestionNoticeKind[] = [];
  // `alert` is also set BY `overdue`, so the failure arm is qualified: silence is not a failed run,
  // and reporting it as one would send the operator hunting a chunk error that never existed.
  if (health.alert && (health.streak > 0 || health.repeatingFailure)) due.push('FAILED');
  if (health.overdue) due.push('OVERDUE');
  return due;
}

/** The sentence an Operations Head reads at 07:00, per notice kind. */
export function ingestionNoticeBody(kind: IngestionNoticeKind, health: IngestionAlertHealth): string {
  if (kind === 'OVERDUE') {
    const age = health.silenceMinutes === null ? 'no run has ever succeeded' : `${health.silenceMinutes} minutes ago`;
    return (
      `Telemetry ingestion has produced no successful run since ${age} (expected every ` +
      `${health.expectedCadenceMinutes} minutes). Device state, auto-recovery and ticket creation are ` +
      `not running on fresh data.`
    );
  }
  const chunk = health.failingChunk;
  const where = chunk ? ` Chunk ${chunk.chunkNo} of run ${chunk.runId} failed: ${chunk.error ?? 'no error recorded'}.` : '';
  return (
    `${health.streak} consecutive ingestion run${health.streak === 1 ? '' : 's'} did not finish successfully` +
    `${health.repeatingFailure ? ' with the same error each time' : ''}.` +
    `${where} ${GATED_STAGES.join(', ')} are being skipped.`
  );
}

/** The two queries the derivation reads, kept as an interface so the reader is DB-shape-agnostic. */
export interface IngestionAlertSource {
  findFinalizedRuns(limit: number): Promise<StreakRun[]>;
  findFailedChunks(runIds: bigint[]): Promise<StreakChunk[]>;
}

/**
 * Read + derive. Two round trips (runs, then that streak's failed chunks) and no chunk query at all
 * when the newest run succeeded — which is the steady state, and the state this is polled in.
 */
export async function readIngestionAlert(
  source: IngestionAlertSource,
  threshold: number = readIngestionStreakThreshold(),
  cadence?: IngestionCadence,
): Promise<IngestionAlertHealth> {
  const runs = await source.findFinalizedRuns(INGESTION_STREAK_SCAN_LIMIT);

  let streak = 0;
  while (streak < runs.length && runs[streak].status !== 'SUCCESS') streak += 1;

  const chunks = streak === 0 ? [] : await source.findFailedChunks(runs.slice(0, streak).map((r) => r.runId));
  return deriveIngestionAlert(runs, chunks, threshold, cadence);
}
