import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  { zoneId: '1', zoneName: 'West', operationalDevices: 200, inactiveOperational: 46, healthyOperational: 154, warehouseDevices: 30, mirroredDevices: 230, inactivePct: 23, fleetHealthPct: 77, byBucket: { CRITICAL: 10, HIGH_CRITICAL: 5, WARNING: 7 }, trendPctVsPrevDay: null },
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

const workTypeMix = {
  from: '2026-06-15',
  to: '2026-07-14',
  total: 46,
  filters: { zoneId: null, companyId: null, plantId: null },
  rows: [
    { workType: 'TROUBLESHOOT', count: 38, pct: 82.61 },
    { workType: 'INSTALL', count: 7, pct: 15.22 },
    { workType: 'RECOVERY', count: 1, pct: 2.17 },
  ],
};

const verificationOutcomes = {
  from: '2026-06-15',
  to: '2026-07-14',
  total: 21,
  fraudFlagged: 2,
  filters: { zoneId: null, companyId: null, plantId: null },
  rows: [
    { outcome: 'CLOSED', count: 5, pct: 23.81 },
    { outcome: 'CLOSED_AUTO_RECOVERY', count: 0, pct: 0 },
    { outcome: 'PARTIAL_RECOVERY', count: 4, pct: 19.05 },
    { outcome: 'FAILED_VERIFICATION', count: 2, pct: 9.52 },
    { outcome: 'FAILED_ACTIVATION', count: 0, pct: 0 },
    { outcome: 'PENDING', count: 10, pct: 47.62 },
  ],
};

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
  const u = String(url);
  if (u.includes('/reports/fleet-uptime')) return json(fleet);
  if (u.includes('/reports/soft-inactive-trend')) return json(softTrend);
  if (u.includes('/reports/work-type-mix')) return json(workTypeMix);
  if (u.includes('/reports/verification-outcomes')) return json(verificationOutcomes);
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

  it('renders the Work-type mix and Verification outcomes panels from the Issue-90 endpoints', async () => {
    render(<ReportsPage />);

    // Work-type mix rows (labels + counts), no longer a gated placeholder.
    const mix = within(await screen.findByTestId('work-type-mix'));
    expect(mix.getByText('Troubleshoot')).toBeInTheDocument();
    expect(mix.getByText('38')).toBeInTheDocument();
    expect(mix.getByText('Install')).toBeInTheDocument();
    expect(mix.getByText('Recovery')).toBeInTheDocument();
    expect(screen.queryByText(/backend summary endpoint pending/i)).toBeNull();

    // Verification outcomes: zero-count buckets are dropped, PENDING and the fraud count surface.
    const outcomes = within(await screen.findByTestId('verification-outcomes'));
    expect(outcomes.getByText('Verified / Passed')).toBeInTheDocument();
    expect(outcomes.getByText('Partial recovery')).toBeInTheDocument();
    expect(outcomes.getByText('Pending')).toBeInTheDocument();
    expect(outcomes.queryByText('Auto-recovered')).toBeNull();
    expect(outcomes.getByText(/2 fraud-flagged/i)).toBeInTheDocument();
  });

  it('shows the scope meta strip and exports the zone breakdown as CSV', async () => {
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:report');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }));

    render(<ReportsPage />);
    await screen.findByTestId('report-zone-1');

    // Meta strip: scoped zone chip + data-as-of stamp (reference header band).
    const meta = within(screen.getByTestId('reports-meta'));
    expect(meta.getByText('West')).toBeInTheDocument();
    expect(meta.getByText(/data as of/i)).toBeInTheDocument();

    // Export is enabled once data is loaded and produces a CSV of the zone breakdown.
    await userEvent.click(screen.getByRole('button', { name: /export/i }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0]![0];
    // jsdom's Blob has no .text() and Response stringifies it — FileReader is the portable read.
    const csv = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob);
    });
    expect(csv).toContain('Zone,Inactive w/ work,Critical+,Fleet Uptime %');
    expect(csv).toContain('West,46,15,94.2');
  });

  it('queries the Fleet Uptime and Soft-Inactive endpoints', async () => {
    render(<ReportsPage />);
    await screen.findByTestId('report-zone-1');
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/reports/fleet-uptime'))).toBe(true);
    expect(urls.some((u) => u.includes('/reports/soft-inactive-trend'))).toBe(true);
  });
});
