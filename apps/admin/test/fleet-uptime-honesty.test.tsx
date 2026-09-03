import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFleetUptimeTrend } from '../src/api/reports';
import { ReportsPage } from '../src/pages/reports/ReportsPage';

/**
 * #346 — **Fleet-uptime honesty.** The backend used to answer `100` for a month with no eligible
 * device-time, and the client had no guard, so the Reports page opened on the current month — the one
 * month the cube cron never wrote — and showed a perfect fleet. The trend read `100, 100, 100, 56.19,
 * 100, 100`: five fabrications and one real number, drawn as one continuous line.
 *
 * The distinction these tests exist to pin is between **a gap and a zero**. A month with no data must
 * not be plotted at all — not at 0, not at 100 — and must keep its label on the axis so the reader can
 * see *which* month is missing. A dropped point silently renames the axis; a plotted zero invents a
 * catastrophe; a plotted 100 invents a perfect month. Only a null is the truth.
 */

const withUptime = (month: string, uptimePct: number | null, eligibleDeviceCount: number) => ({
  month,
  groupBy: 'zone',
  fleet: { eligibleDeviceCount, uptimePct, autoRecoveryClosures: 0, seRepairedClosures: 0 },
  rows:
    eligibleDeviceCount > 0
      ? [{ id: '1', name: 'West', eligibleDeviceCount, uptimePct, autoRecoveryClosures: 0, seRepairedClosures: 0 }]
      : [],
});

const zones = [
  {
    zoneId: '1',
    zoneName: 'West',
    operationalDevices: 200,
    inactiveOperational: 46,
    healthyOperational: 154,
    warehouseDevices: 30,
    mirroredDevices: 230,
    inactivePct: 23,
    fleetHealthPct: 77,
    byBucket: { CRITICAL: 10, HIGH_CRITICAL: 5 },
    trendPctVsPrevDay: null,
  },
];

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

/** TrendChart is a recharts surface with no measurable box in jsdom, so the assertion has to be made
 *  on what it is *handed*. Serialising the series is the only way to tell a gap from a plotted zero. */
vi.mock('../src/components/charts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/components/charts')>();
  return {
    ...actual,
    TrendChart: ({ data }: { data: { label: string; value: number | null }[] }) => (
      <div data-testid="trend-chart" data-series={JSON.stringify(data)} />
    ),
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('#346 — the monthly trend carries a gap, not a fabricated number', () => {
  it('keeps the month on the axis with a null value when the month has no data', async () => {
    // Three of six months have no cube row. The endpoint is single-month, so the trend fans out.
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      const month = /month=(\d{4}-\d{2})/.exec(u)?.[1] ?? '';
      const real = ['2026-04', '2026-05', '2026-06'].includes(month);
      return json(withUptime(month, real ? 97.5 : null, real ? 200 : 0));
    });
    vi.stubGlobal('fetch', fetchMock);

    const series = await apiFleetUptimeTrend(6, new Date('2026-06-15T00:00:00Z'));

    expect(series).toHaveLength(6); // every month is on the axis, including the empty ones
    expect(series.map((p) => p.label)).toEqual(['26-01', '26-02', '26-03', '26-04', '26-05', '26-06']);
    // The three empty months are gaps — not 0, not 100, not absent.
    expect(series.slice(0, 3).map((p) => p.value)).toEqual([null, null, null]);
    expect(series.slice(3).map((p) => p.value)).toEqual([97.5, 97.5, 97.5]);
    expect(series.map((p) => p.value)).not.toContain(0);
    expect(series.map((p) => p.value)).not.toContain(100);
  });

  it('treats a zero eligible-device count as a gap even if the payload still carries a number', async () => {
    // Defence in depth: an older backend (or a cached response) can still answer 100 with an empty
    // denominator. The client refuses to plot a percentage that has nothing underneath it.
    const fetchMock = vi.fn(async (url: RequestInfo | URL) =>
      json(withUptime(/month=(\d{4}-\d{2})/.exec(String(url))?.[1] ?? '', 100, 0)),
    );
    vi.stubGlobal('fetch', fetchMock);

    const series = await apiFleetUptimeTrend(2, new Date('2026-06-15T00:00:00Z'));
    expect(series.map((p) => p.value)).toEqual([null, null]);
  });

  it('a month whose request fails is a gap too, not a hole in the axis', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const month = /month=(\d{4}-\d{2})/.exec(String(url))?.[1] ?? '';
      if (month === '2026-05') return new Response('nope', { status: 500 });
      return json(withUptime(month, 98, 100));
    });
    vi.stubGlobal('fetch', fetchMock);

    const series = await apiFleetUptimeTrend(2, new Date('2026-06-15T00:00:00Z'));
    expect(series).toEqual([
      { label: '26-05', value: null },
      { label: '26-06', value: 98 },
    ]);
  });
});

describe('#346 — the Reports page renders "no data" rather than a number', () => {
  const mountWith = (uptimePct: number | null, eligibleDeviceCount: number) => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes('/reports/fleet-uptime')) {
        const month = /month=(\d{4}-\d{2})/.exec(u)?.[1] ?? '2026-06';
        return json(withUptime(month, uptimePct, eligibleDeviceCount));
      }
      if (u.includes('/dashboard/zone-overview')) return json(zones);
      if (u.includes('/reports/soft-inactive-trend')) return json({ sinceDays: 14, zones: [] });
      return json({});
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><ReportsPage /></MemoryRouter>);
  };

  it('shows an em dash and a "no data" hint on the Fleet Uptime KPI for an empty month', async () => {
    mountWith(null, 0);

    const kpi = within(await screen.findByTestId('kpi-fleet-uptime'));
    expect(kpi.getByText('—')).toBeInTheDocument();
    expect(kpi.getByText(/no data for this month/i)).toBeInTheDocument();
    // The fabricated value must not appear anywhere on the card.
    expect(kpi.queryByText('100%')).toBeNull();
    expect(kpi.queryByText('0%')).toBeNull();
  });

  it('renders the real percentage and the normal hint when the month has data', async () => {
    mountWith(94.2, 500);

    const kpi = within(await screen.findByTestId('kpi-fleet-uptime'));
    expect(kpi.getByText('94.2%')).toBeInTheDocument();
    expect(kpi.getByText(/eligible-device weighted/i)).toBeInTheDocument();
  });

  it('hands the trend chart a null-valued point for the empty months, never a zero', async () => {
    // Six months, all empty → the panel refuses to draw a line at all rather than draw six zeroes.
    mountWith(null, 0);
    await screen.findByTestId('kpi-fleet-uptime');
    await waitFor(() => expect(screen.getByText(/no monthly uptime history yet/i)).toBeInTheDocument());
    expect(screen.queryByTestId('trend-chart')).toBeNull();
  });

  it('draws the line with gaps when only some months are empty', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes('/reports/fleet-uptime')) {
        const month = /month=(\d{4}-\d{2})/.exec(u)?.[1] ?? '';
        const real = month.endsWith('-06');
        return json(withUptime(month, real ? 88.5 : null, real ? 120 : 0));
      }
      if (u.includes('/dashboard/zone-overview')) return json(zones);
      if (u.includes('/reports/soft-inactive-trend')) return json({ sinceDays: 14, zones: [] });
      return json({});
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><ReportsPage /></MemoryRouter>);

    const chart = await screen.findByTestId('trend-chart');
    const series = JSON.parse(chart.getAttribute('data-series') ?? '[]') as { label: string; value: number | null }[];
    expect(series).toHaveLength(6);
    expect(series.filter((p) => p.value === null)).toHaveLength(5);
    expect(series.filter((p) => p.value === 88.5)).toHaveLength(1);
    // The whole point of the slice: a gap is a gap.
    expect(series.map((p) => p.value)).not.toContain(0);
  });

  it('leaves the zone-breakdown uptime cell and the per-zone bars empty rather than zeroed', async () => {
    mountWith(null, 0);

    const row = await screen.findByTestId('report-zone-1');
    expect(within(row).getByText('—')).toBeInTheDocument();
    expect(within(row).queryByText('0%')).toBeNull();
    expect(within(row).queryByText('100%')).toBeNull();
    expect(screen.getByText(/no per-zone uptime yet/i)).toBeInTheDocument();
  });
});

describe('#346 — a row with no data never reaches a chart as a number', () => {
  it('drops null-uptime zones from the per-zone bar panel', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes('/reports/fleet-uptime')) {
        return json({
          month: '2026-06',
          groupBy: 'zone',
          fleet: { eligibleDeviceCount: 120, uptimePct: 88.5, autoRecoveryClosures: 0, seRepairedClosures: 0 },
          rows: [
            { id: '1', name: 'West', eligibleDeviceCount: 120, uptimePct: 88.5, autoRecoveryClosures: 0, seRepairedClosures: 0 },
            { id: '2', name: 'East', eligibleDeviceCount: 4, uptimePct: null, autoRecoveryClosures: 0, seRepairedClosures: 0 },
          ],
        });
      }
      if (u.includes('/dashboard/zone-overview')) return json(zones);
      if (u.includes('/reports/soft-inactive-trend')) return json({ sinceDays: 14, zones: [] });
      return json({});
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><ReportsPage /></MemoryRouter>);

    await screen.findByTestId('kpi-fleet-uptime');
    // The panel exists (West has real data) but East is absent rather than drawn as a zero-height bar.
    await waitFor(() => expect(screen.queryByText(/no per-zone uptime yet/i)).toBeNull());
  });
});

describe('#346 — the ZM scorecard reads the same uptime, so it needs the same guard', () => {
  const scorecard = (compliance: [number | null, number | null]) => ({
    fromMonth: '2026-06-01',
    toMonth: '2026-06-30',
    zoneId: null,
    rows: [
      { zmId: 'zm-1', zmName: 'Asha', zoneId: 1, zoneName: 'West', overrides: 12, removals: 0, deferrals: 0, reorders: 0, swaps: 0, reassignments: 0, splitBatches: 0, overrideAfterOnsite: 0, manualAssignments: 5, autoAssigned: 120, overrideRatePct: 10, zoneSlaCompliancePct: compliance[0] },
      { zmId: 'zm-2', zmName: 'Ravi', zoneId: 2, zoneName: 'East', overrides: 30, removals: 0, deferrals: 0, reorders: 0, swaps: 0, reassignments: 0, splitBatches: 0, overrideAfterOnsite: 0, manualAssignments: 9, autoAssigned: 130, overrideRatePct: 22, zoneSlaCompliancePct: compliance[1] },
    ],
    trend: [],
  });

  const mount = async (compliance: [number | null, number | null]) => {
    vi.stubGlobal('fetch', vi.fn(async () => json(scorecard(compliance))));
    const { ZmScorecardPage } = await import('../src/pages/reports/ZmScorecardPage');
    render(<MemoryRouter><ZmScorecardPage /></MemoryRouter>);
  };

  it('renders an em dash in the Zone SLA column for a ZM whose zone has no eligible device-time', async () => {
    await mount([97.5, null]);

    const table = await screen.findByRole('table', { name: /zm scorecard/i });
    const ravi = within(table).getByTestId('zm-row-zm-2');
    expect(ravi).toHaveTextContent('—');
    expect(ravi).not.toHaveTextContent('100%');
    expect(ravi).not.toHaveTextContent('0%');
  });

  it('never crowns a ZM with no data as top performer', async () => {
    // A `null > number` comparison is false in JS, so the OLD reduce happened to skip nulls — but the
    // same expression with the operands the other way round would have crowned the empty zone. Pin it.
    await mount([null, 92]);

    expect(await screen.findByTestId('zm-leader')).toHaveTextContent(/Ravi/);
    expect(screen.getByTestId('zm-leader')).toHaveTextContent('92%');
  });

  it('shows no leader card at all when nobody has a comparable number', async () => {
    await mount([null, null]);

    await screen.findByRole('table', { name: /zm scorecard/i });
    expect(screen.queryByTestId('zm-leader')).toBeNull();
  });
});

beforeEach(() => {
  sessionStorage.clear();
});
