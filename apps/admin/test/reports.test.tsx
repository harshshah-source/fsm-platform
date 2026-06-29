import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportsPage } from '../src/pages/reports/ReportsPage';

/**
 * FE-21 — Reports landing. Fleet Uptime % (Issue 39) + Soft-Inactive trend (Issue 40) + the
 * zone-overview-derived bucket/critical panels, all from real endpoints. Asserts the KPI value, the
 * Zone-breakdown table, and that the bucket panel renders.
 */
const fleet = {
  month: '2026-06',
  groupBy: 'zone',
  fleet: { eligibleDeviceCount: 500, uptimePct: 94.2, autoRecoveryClosures: 3, seRepairedClosures: 12 },
  rows: [{ id: '1', name: 'West', eligibleDeviceCount: 200, uptimePct: 94.2, autoRecoveryClosures: 2, seRepairedClosures: 6 }],
};

const zones = [
  { zoneId: '1', zoneName: 'West', totalInactive: 46, byBucket: { CRITICAL: 10, HIGH_CRITICAL: 5, WARNING: 7 }, trendPctVsPrevDay: null },
];

const softTrend = {
  sinceDays: 14,
  zones: [
    {
      zoneId: '1',
      zoneName: 'West',
      points: [
        { capturedAt: '2026-06-10T06:00:00Z', period: 'AM', softInactiveCount: 12, eligibleDeviceCount: 200, deficitMode: false },
        { capturedAt: '2026-06-11T06:00:00Z', period: 'AM', softInactiveCount: 9, eligibleDeviceCount: 200, deficitMode: false },
      ],
    },
  ],
};

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
  const u = String(url);
  if (u.includes('/reports/fleet-uptime')) return json(fleet);
  if (u.includes('/reports/soft-inactive-trend')) return json(softTrend);
  if (u.includes('/dashboard/zone-overview')) return json(zones);
  return json({});
});

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockClear();
  sessionStorage.clear();
});

describe('Reports landing (FE-21)', () => {
  it('renders the Fleet Uptime KPI and the zone-breakdown table from real endpoints', async () => {
    render(<ReportsPage />);

    // Zone-breakdown table from /reports/fleet-uptime + /dashboard/zone-overview
    await screen.findByRole('table', { name: /zone breakdown/i });
    const row = await screen.findByTestId('report-zone-1');
    expect(within(row).getByText('West')).toBeInTheDocument();
    expect(within(row).getByText('46')).toBeInTheDocument(); // inactive w/ work
    expect(within(row).getByText('15')).toBeInTheDocument(); // critical+ = CRITICAL(10)+HIGH_CRITICAL(5)
    expect(within(row).getByText('94.2%')).toBeInTheDocument(); // fleet uptime

    // KPI strip shows the Fleet Uptime metric — assert via its unique hint to disambiguate from the
    // identically-labelled Zone-breakdown table column header.
    expect(screen.getByText('Eligible-device weighted')).toBeInTheDocument();
    expect(screen.getAllByText('Fleet Uptime').length).toBeGreaterThanOrEqual(1);

    // Inactivity-by-SLA-bucket panel is present
    expect(screen.getByText('Inactivity by SLA bucket')).toBeInTheDocument();
  });

  it('queries the Fleet Uptime and Soft-Inactive endpoints', async () => {
    render(<ReportsPage />);
    await screen.findByTestId('report-zone-1');
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/reports/fleet-uptime'))).toBe(true);
    expect(urls.some((u) => u.includes('/reports/soft-inactive-trend'))).toBe(true);
  });
});
