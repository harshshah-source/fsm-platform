import {
  DEFAULT_INGESTION_CADENCE_MINUTES,
  DEFAULT_INGESTION_STREAK_THRESHOLD,
  GATED_STAGES,
  OVERDUE_CADENCE_MULTIPLIER,
  cronCadenceMinutes,
  deriveIngestionAlert,
  readChunkStats,
  readIngestionAlert,
  readIngestionStreakThreshold,
  type StreakChunk,
  type StreakRun,
} from '../src/ingestion/ingestion-alert';
import {
  DEFAULT_MASTERS_CRON,
  DEFAULT_TELEMETRY_CRON,
} from '../src/ingestion/autoplant/integration-scheduler.service';

/**
 * #300 — the wedged-ingestion derivation, unit-level.
 *
 * The failure this pins is not a crash: it is a pipeline that is frozen and looks fine. When AR-1/AR-2
 * (or any poison chunk) wedges ingestion, every run finalizes PARTIAL, the #230 gate correctly skips
 * device-state derivation / auto-recovery / ticket creation, and NOTHING says so anywhere an operator
 * looks — the freshness banner just keeps showing the last SUCCESS timestamp getting older. These
 * cases fix the rules that turn "a run of runs" into that missing statement.
 *
 * Kept pure (no Prisma, no Nest) so the streak arithmetic is provable without a database; the
 * `ingestion-alert.e2e-spec.ts` sibling proves the two queries feeding it.
 */
const run = (
  runId: number,
  status: StreakRun['status'],
  chunkStats: unknown = null,
  at: Date = new Date('2026-09-03T12:00:00.000Z'),
): StreakRun => ({
  runId: BigInt(runId),
  status,
  chunkStats,
  startedAt: at,
  finishedAt: status === 'RUNNING' ? null : at,
});

const chunk = (runId: number, chunkNo: number, error: string | null): StreakChunk => ({
  runId: BigInt(runId),
  chunkNo,
  retryCount: 2,
  error,
});

describe('#300 — ingestion streak derivation', () => {
  it('does not alert on an isolated PARTIAL', () => {
    const alert = deriveIngestionAlert([run(9, 'PARTIAL'), run(8, 'SUCCESS'), run(7, 'SUCCESS')], [], 3);

    expect(alert.streak).toBe(1);
    expect(alert.alert).toBe(false);
    // ...but the gate IS closed on that pass, and the banner has to say so (AC2). A single blip is
    // not alert-grade; claiming freshness while a stage was skipped is wrong at every streak length.
    expect(alert.downstreamGated).toBe(true);
    expect(alert.gatedStages).toEqual([...GATED_STAGES]);
  });

  it('alerts once the streak reaches the threshold', () => {
    const runs = [run(9, 'PARTIAL'), run(8, 'PARTIAL'), run(7, 'PARTIAL'), run(6, 'SUCCESS')];

    expect(deriveIngestionAlert(runs, [], 3).alert).toBe(true);
    expect(deriveIngestionAlert(runs, [], 3).streak).toBe(3);
    // The same three runs are below a more patient operator's threshold.
    expect(deriveIngestionAlert(runs, [], 4).alert).toBe(false);
  });

  it('counts a FAILED run in the streak alongside PARTIALs', () => {
    const alert = deriveIngestionAlert([run(9, 'FAILED'), run(8, 'PARTIAL'), run(7, 'SUCCESS')], [], 3);

    expect(alert.streak).toBe(2);
    expect(alert.latestStatus).toBe('FAILED');
    expect(alert.downstreamGated).toBe(true);
  });

  it('a SUCCESS resets the streak', () => {
    const alert = deriveIngestionAlert(
      [run(9, 'SUCCESS'), run(8, 'PARTIAL'), run(7, 'PARTIAL'), run(6, 'PARTIAL')],
      [],
      3,
    );

    expect(alert.streak).toBe(0);
    expect(alert.alert).toBe(false);
    expect(alert.downstreamGated).toBe(false);
    expect(alert.gatedStages).toEqual([]);
    expect(alert.failingChunk).toBeNull();
  });

  it('reports nothing at all when no run has ever finished', () => {
    const alert = deriveIngestionAlert([], [], 3);

    expect(alert.streak).toBe(0);
    expect(alert.latestStatus).toBeNull();
    // No run is NOT a gated run — an unconfigured dev box must not render a wedge alert.
    expect(alert.downstreamGated).toBe(false);
  });

  it('names the newest failing chunk and its error', () => {
    const alert = deriveIngestionAlert(
      [run(9, 'PARTIAL'), run(8, 'PARTIAL')],
      [chunk(9, 4, 'device 0869925073271551: invalid input syntax'), chunk(8, 4, 'something older')],
      3,
    );

    expect(alert.failingChunk).toEqual({
      runId: '9',
      chunkNo: 4,
      retryCount: 2,
      error: 'device 0869925073271551: invalid input syntax',
    });
  });

  it('flags a repeating identical chunk failure — and alerts on it before the threshold', () => {
    const alert = deriveIngestionAlert(
      [run(9, 'PARTIAL'), run(8, 'PARTIAL'), run(7, 'SUCCESS')],
      [chunk(9, 4, 'poison row'), chunk(8, 4, 'poison row')],
      3,
    );

    expect(alert.repeatingFailure).toBe(true);
    // Two runs, threshold three — the streak alone would stay quiet. A chunk that fails, is re-read
    // from the PARTIAL resume floor and fails identically is not going to fix itself on run three.
    expect(alert.alert).toBe(true);
  });

  it('does not call two different errors a repeat', () => {
    const alert = deriveIngestionAlert(
      [run(9, 'PARTIAL'), run(8, 'PARTIAL')],
      [chunk(9, 4, 'connection reset'), chunk(8, 7, 'deadlock detected')],
      3,
    );

    expect(alert.repeatingFailure).toBe(false);
    expect(alert.alert).toBe(false);
  });

  it('does not call one run failing twice a repeat', () => {
    // Same run, two chunks, same error — that is one bad run, not a run-over-run pattern.
    const alert = deriveIngestionAlert([run(9, 'PARTIAL')], [chunk(9, 4, 'poison row'), chunk(9, 5, 'poison row')], 3);

    expect(alert.repeatingFailure).toBe(false);
    expect(alert.alert).toBe(false);
  });

  it('ignores chunks belonging to runs outside the streak', () => {
    const alert = deriveIngestionAlert(
      [run(9, 'PARTIAL'), run(8, 'SUCCESS'), run(7, 'PARTIAL')],
      [chunk(7, 1, 'ancient history')],
      3,
    );

    expect(alert.streak).toBe(1);
    expect(alert.failingChunk).toBeNull();
  });

  it('sums #299 rejected/repaired tallies across the streak only', () => {
    const alert = deriveIngestionAlert(
      [
        run(9, 'PARTIAL', { rejected: { UNPARSEABLE_TIMESTAMP: 2 }, repaired: { MAINS_VOLTAGE_OUT_OF_RANGE: 5 } }),
        run(8, 'PARTIAL', { rejected: { UNPARSEABLE_TIMESTAMP: 1, FUTURE_SKEW: 3 } }),
        run(7, 'SUCCESS', { rejected: { UNPARSEABLE_TIMESTAMP: 999 } }),
      ],
      [],
      3,
    );

    expect(alert.rejected).toEqual({ UNPARSEABLE_TIMESTAMP: 3, FUTURE_SKEW: 3 });
    expect(alert.repaired).toEqual({ MAINS_VOLTAGE_OUT_OF_RANGE: 5 });
  });

  it('survives a chunk_stats payload of the wrong shape', () => {
    // Runs written before #300 have `chunk_stats` NULL; nothing about a legacy row may crash a surface
    // whose whole job is to still be readable when the pipeline is broken.
    expect(readChunkStats(null)).toEqual({ rejected: {}, repaired: {} });
    expect(readChunkStats('nonsense')).toEqual({ rejected: {}, repaired: {} });
    expect(readChunkStats([1, 2])).toEqual({ rejected: {}, repaired: {} });
    expect(readChunkStats({ rejected: 'nope' })).toEqual({ rejected: {}, repaired: {} });
    expect(readChunkStats({ rejected: { A: 'two', B: 2 } })).toEqual({ rejected: { B: 2 }, repaired: {} });

    const alert = deriveIngestionAlert([run(9, 'PARTIAL', null), run(8, 'PARTIAL', 'garbage')], [], 3);
    expect(alert.rejected).toEqual({});
    expect(alert.repaired).toEqual({});
  });
});

describe('#300 — streak threshold knob', () => {
  it('defaults to 3 and rejects nonsense', () => {
    expect(readIngestionStreakThreshold({})).toBe(DEFAULT_INGESTION_STREAK_THRESHOLD);
    expect(readIngestionStreakThreshold({ INGESTION_PARTIAL_STREAK_RUNS: 'many' })).toBe(3);
    expect(readIngestionStreakThreshold({ INGESTION_PARTIAL_STREAK_RUNS: '0' })).toBe(3);
    expect(readIngestionStreakThreshold({ INGESTION_PARTIAL_STREAK_RUNS: '-2' })).toBe(3);
  });

  it('honours an explicit override', () => {
    expect(readIngestionStreakThreshold({ INGESTION_PARTIAL_STREAK_RUNS: '5' })).toBe(5);
  });
});

describe('#300 — the read path skips the chunk query in the steady state', () => {
  it('never touches snapshot_run_chunks when the newest run succeeded', async () => {
    let chunkQueries = 0;
    const alert = await readIngestionAlert(
      {
        findFinalizedRuns: async () => [run(9, 'SUCCESS'), run(8, 'PARTIAL')],
        findFailedChunks: async () => {
          chunkQueries += 1;
          return [];
        },
      },
      3,
    );

    expect(alert.streak).toBe(0);
    // This is polled from every admin page on a 60s timer; the healthy path must stay one query.
    expect(chunkQueries).toBe(0);
  });

  it('asks only for the streak’s own runs when the pipeline is wedged', async () => {
    let asked: bigint[] = [];
    const alert = await readIngestionAlert(
      {
        findFinalizedRuns: async () => [run(9, 'PARTIAL'), run(8, 'PARTIAL'), run(7, 'SUCCESS'), run(6, 'FAILED')],
        findFailedChunks: async (runIds) => {
          asked = runIds;
          return [chunk(9, 1, 'boom')];
        },
      },
      3,
    );

    expect(asked).toEqual([9n, 8n]);
    expect(alert.failingChunk?.error).toBe('boom');
  });
});

/**
 * #348 — the failure the streak derivation above cannot see: **silence**.
 *
 * Every rule in `#300 — ingestion streak derivation` counts runs that HAPPENED. A cron that stopped
 * firing — a crashed scheduler, a tick claim wedged on another instance, an env flag flipped by
 * accident — produces no runs at all, so the streak stays 0, `downstreamGated` stays false, and the
 * whole surface reports a healthy pipeline whose newest data is a day old. There was no age threshold
 * anywhere in the ingestion path before this: not in the derivation, not in `AutoPlantHealthService`
 * (which computed `ageMinutes` and then judged nothing by it), and not in the banner (which flagged
 * only a run stuck RUNNING). A 21-hour-old snapshot rendered as the quiet grey "data as of" line.
 *
 * The rule is deliberately expressed against the CONFIGURED cadence rather than a hard-coded number
 * of minutes: the cadence is an ops knob (`INGESTION_TELEMETRY_CRON`), and a threshold that does not
 * move with it is a threshold that lies the first time somebody widens the interval.
 */
const AT = new Date('2026-09-03T12:00:00.000Z');
const minutesBefore = (n: number): Date => new Date(AT.getTime() - n * 60_000);
const running = { schedulerEnabled: true, expectedCadenceMinutes: 30, now: AT };

describe('#348 — silence detection (a cron that stopped is not a healthy cron)', () => {
  it('is not overdue while a SUCCESS run is inside the 2x-cadence window', () => {
    const alert = deriveIngestionAlert([run(9, 'SUCCESS', null, minutesBefore(45))], [], 3, running);

    expect(alert.overdue).toBe(false);
    expect(alert.alert).toBe(false);
    expect(alert.silenceMinutes).toBe(45);
    expect(alert.overdueAfterMinutes).toBe(60);
  });

  it('goes overdue once the newest SUCCESS is older than 2x the cadence', () => {
    const alert = deriveIngestionAlert([run(9, 'SUCCESS', null, minutesBefore(61))], [], 3, running);

    expect(alert.overdue).toBe(true);
    // Silence is alert-grade in its own right — the OH card and the banner both key off `alert`.
    expect(alert.alert).toBe(true);
    // ...and it says so WITHOUT claiming a streak, because no run failed. Nothing did anything.
    expect(alert.streak).toBe(0);
    expect(alert.downstreamGated).toBe(false);
  });

  it('is not overdue at exactly 2x the cadence — the boundary belongs to the healthy side', () => {
    // One skipped tick is a blip; the threshold has to be crossed, not touched, or every run that
    // finishes a few seconds late pages somebody.
    expect(deriveIngestionAlert([run(9, 'SUCCESS', null, minutesBefore(60))], [], 3, running).overdue).toBe(false);
  });

  it('treats zero runs as overdue — the case the streak rules structurally cannot see (AC1)', () => {
    const alert = deriveIngestionAlert([], [], 3, running);

    expect(alert.overdue).toBe(true);
    expect(alert.silenceMinutes).toBeNull();
    expect(alert.latestStatus).toBeNull();
    expect(alert.streak).toBe(0);
  });

  it('measures silence from the newest SUCCESS, not from the newest run of any kind', () => {
    // A pipeline retrying and failing every 30 minutes is NOT quiet — but it is also not fresh. The
    // freshness clock must run from the last run that actually produced data.
    const alert = deriveIngestionAlert(
      [run(9, 'FAILED', null, minutesBefore(5)), run(8, 'SUCCESS', null, minutesBefore(200))],
      [],
      3,
      running,
    );

    expect(alert.silenceMinutes).toBe(200);
    expect(alert.overdue).toBe(true);
  });

  it('AC4 — a deliberately disabled scheduler is paused, never overdue', () => {
    const paused = { schedulerEnabled: false, expectedCadenceMinutes: 30, now: AT };
    const alert = deriveIngestionAlert([run(9, 'SUCCESS', null, minutesBefore(3000))], [], 3, paused);

    expect(alert.schedulerPaused).toBe(true);
    expect(alert.overdue).toBe(false);
    expect(alert.alert).toBe(false);
    // The age is still REPORTED — "paused" must not be a synonym for "healthy". The surface says how
    // old the data is; it just does not call an operator at 3am about a switch they threw themselves.
    expect(alert.silenceMinutes).toBe(3000);
  });

  it('AC4 — a disabled scheduler with no runs at all is paused, not an alert', () => {
    // The dev/CI steady state. Before this rule, wiring silence detection would have turned every
    // local box and every e2e run into a permanent red banner.
    const alert = deriveIngestionAlert([], [], 3, { schedulerEnabled: false, expectedCadenceMinutes: 30, now: AT });

    expect(alert.schedulerPaused).toBe(true);
    expect(alert.overdue).toBe(false);
    expect(alert.alert).toBe(false);
  });

  it('defaults to paused when no cadence is supplied — a caller that forgot cannot fabricate an alert', () => {
    const alert = deriveIngestionAlert([run(9, 'SUCCESS', null, minutesBefore(9999))], [], 3);

    expect(alert.schedulerPaused).toBe(true);
    expect(alert.overdue).toBe(false);
    expect(alert.expectedCadenceMinutes).toBe(DEFAULT_INGESTION_CADENCE_MINUTES);
  });

  it('widening the cron widens the threshold with it', () => {
    const hourly = { schedulerEnabled: true, expectedCadenceMinutes: 60, now: AT };
    const alert = deriveIngestionAlert([run(9, 'SUCCESS', null, minutesBefore(90))], [], 3, hourly);

    // 90 minutes is overdue at a 30-minute cadence and healthy at an hourly one. Same rule, one knob.
    expect(alert.overdueAfterMinutes).toBe(120);
    expect(alert.overdue).toBe(false);
    expect(deriveIngestionAlert([run(9, 'SUCCESS', null, minutesBefore(90))], [], 3, running).overdue).toBe(true);
  });

  it('a wedged streak and a silent cron can both be true, and neither hides the other', () => {
    const alert = deriveIngestionAlert(
      [
        run(9, 'PARTIAL', null, minutesBefore(2)),
        run(8, 'PARTIAL', null, minutesBefore(32)),
        run(7, 'SUCCESS', null, minutesBefore(400)),
      ],
      [],
      2,
      running,
    );

    expect(alert.streak).toBe(2);
    expect(alert.downstreamGated).toBe(true);
    expect(alert.overdue).toBe(true);
    expect(alert.alert).toBe(true);
  });

  it('the read path threads the cadence through to the derivation', async () => {
    const alert = await readIngestionAlert(
      {
        findFinalizedRuns: async () => [run(9, 'SUCCESS', null, minutesBefore(300))],
        findFailedChunks: async () => [],
      },
      3,
      running,
    );

    expect(alert.overdue).toBe(true);
    expect(alert.silenceMinutes).toBe(300);
  });
});

describe('#348 — the cadence comes from the configured cron', () => {
  it('reads the shipped telemetry and masters crons', () => {
    // The two defaults the scheduler actually registers. Imported rather than retyped, so a change to
    // the cadence cannot leave the freshness threshold behind — that drift is the whole failure mode.
    expect(cronCadenceMinutes(DEFAULT_TELEMETRY_CRON)).toBe(30);
    expect(cronCadenceMinutes(DEFAULT_MASTERS_CRON)).toBe(1440);
  });

  it('reads step, hourly, and daily forms', () => {
    expect(cronCadenceMinutes('*/5 * * * *')).toBe(5);
    expect(cronCadenceMinutes('* * * * *')).toBe(1);
    expect(cronCadenceMinutes('15 * * * *')).toBe(60);
    expect(cronCadenceMinutes('0 */6 * * *')).toBe(360);
    expect(cronCadenceMinutes('30 3 * * *')).toBe(1440);
  });

  it('tolerates the 6-field (seconds-leading) form @nestjs/schedule also accepts', () => {
    expect(cronCadenceMinutes('0 */30 * * * *')).toBe(30);
    expect(cronCadenceMinutes('0 0 2 * * *')).toBe(1440);
  });

  it('returns null for a cron it cannot reduce to a cadence, rather than guessing', () => {
    // A day-of-week or day-of-month restriction has no single interval. Guessing one would produce a
    // threshold that fires every weekend — the alert-fatigue failure that gets alerting switched off.
    expect(cronCadenceMinutes('0 2 * * 1')).toBeNull();
    expect(cronCadenceMinutes('0 2 1 * *')).toBeNull();
    expect(cronCadenceMinutes('nonsense')).toBeNull();
    expect(cronCadenceMinutes('')).toBeNull();
  });

  it('the multiplier is 2x the cadence, stated once', () => {
    expect(OVERDUE_CADENCE_MULTIPLIER).toBe(2);
  });
});
