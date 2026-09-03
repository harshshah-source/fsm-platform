import {
  DEFAULT_INGESTION_STREAK_THRESHOLD,
  GATED_STAGES,
  deriveIngestionAlert,
  readChunkStats,
  readIngestionAlert,
  readIngestionStreakThreshold,
  type StreakChunk,
  type StreakRun,
} from '../src/ingestion/ingestion-alert';

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
const run = (runId: number, status: StreakRun['status'], chunkStats: unknown = null): StreakRun => ({
  runId: BigInt(runId),
  status,
  chunkStats,
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
