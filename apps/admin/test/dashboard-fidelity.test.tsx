import type { SessionView } from '@fsm/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { SnapshotHealthBadge } from '../src/components/dashboard/SnapshotHealthBadge';
import { DashboardHome } from '../src/pages/dashboard/DashboardHome';
import { EscalationQueueList } from '../src/pages/dashboard/EscalationQueueList';
import { ZoneOverviewTable } from '../src/pages/dashboard/ZoneOverviewTable';
import { useAssignDraft } from '../src/pages/assign/useAssignDraft';
import type { CriticalQueueGroup, ZoneOverviewRow } from '../src/api/dashboard';

// AC5 is asserted on the CSV **body**, so the whole chain runs for real (DOM read → `toCsv`) and only
// the browser's own file-save is intercepted — jsdom's `Blob` has no `.text()` to read it back from.
vi.mock('../src/lib/csv', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/csv')>();
  return { ...actual, downloadCsv: vi.fn() };
});
import { downloadCsv } from '../src/lib/csv';
const downloadCsvMock = vi.mocked(downloadCsv);

/**
 * #351 — dashboard fidelity.
 *
 * Six places where the dashboard asserted something it did not know. Each case here pins the fact the
 * surface is now allowed to state, and — for the badge — the fact it is NOT allowed to state: a green
 * "healthy" pill that is a string literal is worse than no pill at all, because it survives the
 * pipeline it claims to describe.
 */
const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };
const csm: SessionView = { user_id: 'csm1', role: 'CENTRAL_SERVICE_MANAGER', zone_id: null, acted_as_role: null };
const oh: SessionView = { user_id: 'oh1', role: 'OPERATIONS_HEAD', zone_id: null, acted_as_role: null };

const zoneRow = (over: Partial<ZoneOverviewRow> = {}): ZoneOverviewRow => ({
  zoneId: '1',
  zoneName: 'NORTH',
  zonalManagerName: 'Asha Rao',
  mirroredDevices: 120,
  operationalDevices: 100,
  warehouseDevices: 20,
  reportingOperational: 90,
  inactiveOperational: 13,
  healthyOperational: 77,
  neverReported: 10,
  inactivePct: 14.4,
  fleetHealthPct: 85.6,
  byBucket: { CRITICAL: 3, WARNING: 2 },
  trendPctVsPrevDay: null,
  ...over,
});

const group = (over: Partial<CriticalQueueGroup> = {}): CriticalQueueGroup => ({
  companyId: '10',
  companyName: 'Acme Logistics',
  companyTier: 'PLATINUM',
  zoneId: '1',
  plantId: '7',
  plantName: 'Yard-1',
  clusterSize: 1,
  tickets: [{ ticketId: 't1', deviceId: '900', slaBucket: 'CRITICAL', latestGpsDatetime: null, status: 'OPEN' }],
  ...over,
});

/** A `/snapshots/latest` payload in whatever freshness state a case needs. */
function snapshotLatest(over: Record<string, unknown> = {}) {
  return {
    dataAsOf: '2026-09-03T09:30:00.000Z',
    lastSuccessAt: '2026-09-03T09:30:00.000Z',
    latest: {
      runId: 'r1',
      status: 'SUCCESS',
      startedAt: '2026-09-03T09:25:00.000Z',
      finishedAt: '2026-09-03T09:30:00.000Z',
      dataAsOf: '2026-09-03T09:30:00.000Z',
      error: null,
    },
    partialDataAsOf: null,
    overdue: false,
    schedulerPaused: false,
    ingestion: {
      streak: 0,
      threshold: 3,
      alert: false,
      latestStatus: 'SUCCESS',
      downstreamGated: false,
      gatedStages: [],
      failingChunk: null,
      repeatingFailure: false,
      rejected: {},
      repaired: {},
      silenceMinutes: 12,
      expectedCadenceMinutes: 30,
      overdueAfterMinutes: 60,
      schedulerPaused: false,
      overdue: false,
    },
    ...over,
  };
}

/** An empty but well-shaped `GET /schedules/assignable-work` page — the console's own pool read. */
const emptyPool = {
  date: '2026-09-03',
  totals: { openUnassigned: 0, criticalCount: 0, heldCount: 0, plants: 0 },
  companies: [],
};

/** Routes every dashboard read to a body the case chose; anything unnamed answers `[]`. */
function stubApi(bodies: Record<string, unknown> = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      for (const [fragment, body] of Object.entries(bodies)) {
        if (url.includes(fragment)) {
          if (body === 'ERROR') return new Response('{}', { status: 500 });
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

function renderBadge(over: Record<string, unknown> = {}) {
  stubApi({ 'snapshots/latest': snapshotLatest(over) });
  return render(
    <AuthProvider initialSession={zm}>
      <SnapshotHealthBadge />
    </AuthProvider>,
  );
}

function renderHome(session: SessionView, bodies: Record<string, unknown> = {}) {
  stubApi(bodies);
  return render(
    <AuthProvider initialSession={session}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<DashboardHome />} />
          <Route path="/assign" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-probe">{`${location.pathname}${location.search}`}</div>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

// ---- AC1 — the freshness badge ----------------------------------------------------------------

describe('#351 AC1 — SnapshotHealthBadge', () => {
  it('says Healthy only when the latest snapshot really is fresh, and carries its age', async () => {
    renderBadge();

    const badge = await screen.findByTestId('snapshot-health-badge');
    expect(badge).toHaveTextContent(/snapshot healthy/i);
    expect(screen.getByTestId('snapshot-health-age')).toHaveTextContent(/12 min old/i);
  });

  it('says Stale — never Healthy — when ingestion is overdue', async () => {
    renderBadge({ overdue: true, ingestion: { ...snapshotLatest().ingestion, overdue: true, silenceMinutes: 130 } });

    const badge = await screen.findByTestId('snapshot-health-badge');
    expect(badge).toHaveTextContent(/snapshot stale/i);
    expect(badge).not.toHaveTextContent(/healthy/i);
    // The figure is what separates one missed tick from a dead scheduler (#348 / #349).
    expect(screen.getByTestId('snapshot-health-age')).toHaveTextContent(/2 h 10 min old/i);
  });

  it('reports a FAILED latest run as failed', async () => {
    renderBadge({ latest: { ...snapshotLatest().latest, status: 'FAILED' } });

    expect(await screen.findByTestId('snapshot-health-badge')).toHaveTextContent(/snapshot failed/i);
  });

  it('reports a deliberately paused scheduler as paused, not as an alarm and not as healthy', async () => {
    renderBadge({ schedulerPaused: true, ingestion: { ...snapshotLatest().ingestion, schedulerPaused: true } });

    const badge = await screen.findByTestId('snapshot-health-badge');
    expect(badge).toHaveTextContent(/ingestion paused/i);
    expect(badge).not.toHaveTextContent(/healthy/i);
  });

  it('reports a wedged pipeline (#300 downstream gate) rather than the last good timestamp', async () => {
    renderBadge({
      ingestion: { ...snapshotLatest().ingestion, alert: true, downstreamGated: true, gatedStages: ['device-state'], streak: 3 },
    });

    expect(await screen.findByTestId('snapshot-health-badge')).toHaveTextContent(/snapshot gated/i);
  });

  it('states an unreadable endpoint instead of falling back to a green pill', async () => {
    stubApi({ 'snapshots/latest': 'ERROR' });
    render(
      <AuthProvider initialSession={zm}>
        <SnapshotHealthBadge />
      </AuthProvider>,
    );

    expect(await screen.findByTestId('snapshot-health-badge')).toHaveTextContent(/snapshot unavailable/i);
  });

  it('replaces the literal on the ZM and CSM dashboards', async () => {
    for (const session of [zm, csm]) {
      const view = renderHome(session, { 'snapshots/latest': snapshotLatest({ overdue: true }) });
      expect(await screen.findByTestId('snapshot-health-badge')).toHaveTextContent(/snapshot stale/i);
      // The old hardcoded pill is gone: nothing may say "Healthy" while the feed is overdue.
      expect(screen.queryByText('Snapshot Healthy')).not.toBeInTheDocument();
      view.unmount();
      vi.unstubAllGlobals();
    }
  });

  it('replaces the literal on the Warehouse dashboard too', async () => {
    const wm: SessionView = { user_id: 'wm1', role: 'WAREHOUSE_MANAGER', zone_id: 1, acted_as_role: null };
    renderHome(wm, { 'snapshots/latest': snapshotLatest({ overdue: true }) });

    expect(await screen.findByTestId('snapshot-health-badge')).toHaveTextContent(/snapshot stale/i);
    expect(screen.queryByText('Snapshot Healthy')).not.toBeInTheDocument();
  });
});

// ---- AC2 — the trend column ------------------------------------------------------------------

describe('#351 AC2 — Zone Overview trend', () => {
  // The table's inactive-count cell is a `Link`, so it needs a router around it.
  const renderTable = (rows: ZoneOverviewRow[]) =>
    render(
      <MemoryRouter>
        <ZoneOverviewTable rows={rows} />
      </MemoryRouter>,
    );

  it('renders a signed percentage with its direction when the backend has one', () => {
    renderTable([zoneRow({ trendPctVsPrevDay: 30 })]);

    expect(screen.getByTestId('trend')).toHaveTextContent('+30%');
  });

  it('renders a fall as a negative, not as an unsigned number', () => {
    renderTable([zoneRow({ trendPctVsPrevDay: -6.4 })]);

    expect(screen.getByTestId('trend')).toHaveTextContent('-6.4%');
  });

  it('still renders an em dash when there is no comparison, so "no reading" never reads as 0%', () => {
    renderTable([zoneRow({ trendPctVsPrevDay: null })]);

    expect(screen.getByTestId('trend')).toHaveTextContent('—');
    expect(screen.getByTestId('trend')).not.toHaveTextContent('0%');
  });
});

// ---- AC3 — operating mode --------------------------------------------------------------------

describe('#351 AC3 — operating mode is mounted', () => {
  const modeRows = [
    { zoneId: '1', zoneName: 'NORTH', mode: 'DEFICIT', silentCount: 40, eligibleCount: 100 },
    { zoneId: '2', zoneName: 'SOUTH', mode: 'PREVENTIVE', silentCount: 1, eligibleCount: 100 },
  ];

  it('shows the ZM their own-zone operating-mode card', async () => {
    renderHome(zm, { 'dashboard/operating-mode': [modeRows[0]] });

    expect(await screen.findByTestId('zone-operating-mode-card')).toBeInTheDocument();
    expect(screen.queryByTestId('zone-operating-mode-table')).not.toBeInTheDocument();
  });

  it('shows the CSM the cross-zone operating-mode table', async () => {
    renderHome(csm, { 'dashboard/operating-mode': modeRows });

    const table = await screen.findByTestId('zone-operating-mode-table');
    expect(within(table).getByTestId('zone-mode-row-1')).toBeInTheDocument();
    expect(within(table).getByTestId('zone-mode-row-2')).toBeInTheDocument();
  });

  it('shows the Operations Head the same cross-zone table', async () => {
    renderHome(oh, { 'dashboard/operating-mode': modeRows });

    expect(await screen.findByTestId('zone-operating-mode-table')).toBeInTheDocument();
  });
});

// ---- AC4 — escalation grouping ---------------------------------------------------------------

describe('#351 AC4 — the escalation queue keeps its clusters', () => {
  const clustered = group({
    clusterSize: 3,
    tickets: [
      { ticketId: 't1', deviceId: '901', slaBucket: 'CRITICAL', latestGpsDatetime: null, status: 'OPEN' },
      { ticketId: 't2', deviceId: '902', slaBucket: 'SEVERE', latestGpsDatetime: null, status: 'OPEN' },
      { ticketId: 't3', deviceId: '903', slaBucket: 'CRITICAL', latestGpsDatetime: null, status: 'OPEN' },
    ],
  });
  const lone = group({
    companyId: '11',
    companyName: 'Beta Cement',
    companyTier: 'GOLD',
    plantId: '9',
    plantName: 'Yard-9',
    clusterSize: 1,
    tickets: [{ ticketId: 't9', deviceId: '999', slaBucket: 'RISK', latestGpsDatetime: null, status: 'OPEN' }],
  });

  it('renders one group per company/plant, carrying the cluster count', () => {
    render(<EscalationQueueList groups={[lone, clustered]} />);

    const groups = screen.getAllByTestId('escalation-group');
    expect(groups).toHaveLength(2);
    // Worst-first: the 3-ticket SEVERE cluster outranks a lone RISK row.
    expect(groups[0]).toHaveTextContent('Yard-1');
    expect(within(groups[0]).getByTestId('escalation-cluster-size')).toHaveTextContent('3');
    expect(within(groups[0]).getAllByTestId('escalation-item')).toHaveLength(3);
    expect(within(groups[1]).getByTestId('escalation-cluster-size')).toHaveTextContent('1');
  });

  it('names the company and plant once, on the group, not on every row', () => {
    render(<EscalationQueueList groups={[clustered]} />);

    expect(screen.getAllByText(/Acme Logistics/)).toHaveLength(1);
    expect(screen.getByText(/3 open/)).toBeInTheDocument();
  });

  it('says so plainly when nothing is escalated', () => {
    render(<EscalationQueueList groups={[]} />);

    expect(screen.getByText(/no cross-zone escalations/i)).toBeInTheDocument();
    expect(screen.queryByTestId('escalation-group')).not.toBeInTheDocument();
  });
});

// ---- AC5 — CSV export ------------------------------------------------------------------------

describe('#351 AC5 — Zone Overview CSV export', () => {
  beforeEach(() => downloadCsvMock.mockClear());

  it('downloads the rows currently visible, with a header row and the trend as a bare number', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ZoneOverviewTable
          rows={[
            zoneRow({ zoneId: '1', zoneName: 'NORTH', trendPctVsPrevDay: 30 }),
            zoneRow({ zoneId: '2', zoneName: 'SOUTH', trendPctVsPrevDay: null }),
          ]}
        />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'Download Zone Overview' }));
    await user.click(await screen.findByRole('menuitem', { name: 'CSV' }));

    expect(downloadCsvMock).toHaveBeenCalledTimes(1);
    const [filename, csv] = downloadCsvMock.mock.calls[0];
    expect(filename).toMatch(/\.csv$/);
    expect(csv).toContain('NORTH');
    expect(csv).toContain('SOUTH');
    // The arrow glyph belongs on screen, not in a spreadsheet column somebody wants to sort.
    expect(csv).toContain('30');
    expect(csv).not.toContain('▲');
  });

  it('exports only the filtered view — the download equals what is on screen', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ZoneOverviewTable
          rows={[zoneRow({ zoneId: '1', zoneName: 'NORTH' }), zoneRow({ zoneId: '2', zoneName: 'SOUTH' })]}
        />
      </MemoryRouter>,
    );

    await user.selectOptions(screen.getByLabelText('Filter by zone'), 'SOUTH');
    await user.click(screen.getByRole('button', { name: 'Download Zone Overview' }));
    await user.click(await screen.findByRole('menuitem', { name: 'CSV' }));

    const [, csv] = downloadCsvMock.mock.calls[0];
    expect(csv).toContain('SOUTH');
    expect(csv).not.toContain('NORTH');
  });
});

// ---- AC6 — the Critical+ pointer back to the console ------------------------------------------

describe('#351 AC6 — Critical+ summary tile', () => {
  it('gives the ZM a Critical+ count and opens the Assign Console preset', async () => {
    const user = userEvent.setup();
    renderHome(zm, {
      'dashboard/critical-queue': [
        group({ clusterSize: 2, tickets: [
          { ticketId: 't1', deviceId: '901', slaBucket: 'CRITICAL', latestGpsDatetime: null, status: 'OPEN' },
          { ticketId: 't2', deviceId: '902', slaBucket: 'SEVERE', latestGpsDatetime: null, status: 'OPEN' },
        ] }),
      ],
    });

    const tile = await screen.findByTestId('kpi-critical-plus-queue');
    expect(tile).toHaveTextContent('2');
    expect(tile).toHaveTextContent(/critical\+/i);

    await user.click(tile);
    expect(await screen.findByTestId('location-probe')).toHaveTextContent('/assign?filter=critical-plus');
  });
});

// ---- AC6 (second half) — the console honours the preset ---------------------------------------

function DraftProbe() {
  const draft = useAssignDraft();
  return (
    <div>
      <span data-testid="critical-only">{String(draft.criticalOnly)}</span>
      <button type="button" onClick={() => draft.setCriticalOnly(false)}>
        clear
      </button>
    </div>
  );
}

describe('#351 AC6 — useAssignDraft URL preset', () => {
  it('opens with the Critical+ pool filter on when the URL asks for it', async () => {
    stubApi({ 'schedules/assignable-work': emptyPool });
    render(
      <AuthProvider initialSession={zm}>
        <MemoryRouter initialEntries={['/assign?filter=critical-plus']}>
          <DraftProbe />
        </MemoryRouter>
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('critical-only')).toHaveTextContent('true'));
  });

  it('leaves the filter off without the preset, and lets the operator clear a preset', async () => {
    const user = userEvent.setup();
    stubApi({ 'schedules/assignable-work': emptyPool });
    const plain = render(
      <AuthProvider initialSession={zm}>
        <MemoryRouter initialEntries={['/assign']}>
          <DraftProbe />
        </MemoryRouter>
      </AuthProvider>,
    );
    expect(screen.getByTestId('critical-only')).toHaveTextContent('false');
    plain.unmount();

    render(
      <AuthProvider initialSession={zm}>
        <MemoryRouter initialEntries={['/assign?filter=critical-plus']}>
          <DraftProbe />
        </MemoryRouter>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('critical-only')).toHaveTextContent('true'));
    // The preset seeds the filter; it does not pin it. A re-render must not re-force it.
    await user.click(screen.getByRole('button', { name: 'clear' }));
    expect(screen.getByTestId('critical-only')).toHaveTextContent('false');
  });
});
