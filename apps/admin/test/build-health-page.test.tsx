import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BuildHealthPage } from '../src/pages/admin/BuildHealthPage';
import { buildNav } from '../src/components/shell/nav';

/**
 * #131 — the OpsHead-only Build Health page: the routed drill-down for #130's L3 run attribution +
 * L5 semantic canary. Superset of what `BuildHealthNotice` (the global-banner summary alert)
 * already flags — the current build high-water mark, per-freshness staleBuild flags, and the last-N
 * recompute history with swing rows highlighted.
 */
const HEALTH = {
  runtimeLock: { version: '200', fingerprint: 'currentsha' },
  masterSync: { build: { buildVersion: '100', buildFingerprint: 'stalesha', staleBuild: true } },
  snapshot: { build: { buildVersion: '200', buildFingerprint: 'currentsha', staleBuild: false } },
  recomputes: [
    {
      recomputeId: '2',
      computedAt: '2026-07-19T18:30:00.000Z',
      eligibleCount: 21000,
      inactiveCount: 3000,
      departedCount: 0,
      totalCount: 21322,
      buildVersion: '100',
      buildFingerprint: 'stalesha',
      trigger: 'cron',
      staleBuild: true,
      swingPct: 33.0,
      swing: true,
    },
    {
      recomputeId: '1',
      computedAt: '2026-07-19T17:30:00.000Z',
      eligibleCount: 15799,
      inactiveCount: 3000,
      departedCount: 5523,
      totalCount: 21322,
      buildVersion: '200',
      buildFingerprint: 'currentsha',
      trigger: 'cron',
      staleBuild: false,
      swingPct: null,
      swing: false,
    },
  ],
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

describe('Build Health nav gating (#131)', () => {
  const link = (role: string) =>
    buildNav(role)
      .flatMap((g) => g.items)
      .find((i) => i.to === '/build-health');

  it('shows the nav entry only to the Operations Head', () => {
    expect(link('OPERATIONS_HEAD')).toBeDefined();
    expect(link('ZONAL_MANAGER')).toBeUndefined();
    expect(link('CENTRAL_SERVICE_MANAGER')).toBeUndefined();
    expect(link('SERVICE_ENGINEER')).toBeUndefined();
    expect(link('WAREHOUSE_MANAGER')).toBeUndefined();
  });
});

describe('Build Health page (#131)', () => {
  it('shows the current build high-water mark and per-freshness staleBuild flags', async () => {
    fetchMock.mockImplementation(async () => json(HEALTH));
    render(<BuildHealthPage />);

    expect(await screen.findByText(/v200/)).toBeInTheDocument();

    const masterSync = within(screen.getByTestId('build-health-master-sync'));
    expect(masterSync.getByText(/stale/i)).toBeInTheDocument();
    const snapshot = within(screen.getByTestId('build-health-snapshot'));
    expect(snapshot.queryByText(/stale/i)).not.toBeInTheDocument();
  });

  it('renders the last-N recompute history with the swing row highlighted', async () => {
    fetchMock.mockImplementation(async () => json(HEALTH));
    render(<BuildHealthPage />);

    const swingRow = await screen.findByTestId('recompute-row-2');
    expect(swingRow).toHaveTextContent('21,000');
    expect(swingRow).toHaveTextContent('stalesha');
    expect(swingRow).toHaveTextContent('cron');
    expect(swingRow).toHaveAttribute('aria-current', 'true'); // swing-highlighted

    const normalRow = screen.getByTestId('recompute-row-1');
    expect(normalRow).toHaveTextContent('15,799');
    expect(normalRow).not.toHaveAttribute('aria-current');
  });

  it('shows an empty state when there is no recompute history yet', async () => {
    fetchMock.mockImplementation(async () => json({ ...HEALTH, recomputes: [] }));
    render(<BuildHealthPage />);

    expect(await screen.findByText(/no recompute history/i)).toBeInTheDocument();
  });
});

/**
 * #300 AC1 — a wedged pipeline must be visible on this page within one page load, naming the failing
 * chunk and the stages the #230 gate is skipping.
 *
 * The state it renders is not exotic: three PARTIAL runs in a row is what AR-1 produced, and until
 * now the ONLY trace was a WARN log line. `HEALTH` above deliberately carries no `ingestion` section
 * so the existing #131 cases double as the absent-state check (an older payload renders no card and
 * does not crash the page).
 */
const WEDGED = {
  streak: 3,
  threshold: 3,
  alert: true,
  latestStatus: 'PARTIAL',
  downstreamGated: true,
  gatedStages: ['device-state derivation', 'auto-recovery', 'ticket creation'],
  failingChunk: {
    runId: '451',
    chunkNo: 7,
    retryCount: 2,
    error: 'device 0869925073271551: unparseable latest_gps_datetime',
  },
  repeatingFailure: true,
  rejected: { UNPARSEABLE_TIMESTAMP: 3 },
  repaired: { MAINS_VOLTAGE_OUT_OF_RANGE: 6 },
};

describe('#300 — wedged-ingestion card', () => {
  it('names the streak, the failing chunk and its error, and the gated stages', async () => {
    fetchMock.mockImplementation(async () => json({ ...HEALTH, ingestion: WEDGED }));
    render(<BuildHealthPage />);

    const card = await screen.findByTestId('ingestion-alert');
    expect(card).toHaveTextContent(/3 consecutive telemetry runs did not complete/i);

    const chunk = within(card).getByTestId('ingestion-failing-chunk');
    expect(chunk).toHaveTextContent('451');
    expect(chunk).toHaveTextContent('#7');
    expect(chunk).toHaveTextContent(/unparseable latest_gps_datetime/);
    expect(chunk).toHaveTextContent(/same error every run/i);

    const stages = within(card).getByTestId('ingestion-gated-stages');
    expect(stages).toHaveTextContent(/device-state derivation/i);
    expect(stages).toHaveTextContent(/auto-recovery/i);
    expect(stages).toHaveTextContent(/ticket creation/i);
  });

  it('reports #299 rejected and repaired totals by reason', async () => {
    fetchMock.mockImplementation(async () => json({ ...HEALTH, ingestion: WEDGED }));
    render(<BuildHealthPage />);

    const rejections = await screen.findByTestId('ingestion-rejections');
    // Rows dropped and fields repaired are different facts and must not be summed into one number.
    expect(rejections).toHaveTextContent(/UNPARSEABLE_TIMESTAMP ×3/);
    expect(rejections).toHaveTextContent(/MAINS_VOLTAGE_OUT_OF_RANGE ×6/);
  });

  it('says so when the source read died with no chunk to blame', async () => {
    fetchMock.mockImplementation(async () =>
      json({
        ...HEALTH,
        ingestion: { ...WEDGED, failingChunk: null, repeatingFailure: false, rejected: {}, repaired: {} },
      }),
    );
    render(<BuildHealthPage />);

    const card = await screen.findByTestId('ingestion-alert');
    expect(card).toHaveTextContent(/no chunk write failed/i);
    expect(within(card).queryByTestId('ingestion-rejections')).not.toBeInTheDocument();
  });

  it('renders nothing at all when ingestion is healthy', async () => {
    fetchMock.mockImplementation(async () =>
      json({
        ...HEALTH,
        ingestion: { ...WEDGED, streak: 0, alert: false, latestStatus: 'SUCCESS', downstreamGated: false, gatedStages: [] },
      }),
    );
    render(<BuildHealthPage />);

    // The page has to stay quiet in the steady state, or the card becomes wallpaper.
    expect(await screen.findByText(/v200/)).toBeInTheDocument();
    expect(screen.queryByTestId('ingestion-alert')).not.toBeInTheDocument();
  });

  it('renders nothing when the payload predates #300', async () => {
    fetchMock.mockImplementation(async () => json(HEALTH));
    render(<BuildHealthPage />);

    expect(await screen.findByText(/v200/)).toBeInTheDocument();
    expect(screen.queryByTestId('ingestion-alert')).not.toBeInTheDocument();
  });
});

/**
 * #349 — the four sections the page dropped.
 *
 * The backend has always returned source connectivity, both freshness ages, reconciliation and the
 * #218 lifecycle check; the view type modelled four fields of it and the page drew three cards. The
 * effect was a page that could not answer the one question it exists for — is the pipeline working
 * right now, and if not, since when — while the answer sat in the payload it was already fetching.
 *
 * `GET /snapshots/runs` had no consumer at all: the run history here is its first one.
 */
const RUN = (runId: string, status: string, over: Record<string, unknown> = {}) => ({
  runId,
  status,
  startedAt: '2026-09-03T05:30:00.000Z',
  finishedAt: '2026-09-03T05:34:00.000Z',
  dataAsOf: '2026-09-03T05:30:00.000Z',
  error: null,
  ...over,
});

const RUNS = [RUN('901', 'SUCCESS'), RUN('900', 'FAILED', { dataAsOf: null, error: 'ORPHANED_RUN_ERROR' })];

const FULL = {
  ...HEALTH,
  source: { configured: true, connected: true, vehicleRows: 21322 },
  masterSync: {
    ...HEALTH.masterSync,
    lastAt: '2026-09-03T04:00:00.000Z',
    lastStatus: 'SUCCESS',
    ageMinutes: 130,
    staleAfterMinutes: 2880,
    stale: false,
  },
  snapshot: {
    ...HEALTH.snapshot,
    lastAt: '2026-09-02T07:00:00.000Z',
    lastStatus: 'PARTIAL',
    ageMinutes: 21 * 60,
    staleAfterMinutes: 60,
    stale: true,
  },
  reconciliation: { entities: [], reconciled: null, maxDriftAllowed: 0 },
  lifecycle: {
    drift: 5134,
    missingFromSource: 212,
    quietRuns: 27,
    quietRunsAlert: true,
    quietRunsThreshold: 3,
    healthy: false,
    runs: [
      {
        runId: '512',
        startedAt: '2026-09-03T02:00:00.000Z',
        finishedAt: '2026-09-03T02:12:00.000Z',
        status: 'SUCCESS',
        departed: 212,
        restored: 37,
        ticketsAutoClosed: 41,
        skippedByReason: {},
        quiet: false,
      },
      {
        runId: '511',
        startedAt: '2026-09-02T02:00:00.000Z',
        finishedAt: '2026-09-02T02:09:00.000Z',
        status: 'SUCCESS',
        departed: 0,
        restored: 0,
        ticketsAutoClosed: 0,
        skippedByReason: { ABSENCE_GUARD_TRIPPED: 1 },
        quiet: true,
      },
    ],
  },
  schedulerEnabled: true,
  checkedAt: '2026-09-03T06:10:00.000Z',
};

/** Route by URL — the page now reads two endpoints, and the run history is the second. */
const stub = (health: unknown = FULL, runs: unknown = RUNS) => {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : String(input);
    return url.includes('/snapshots/runs') ? json(runs) : json(health);
  });
};

/** The query string of the most recent `/snapshots/runs` call. */
const lastRunsUrl = (): string => {
  const calls = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/snapshots/runs'));
  return calls[calls.length - 1] ?? '';
};

describe('#349 — connectivity and freshness', () => {
  it('AC1 — names the source and whether it is reachable right now', async () => {
    stub();
    render(<BuildHealthPage />);

    const card = await screen.findByTestId('integration-source');
    expect(card).toHaveTextContent(/connected/i);
    expect(card).toHaveTextContent('21,322');
  });

  it('AC1 — an unreachable source states the reason instead of reading as healthy', async () => {
    stub({ ...FULL, source: { configured: true, connected: false, error: 'ETIMEDOUT 10.8.0.1:3306' } });
    render(<BuildHealthPage />);

    const card = await screen.findByTestId('integration-source');
    expect(card).toHaveTextContent(/not reachable|disconnected/i);
    expect(card).toHaveTextContent(/ETIMEDOUT/);
  });

  it('AC1 — freshness shows the age AND the threshold it is judged against', async () => {
    stub();
    render(<BuildHealthPage />);

    const snapshot = within(await screen.findByTestId('freshness-snapshot'));
    // The 21-hour snapshot the survey found reading as an ordinary timestamp.
    expect(snapshot.getByText(/21 h/)).toBeInTheDocument();
    expect(snapshot.getByText(/stale/i)).toBeInTheDocument();
    // An age with no yardstick is not actionable — the number it was measured against is on screen,
    // in the same units grammar as the age so the two can be read against each other.
    expect(screen.getByTestId('freshness-snapshot')).toHaveTextContent(/threshold 1 h/i);

    const master = within(screen.getByTestId('freshness-masterSync'));
    expect(master.queryByText(/^stale$/i)).not.toBeInTheDocument();
  });

  it('AC1 — a deliberately paused scheduler reads as paused, never as fresh or as a fault', async () => {
    stub({ ...FULL, schedulerEnabled: false, snapshot: { ...FULL.snapshot, stale: false } });
    render(<BuildHealthPage />);

    expect(await screen.findByTestId('scheduler-paused')).toHaveTextContent(/paused/i);
  });
});

describe('#349 / #224 — the lifecycle check reaches a screen', () => {
  it('AC1 — drift reads as a contradiction, with missingFromSource beside it, not folded in', async () => {
    stub();
    render(<BuildHealthPage />);

    const drift = await screen.findByTestId('lifecycle-drift');
    expect(drift).toHaveTextContent('5,134');
    // #224: its correct value is exactly 0. It must not read like a tolerance band.
    expect(drift).toHaveTextContent(/contradict/i);

    // The excluded population is surfaced, never hidden inside drift (218a's whole point).
    const missing = screen.getByTestId('lifecycle-missing-from-source');
    expect(missing).toHaveTextContent('212');
    expect(drift).not.toHaveTextContent('212');
  });

  it('AC1 — quiet runs past the threshold are called out, with the threshold', async () => {
    stub();
    render(<BuildHealthPage />);

    const quiet = await screen.findByTestId('lifecycle-quiet-runs');
    expect(quiet).toHaveTextContent('27');
    expect(quiet).toHaveTextContent('3');
  });

  it('AC3 — departures, restores and departure-auto-closed tickets, per run', async () => {
    stub();
    render(<BuildHealthPage />);

    const row = await screen.findByTestId('lifecycle-run-512');
    expect(row).toHaveTextContent('212');
    expect(row).toHaveTextContent('37');
    expect(row).toHaveTextContent('41');

    // A run that moved nothing is the #218 signal, so it is shown as quiet rather than dropped.
    expect(screen.getByTestId('lifecycle-run-511')).toHaveTextContent(/quiet/i);
  });
});

describe('#349 — snapshot run history (AC2)', () => {
  it('renders the run history GET /snapshots/runs has never had a consumer for', async () => {
    stub();
    render(<BuildHealthPage />);

    const ok = await screen.findByTestId('snapshot-run-901');
    expect(ok).toHaveTextContent('SUCCESS');

    // #348's reaped-run reason: a process restart must be distinguishable from an ingestion failure.
    expect(screen.getByTestId('snapshot-run-900')).toHaveTextContent('ORPHANED_RUN_ERROR');
  });

  it('filters by status', async () => {
    stub();
    render(<BuildHealthPage />);
    await screen.findByTestId('snapshot-run-901');

    await userEvent.selectOptions(screen.getByLabelText(/run status/i), 'FAILED');

    await waitFor(() => expect(lastRunsUrl()).toMatch(/status=FAILED/));
  });

  it('pages, and cannot page past the end', async () => {
    stub(FULL, [RUN('901', 'SUCCESS')]);
    render(<BuildHealthPage />);
    await screen.findByTestId('snapshot-run-901');

    // A short page is the last page — a pager that keeps offering "next" over an endpoint with no
    // total is how an operator ends up staring at an empty table.
    expect(screen.getByTestId('snapshot-runs-next')).toBeDisabled();
    expect(screen.getByTestId('snapshot-runs-prev')).toBeDisabled();
  });

  it('pages forward when the page came back full', async () => {
    const full = Array.from({ length: 20 }, (_, i) => RUN(String(900 + i), 'SUCCESS'));
    stub(FULL, full);
    render(<BuildHealthPage />);
    await screen.findByTestId('snapshot-run-900');

    await userEvent.click(screen.getByTestId('snapshot-runs-next'));

    await waitFor(() => expect(lastRunsUrl()).toMatch(/offset=20/));
  });

  it('an older payload without the new sections still renders the page', async () => {
    // Upgrade order: a new FE against a not-yet-deployed BE must degrade, not white-screen.
    stub(HEALTH, []);
    render(<BuildHealthPage />);

    expect(await screen.findByText(/v200/)).toBeInTheDocument();
    expect(screen.queryByTestId('lifecycle-drift')).not.toBeInTheDocument();
    expect(screen.queryByTestId('integration-source')).not.toBeInTheDocument();
  });
});
