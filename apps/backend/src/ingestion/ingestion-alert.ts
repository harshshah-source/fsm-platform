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
 */

/** How many consecutive non-SUCCESS runs before the alert fires. */
export const DEFAULT_INGESTION_STREAK_THRESHOLD = 3;

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
 */
export function deriveIngestionAlert(
  runs: readonly StreakRun[],
  failedChunks: readonly StreakChunk[],
  threshold: number,
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

  return {
    streak,
    threshold,
    alert: streak >= threshold || repeatingFailure,
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
  };
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
): Promise<IngestionAlertHealth> {
  const runs = await source.findFinalizedRuns(INGESTION_STREAK_SCAN_LIMIT);

  let streak = 0;
  while (streak < runs.length && runs[streak].status !== 'SUCCESS') streak += 1;

  const chunks = streak === 0 ? [] : await source.findFailedChunks(runs.slice(0, streak).map((r) => r.runId));
  return deriveIngestionAlert(runs, chunks, threshold);
}
