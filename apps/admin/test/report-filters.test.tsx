import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportsPage } from '../src/pages/reports/ReportsPage';
import { RootCauseAnalyticsPage } from '../src/pages/reports/RootCauseAnalyticsPage';
import { SystemEfficiencyPage } from '../src/pages/reports/SystemEfficiencyPage';
import { ZmScorecardPage } from '../src/pages/reports/ZmScorecardPage';

/**
 * #364 — the report pages consume what the API already offers.
 *
 * Five report endpoints have accepted from / to / zone / company / plant / deviceType / SE since
 * Issues 41–43 and 90, and every client called them with **no parameters**. A manager who wanted last
 * month, or one zone, or one device type could not ask: they read the default window and did the
 * arithmetic in their head, or exported to Excel, which is where a report stops being the system's
 * answer and becomes someone's spreadsheet.
 *
 * These tests assert the two halves of that round trip separately, because only one of them was ever
 * in doubt:
 *
 * 1. the **request** carries what the operator picked, and
 * 2. the **response's echoed `filters`** is what the page then shows as its scope.
 *
 * (2) is the one that matters for a Zonal Manager. `reports.service.ts` pins a ZM to their own zone
 * (`restrictZone = scope.role === 'ZONAL_MANAGER' ? scope.zoneId : opts.zoneId`) and echoes the
 * *clamped* value back in `filters.zoneId`. A page that rendered the zone it **asked for** would tell
 * a ZM they were looking at North while the numbers were West's — a filter bar that lies is worse
 * than no filter bar. So the scope chip is rendered from the echo, never from the local pick, and
 * says so when the two disagree.
 */

const CUBE = new Date(Date.now() - 3 * 3_600_000).toISOString();

const filterOptions = {
  zones: [
    { zoneId: 1, name: 'West' },
    { zoneId: 2, name: 'North' },
  ],
  companies: [
    { companyId: 10, name: 'Acme Logistics' },
    { companyId: 11, name: 'Bharat Freight' },
  ],
  plants: [
    { plantId: 100, name: 'Bhiwandi', companyId: 10 },
    { plantId: 101, name: 'Panvel', companyId: 10 },
  ],
  hasUnzoned: false,
};

const engineers = [
  { seId: 'se-1', name: 'Karan Singh', zoneId: '1' },
  { seId: 'se-2', name: 'Amit Yadav', zoneId: '2' },
];

/** `filters` defaults to "no clamp, nothing picked" — each test overrides only what it is about. */
const rootCause = (filters: Partial<Record<string, unknown>> = {}) => ({
  fromMonth: '2026-06-01',
  toMonth: '2026-06-30',
  dataAsOf: CUBE,
  totalSubmissions: 40,
  filters: { zoneId: null, companyId: null, plantId: null, deviceType: null, seId: null, ...filters },
  distribution: [
    { category: 'GPS_ANTENNA_ISSUE', count: 20, pct: 50 },
    { category: 'POWER_ISSUE', count: 12, pct: 30 },
    { category: 'UNKNOWN', count: 8, pct: 20 },
  ],
});

const zoneMetrics = {
  failureCyclesOpened: 10, ticketsCreated: 24, troubleshootTicketsCreated: 20, autoAssignments: 18,
  manualAssignments: 6, overrides: 3, autoAssignmentRatePct: 75, manualAssignmentRatePct: 25,
  overrideRatePct: 16.7, cyclesResolved: 20, verifiedCycles: 18, failedVerifications: 2,
  autoRecoveries: 4, repeatFailures: 1, firstTimeFixes: 15, componentPauses: 0, agedResolutions: 1,
  autoEscalations: 2, repeatFailureRatePct: 5, firstTimeFixRatePct: 75, failedVerificationRatePct: 10,
  autoRecoveryRatePct: 20,
};

const efficiency = (filters: Partial<Record<string, unknown>> = {}) => ({
  from: '2026-06-01',
  to: '2026-06-30',
  dataAsOf: CUBE,
  filters: { zoneId: null, companyId: null, plantId: null, deviceType: null, seId: null, ...filters },
  fleet: zoneMetrics,
  byZone: [
    { zoneId: '1', zoneName: 'West', ...zoneMetrics },
    { zoneId: '2', zoneName: 'North', ...zoneMetrics },
  ],
});

const scorecardBase = { removals: 0, deferrals: 0, reorders: 0, swaps: 0, reassignments: 0, splitBatches: 0, overrideAfterOnsite: 0 };
const scorecard = {
  fromMonth: '2026-04-01',
  toMonth: '2026-06-01',
  zoneId: null,
  dataAsOf: CUBE,
  rows: [
    { zmId: 'zm-1', zmName: 'Asha', zoneId: 1, zoneName: 'West', overrides: 12, manualAssignments: 5, autoAssigned: 120, overrideRatePct: 10, zoneSlaCompliancePct: 97.5, ...scorecardBase },
    { zmId: 'zm-2', zmName: 'Ravi', zoneId: 2, zoneName: 'North', overrides: 30, manualAssignments: 9, autoAssigned: 130, overrideRatePct: 22, zoneSlaCompliancePct: 92, ...scorecardBase },
  ],
  trend: [
    {
      zmId: 'zm-1',
      zmName: 'Asha',
      points: [
        { month: '2026-04-01', overrides: 3, overrideAfterOnsite: 1, manualAssignments: 1, overrideRatePct: 8, zoneSlaCompliancePct: 96 },
        { month: '2026-05-01', overrides: 4, overrideAfterOnsite: 1, manualAssignments: 2, overrideRatePct: 9.5, zoneSlaCompliancePct: 97 },
        { month: '2026-06-01', overrides: 5, overrideAfterOnsite: 2, manualAssignments: 2, overrideRatePct: 12.5, zoneSlaCompliancePct: 97.5 },
      ],
    },
    {
      zmId: 'zm-2',
      zmName: 'Ravi',
      points: [
        { month: '2026-04-01', overrides: 10, overrideAfterOnsite: 4, manualAssignments: 3, overrideRatePct: 20, zoneSlaCompliancePct: 91 },
        { month: '2026-05-01', overrides: 9, overrideAfterOnsite: 3, manualAssignments: 3, overrideRatePct: 21, zoneSlaCompliancePct: 92 },
        { month: '2026-06-01', overrides: 11, overrideAfterOnsite: 5, manualAssignments: 3, overrideRatePct: 25, zoneSlaCompliancePct: 92 },
      ],
    },
  ],
};

const fleetUptime = {
  month: '2026-06',
  groupBy: 'zone',
  dataAsOf: CUBE,
  fleet: { eligibleDeviceCount: 400, uptimePct: 94.2, autoRecoveryClosures: 3, seRepairedClosures: 9 },
  rows: [{ id: '1', name: 'West', eligibleDeviceCount: 400, uptimePct: 94.2, autoRecoveryClosures: 3, seRepairedClosures: 9 }],
};

const zoneOverview = [
  { zoneId: '1', zoneName: 'West', inactiveOperational: 46, byBucket: { CRITICAL: 10, HIGH_CRITICAL: 5 } },
];

const workTypeMix = (filters: Partial<Record<string, unknown>> = {}) => ({
  from: '2026-06-01', to: '2026-06-30', total: 46, dataAsOf: CUBE,
  filters: { zoneId: null, companyId: null, plantId: null, ...filters },
  rows: [
    { workType: 'TROUBLESHOOT', count: 38, pct: 82.6 },
    { workType: 'INSTALL', count: 7, pct: 15.2 },
    { workType: 'RECOVERY', count: 1, pct: 2.2 },
  ],
});

const verificationOutcomes = {
  from: '2026-06-01', to: '2026-06-30', total: 21, fraudFlagged: 2, dataAsOf: CUBE,
  filters: { zoneId: null, companyId: null, plantId: null },
  rows: [{ outcome: 'CLOSED', count: 5, pct: 23.8 }],
};

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });

/** Report payload overrides, keyed by the path fragment they answer. */
let overrides: Record<string, unknown> = {};
const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
  const u = String(url);
  for (const [fragment, body] of Object.entries(overrides)) {
    if (u.includes(fragment)) return json(body);
  }
  if (u.includes('/devices/filter-options')) return json(filterOptions);
  if (u.includes('/engineers')) return json(engineers);
  if (u.includes('/reports/root-cause')) return json(rootCause());
  if (u.includes('/reports/efficiency')) return json(efficiency());
  if (u.includes('/reports/zm-scorecard')) return json(scorecard);
  if (u.includes('/reports/fleet-uptime')) return json(fleetUptime);
  if (u.includes('/reports/work-type-mix')) return json(workTypeMix());
  if (u.includes('/reports/verification-outcomes')) return json(verificationOutcomes);
  if (u.includes('/dashboard/zone-overview')) return json(zoneOverview);
  if (u.includes('/reports/soft-inactive-trend')) return json({ sinceDays: 14, dataAsOf: CUBE, zones: [] });
  return json({});
});

/** Every request made to `fragment`, newest last. */
const callsTo = (fragment: string) => fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes(fragment));
const lastCallTo = (fragment: string) => callsTo(fragment).at(-1) ?? '';

const at = (page: React.ReactElement, url: string) =>
  render(<MemoryRouter initialEntries={[url]}>{page}</MemoryRouter>);

beforeEach(() => {
  overrides = {};
  sessionStorage.setItem('fsm.accessToken', 'tok');
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockClear();
  sessionStorage.clear();
});

describe('#364 AC1 — every filter round-trips to the API', () => {
  it('Root Cause: the month range, company, plant, device type and SE all reach the request', async () => {
    at(<RootCauseAnalyticsPage />, '/reports/root-cause');
    await screen.findByTestId('rc-row-GPS_ANTENNA_ISSUE');

    await userEvent.selectOptions(screen.getByLabelText(/company/i), '10');
    await waitFor(() => expect(lastCallTo('/reports/root-cause')).toContain('companyId=10'));

    await userEvent.selectOptions(screen.getByLabelText(/plant/i), '100');
    await waitFor(() => expect(lastCallTo('/reports/root-cause')).toContain('plantId=100'));

    await userEvent.selectOptions(screen.getByLabelText(/engineer/i), 'se-1');
    await waitFor(() => expect(lastCallTo('/reports/root-cause')).toContain('seId=se-1'));

    await userEvent.type(screen.getByLabelText(/device type/i), 'FMB920');
    await waitFor(() => expect(lastCallTo('/reports/root-cause')).toContain('deviceType=FMB920'));

    // Months, not days — `/reports/root-cause` parses `YYYY-MM` and 400s on anything else.
    const url = lastCallTo('/reports/root-cause');
    expect(url).toContain('companyId=10');
    expect(url).toContain('plantId=100');
  });

  it('Root Cause: the date range is sent as YYYY-MM months, the granularity that endpoint parses', async () => {
    at(<RootCauseAnalyticsPage />, '/reports/root-cause?from=2026-04&to=2026-06');
    await waitFor(() => expect(lastCallTo('/reports/root-cause')).toContain('from=2026-04'));
    expect(lastCallTo('/reports/root-cause')).toContain('to=2026-06');
  });

  it('System Efficiency: the date range is sent as YYYY-MM-DD days, with every dimension', async () => {
    at(<SystemEfficiencyPage />, '/reports/system-efficiency?from=2026-06-01&to=2026-06-30&zoneId=2&deviceType=FMB920');
    await waitFor(() => expect(lastCallTo('/reports/efficiency')).toContain('from=2026-06-01'));
    const url = lastCallTo('/reports/efficiency');
    expect(url).toContain('to=2026-06-30');
    expect(url).toContain('zoneId=2');
    expect(url).toContain('deviceType=FMB920');
  });

  it('Reports landing: the month drives fleet uptime and the day range of both distributions', async () => {
    at(<ReportsPage />, '/reports?month=2026-04&companyId=10');
    await waitFor(() => expect(lastCallTo('/reports/work-type-mix')).toContain('companyId=10'));
    // The hero KPI's endpoint is single-month; the two live distributions take a day range, so the
    // picked month becomes that month's first and last day rather than a second control to keep in sync.
    expect(callsTo('/reports/fleet-uptime').some((u) => u.includes('month=2026-04'))).toBe(true);
    expect(lastCallTo('/reports/work-type-mix')).toContain('from=2026-04-01');
    expect(lastCallTo('/reports/work-type-mix')).toContain('to=2026-04-30');
    expect(lastCallTo('/reports/verification-outcomes')).toContain('companyId=10');
  });

  it('ZM Scorecard: the month range and the zone drill-down reach the request', async () => {
    at(<ZmScorecardPage />, '/reports/zm-scorecard?from=2026-04&to=2026-06&zoneId=2');
    await waitFor(() => expect(lastCallTo('/reports/zm-scorecard')).toContain('from=2026-04'));
    expect(lastCallTo('/reports/zm-scorecard')).toContain('to=2026-06');
    expect(lastCallTo('/reports/zm-scorecard')).toContain('zoneId=2');
  });

  it('sends no filter params at all when nothing is picked, so each endpoint keeps its own default window', async () => {
    at(<RootCauseAnalyticsPage />, '/reports/root-cause');
    await screen.findByTestId('rc-row-GPS_ANTENNA_ISSUE');
    expect(callsTo('/reports/root-cause')[0]).toMatch(/\/reports\/root-cause$/);
  });
});

describe('#364 AC1 — the ZM clamp is echoed, not assumed', () => {
  /**
   * The discriminating case: the page ASKS for zone 2 and the server ANSWERS with zone 1, because the
   * viewer is a Zonal Manager pinned to zone 1. The chip must read the answer.
   */
  it('Root Cause: renders the zone the server answered with, and marks it clamped', async () => {
    overrides = { '/reports/root-cause': rootCause({ zoneId: 1 }) };
    at(<RootCauseAnalyticsPage />, '/reports/root-cause?zoneId=2');

    const scope = await screen.findByTestId('root-cause-scope');
    // The request carried the pick…
    await waitFor(() => expect(lastCallTo('/reports/root-cause')).toContain('zoneId=2'));
    // …and the chip carries the server's answer.
    expect(scope).toHaveTextContent('West');
    expect(scope).not.toHaveTextContent('North');
    expect(scope).toHaveAttribute('data-clamped', 'true');
  });

  it('System Efficiency: an unclamped viewer sees the zone they picked, with no clamp marker', async () => {
    overrides = { '/reports/efficiency': efficiency({ zoneId: 2 }) };
    at(<SystemEfficiencyPage />, '/reports/system-efficiency?zoneId=2');

    const scope = await screen.findByTestId('efficiency-scope');
    expect(scope).toHaveTextContent('North');
    expect(scope).toHaveAttribute('data-clamped', 'false');
  });

  it('System Efficiency: no zone filter echoed reads as all zones, never as a blank chip', async () => {
    at(<SystemEfficiencyPage />, '/reports/system-efficiency');
    const scope = await screen.findByTestId('efficiency-scope');
    expect(scope).toHaveTextContent(/all zones/i);
  });
});

describe('#364 AC2 — the scorecard trend is drawn', () => {
  it('draws the selected ZM’s monthly series, which the client used to type `unknown[]` and discard', async () => {
    at(<ZmScorecardPage />, '/reports/zm-scorecard');
    const panel = await screen.findByTestId('zm-trend');
    // Defaults to the first series, and every month in the range is in it — the chart is a 0×0 SVG
    // under jsdom, so the assertion is on the text alternative the panel renders beside it.
    expect(panel).toHaveAttribute('data-series', 'zm-1');
    await waitFor(() => expect(within(panel).getByText('Apr 26')).toBeInTheDocument());
    expect(within(panel).getByText('Jun 26')).toBeInTheDocument();
    expect(within(panel).getByText('12.5%')).toBeInTheDocument(); // Jun override rate
  });

  it('switches series and metric without refetching the report', async () => {
    at(<ZmScorecardPage />, '/reports/zm-scorecard');
    await screen.findByTestId('zm-trend');
    const before = callsTo('/reports/zm-scorecard').length;

    await userEvent.selectOptions(screen.getByLabelText(/trend for/i), 'zm-2');
    expect(screen.getByTestId('zm-trend')).toHaveAttribute('data-series', 'zm-2');
    expect(within(screen.getByTestId('zm-trend')).getByText('25%')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^overrides$/i }));
    expect(screen.getByTestId('zm-trend')).toHaveAttribute('data-metric', 'overrides');
    // The whole series for every ZM arrived with the report; switching the drawn column must not
    // re-ask the server for numbers it already sent.
    expect(callsTo('/reports/zm-scorecard').length).toBe(before);
  });

  it('says so, rather than drawing an empty chart, when the range has no monthly rows', async () => {
    overrides = { '/reports/zm-scorecard': { ...scorecard, rows: [], trend: [] } };
    at(<ZmScorecardPage />, '/reports/zm-scorecard');
    expect(await screen.findByTestId('zm-trend')).toHaveTextContent(/no monthly trend/i);
  });
});

describe('#364 AC3 — a report number links to the rows behind it', () => {
  it('Reports landing: a zone row links to that zone’s device list', async () => {
    at(<ReportsPage />, '/reports');
    const row = await screen.findByTestId('report-zone-1');
    const link = within(row).getByRole('link', { name: 'West' });
    expect(link).toHaveAttribute('href', expect.stringContaining('/reports/device?'));
    expect(link.getAttribute('href')).toContain('zoneId=1');
  });

  it('System Efficiency: a zone row links to that zone’s device list, carrying the zone', async () => {
    at(<SystemEfficiencyPage />, '/reports/system-efficiency');
    const row = await screen.findByTestId('eff-row-2');
    const link = within(row).getByRole('link', { name: 'North' });
    expect(link.getAttribute('href')).toContain('zoneId=2');
  });

  it('ZM Scorecard: a ZM row links to that zone’s efficiency report over the same range', async () => {
    at(<ZmScorecardPage />, '/reports/zm-scorecard?from=2026-04&to=2026-06');
    const row = await screen.findByTestId('zm-row-zm-2');
    const href = within(row).getByRole('link', { name: 'North' }).getAttribute('href') ?? '';
    expect(href).toContain('/reports/system-efficiency?');
    expect(href).toContain('zoneId=2');
    // The range travels with the link — a drill-down that silently resets the window is not a drill-down.
    expect(href).toContain('from=2026-04-01');
    expect(href).toContain('to=2026-06-30');
  });
});
