import type { SessionView } from '@fsm/shared';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { DeviceDetailPage } from '../src/pages/reports/DeviceDetailPage';

/**
 * FE-22 — Device Detail (ref 22). Device list + search over the new `/devices` read, a selected-device
 * header (lifetime stats from `/devices/:id/downtime-trend`), a current-failure-cycle panel and a
 * lifetime downtime trend (bars + summary-table toggle). Ops-Head deal-type tag closes Issue 49.
 */
const OH: SessionView = { user_id: 'oh', role: 'OPERATIONS_HEAD', zone_id: null, acted_as_role: null };
const ZM: SessionView = { user_id: 'zm', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };

const list = [
  { deviceId: '900', vehicleNo: 'RJ-14-AA', deviceType: 'AIS-140', imsiNo: '0404920694896515', dealType: null, plantName: 'ACP-9106', zoneName: 'West', companyName: 'UltraTech', slaBucket: 'CRITICAL', latestGpsDatetime: '2026-06-01T00:00:00.000Z', tripCreationDatetime: '2026-07-13T08:36:27.000Z', isInactive: true, openTicketId: 'ec20cefb-7481-481d-81dc-09c7c58d3aa3', openTicketStatus: 'OPEN', assignmentState: 'FORMALLY_ASSIGNED', assignedSeName: 'Ravi K', batchId: '84', batchStatus: 'ACTIVE', scheduleId: '48' },
];
const cycles = {
  deviceId: '900',
  cycles: [
    { cycleId: 'c1', openedAt: '2026-06-01T00:00:00Z', closedAt: null, durationSeconds: 3600, slaBucketReached: 'CRITICAL', repeatFailure: false, assignedSeId: null, rootCauseCategory: 'GPS_ANTENNA_ISSUE', componentRelated: true, vehicleUnavailableImpact: false, componentBlockedImpact: true, verificationOutcome: null, closureType: null, autoRecovery: false },
  ],
};
const trend = {
  deviceId: '900',
  lifetime: { totalCycles: 5, totalDowntimeHours: 120, repeatFailures: 1, longestEpisodeHours: 40, avgTimeToRecoverHours: 8, autoRecoveryClosures: 1, seRepairedClosures: 4 },
  monthly: [{ month: '2026-06', downtimeHours: 33, cycleCount: 1, repeatFailureCount: 0, autoRecoveryClosures: 0, seRepairedClosures: 1, componentDowntimeHours: 10, avgTimeToRecoverHours: 8 }],
  rootCauseTrend: [],
};

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
const fetchMock = vi.fn();

function stub(extra?: (url: string, opts?: RequestInit) => Response | undefined) {
  fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
    const u = String(url);
    const hit = extra?.(u, opts);
    if (hit) return hit;
    if (u.includes('/devices/900/cycles')) return json(cycles);
    if (u.includes('/devices/900/downtime-trend')) return json(trend);
    if (u.includes('/devices/filter-options'))
      return json({ zones: [{ zoneId: 1, name: 'West' }], companies: [{ companyId: 7, name: 'UltraTech' }], hasUnzoned: true });
    if (u.includes('/devices')) return json({ rows: list, total: list.length });
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
}

function renderPage(session: SessionView = OH) {
  return render(
    <AuthProvider initialSession={session}>
      <MemoryRouter>
        <DeviceDetailPage />
      </MemoryRouter>
    </AuthProvider>,
  );
}

beforeEach(() => sessionStorage.setItem('fsm.accessToken', 'tok'));
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

describe('Device Detail (FE-22)', () => {
  it('lists devices and shows lifetime stats when a device is selected', async () => {
    stub();
    renderPage(OH);
    const row = await screen.findByTestId('dev-row-900');
    // Change #1 — proper per-attribute columns (Device ID / Vehicle / Company / Plant / Zone / SLA).
    expect(row).toHaveTextContent(/RJ-14-AA/); // Vehicle Number
    expect(row).toHaveTextContent(/UltraTech/); // Company Name
    expect(row).toHaveTextContent(/ACP-9106/); // Plant Name (short code shown verbatim)
    expect(row).toHaveTextContent(/West/); // Zone
    // Change #2 — the SLA bucket carries its real inactivity range from the shared mapping.
    expect(within(row).getByTestId('bucket-CRITICAL')).toHaveTextContent('Critical (24–48h)');
    fireEvent.click(row);
    const stats = await screen.findByTestId('device-stats');
    expect(stats).toHaveTextContent(/120/); // total downtime hours
    expect(stats).toHaveTextContent(/5/); // lifetime cycles
  });

  it('toggles the lifetime downtime summary table', async () => {
    stub();
    renderPage(OH);
    fireEvent.click(await screen.findByTestId('dev-row-900'));
    await screen.findByTestId('device-stats');
    fireEvent.click(screen.getByTestId('trend-summary-toggle'));
    const table = await screen.findByRole('table', { name: /downtime summary/i });
    expect(within(table).getByText(/2026-06/)).toBeInTheDocument();
    expect(within(table).getByText(/33/)).toBeInTheDocument();
  });

  it('lets Operations Head tag the deal type (closes Issue 49)', async () => {
    stub((u, opts) => {
      if (u.includes('/devices/900/deal-type') && opts?.method === 'PATCH') return json({ deviceId: '900', dealType: 'RECURRING', currentVehicleId: null, deviceType: 'AIS-140', simId: null });
      return undefined;
    });
    renderPage(OH);
    fireEvent.click(await screen.findByTestId('dev-row-900'));
    await screen.findByTestId('device-stats');
    fireEvent.click(await screen.findByTestId('deal-type-recurring'));
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/devices/900/deal-type'), expect.objectContaining({ method: 'PATCH' })),
    );
  });

  it('does not show the deal-type tag control to a Zonal Manager', async () => {
    stub();
    renderPage(ZM);
    fireEvent.click(await screen.findByTestId('dev-row-900'));
    await screen.findByTestId('device-stats');
    expect(screen.queryByTestId('deal-type-recurring')).toBeNull();
  });

  it('renders a per-row ticket link straight to Ticket Operations (operator report 2026-07-15)', async () => {
    stub();
    renderPage(OH);
    const link = await screen.findByTestId('row-ticket-link-900');
    expect(link).toHaveAttribute('href', '/tickets/ec20cefb-7481-481d-81dc-09c7c58d3aa3');
    // The link must not trigger the row's inline-select handler on its way out.
    fireEvent.click(link);
    expect(screen.queryByTestId('device-stats')).toBeNull();
  });

  it('queries the device list endpoint on search', async () => {
    stub();
    renderPage(OH);
    await screen.findByTestId('dev-row-900');
    await userEvent.type(screen.getByLabelText(/search devices/i), 'RJ');
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/devices?search=RJ'))).toBe(true));
  });

  it('sorts and filters via the toolbar — the query params reach the endpoint', async () => {
    stub();
    renderPage(OH);
    await screen.findByTestId('dev-row-900');

    await userEvent.selectOptions(screen.getByLabelText(/sort by/i), 'NEWEST_ACTIVITY');
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes('sort=NEWEST_ACTIVITY'))).toBe(true));

    await userEvent.selectOptions(screen.getByLabelText(/^status$/i), 'INACTIVE');
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes('status=INACTIVE'))).toBe(true));

    await userEvent.selectOptions(screen.getByLabelText(/sla bucket/i), 'LONG_PENDING');
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes('bucket=LONG_PENDING'))).toBe(true));

    // Zone options come from /devices/filter-options; the UNZONED holding set is selectable.
    await userEvent.selectOptions(screen.getByLabelText(/^zone$/i), 'UNZONED');
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes('zoneId=UNZONED'))).toBe(true));
  });

  it('pages through a fleet larger than one page — shows the count, and Next requests the next offset', async () => {
    // A page-worth of rows with a total far larger than one page, so the pager renders.
    const pageRow = (id: number) => ({ ...list[0], deviceId: String(id) });
    const firstPage = Array.from({ length: 100 }, (_, i) => pageRow(1000 + i));
    stub((u) => {
      if (u.includes('/devices') && !u.includes('/devices/')) {
        return json({ rows: firstPage, total: 4987 });
      }
      return undefined;
    });
    renderPage(OH);

    // "Showing 1–100 of 4,987" — the fleet is far larger than the visible slice.
    const count = await screen.findByTestId('device-list-count');
    expect(count).toHaveTextContent(/1.*100.*4,987/);
    expect(screen.getByTestId('device-page-status')).toHaveTextContent(/page 1 of 50/i);
    expect(screen.getByTestId('device-page-prev')).toBeDisabled();

    await userEvent.click(screen.getByTestId('device-page-next'));
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes('offset=100'))).toBe(true),
    );
  });
});

/**
 * AutoPlant enrichment columns. Inactive Duration already existed here (derived client-side from
 * `latestGpsDatetime`) and is deliberately reused rather than recomputed; Device Type / IMSI No / Trip
 * Creation are the new ones. Device Type was previously carried in the payload but never surfaced as a
 * column — and was NULL for the whole fleet until the master-sync source stopped stubbing it.
 */
describe('Device Detail — AutoPlant enrichment columns', () => {
  beforeEach(() => stub());
  afterEach(() => vi.unstubAllGlobals());

  it('renders Device Type, IMSI No and Trip Creation on the list row', async () => {
    renderPage();
    const row = within(await screen.findByTestId('dev-row-900'));
    expect(row.getByText('AIS-140')).toBeInTheDocument();
    expect(row.getByText('0404920694896515')).toBeInTheDocument();
    expect(row.getByText(/13 Jul 2026/)).toBeInTheDocument();
  });

  it('keeps the pre-existing Inactive Duration column (derived, not recomputed)', async () => {
    renderPage();
    expect(await screen.findByRole('columnheader', { name: 'Inactive Duration' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Device Type' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'IMSI No' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Trip Creation Date Time' })).toBeInTheDocument();
  });

  it('degrades to "—" when a device has no IMSI / device type / trip (sparse at source)', async () => {
    stub((u) =>
      u.includes('/devices') && !u.includes('/devices/900') && !u.includes('filter-options')
        ? json({ rows: [{ ...list[0], deviceType: null, imsiNo: null, tripCreationDatetime: null }], total: 1 })
        : undefined,
    );
    renderPage();
    const row = within(await screen.findByTestId('dev-row-900'));
    expect(row.getAllByText('—').length).toBeGreaterThanOrEqual(3);
    expect(row.getByText('RJ-14-AA')).toBeInTheDocument(); // row still renders
  });
});
