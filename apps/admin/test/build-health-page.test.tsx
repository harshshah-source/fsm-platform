import { render, screen, within } from '@testing-library/react';
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
