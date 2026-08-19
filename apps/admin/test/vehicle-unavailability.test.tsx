import type { SessionView } from '@fsm/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { VehicleUnavailabilityPage } from '../src/pages/readiness/VehicleUnavailabilityPage';

/**
 * Issue 28 slice 4 + #245 — the ZM Vehicle Unavailability Review page
 * (`/readiness/vehicle-unavailability`, v2-reference/11-vehicle-unavailability). Four KPI cards, a
 * search + STATUS filter with a results counter, and the reference's columns (report/ticket ·
 * vehicle/plant · reason · filed by · expected back · primary SLA · status) with two-line cells.
 *
 * #245 fills in what that reference already anticipated. Its STATUS column shows CONFIRMED beside
 * OPEN and RESUMED — that is the decision state, so the decision lives in the existing column rather
 * than a new one; and EXPECTED BACK carries the authoritative date over the SE's original proposal
 * whenever a manager moved it, because the point of keeping the proposal immutable is that the
 * disagreement stays visible. Row actions: Approve · Override (date + required reason) · Resume SLA ·
 * History (the ticket's supersession chain, where superseded reports live).
 *
 * The secondary (never-pausing) clock is manager-only by living on this manager-gated surface.
 */
const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };

const base = {
  expectedTo: null,
  decidedBy: null,
  decidedByRole: null,
  decidedAt: null,
  overrideReason: null,
  resolvedAt: null,
};

const rows = [
  {
    ...base,
    // Undecided: proposal and authoritative date agree, and nobody has ruled on it yet.
    id: 'rep-1', ticketId: 't-1111aaaa', seId: 'se-1', plantName: 'Pune Yard', reasonCode: 'VEHICLE_ON_TRIP',
    transporterContacted: true, proposedFrom: '2026-06-26T09:00:00.000Z', expectedFrom: '2026-06-26T09:00:00.000Z',
    notes: 'on a trip', status: 'OPEN', decision: null, slaPaused: true,
    primarySlaSeconds: 7200, secondarySlaSeconds: 10800, createdAt: '2026-06-25T10:00:00.000Z',
  },
  {
    ...base,
    // Overridden: the manager moved the date two days out; the SE's proposal survives beside it.
    id: 'rep-2', ticketId: 't-2222bbbb', seId: 'se-2', plantName: 'Nagpur Depot', reasonCode: 'DRIVER_NOT_AVAILABLE',
    transporterContacted: false, proposedFrom: '2026-06-27T09:00:00.000Z', expectedFrom: '2026-06-29T09:00:00.000Z',
    notes: null, status: 'OPEN', decision: 'OVERRIDDEN', decidedBy: 'zm1', decidedByRole: 'ZONAL_MANAGER',
    decidedAt: '2026-06-26T11:30:00.000Z', overrideReason: 'transporter confirmed Monday', slaPaused: true,
    primarySlaSeconds: 3600, secondarySlaSeconds: 14400, createdAt: '2026-06-25T08:00:00.000Z',
  },
  {
    ...base,
    // Resolved — the reference's RESUMED row. No decision actions remain on it.
    id: 'rep-3', ticketId: 't-3333cccc', seId: 'se-3', plantName: 'Kotputli Works', reasonCode: 'VEHICLE_NOT_AT_PLANT',
    transporterContacted: false, proposedFrom: '2026-06-24T09:00:00.000Z', expectedFrom: '2026-06-24T09:00:00.000Z',
    notes: null, status: 'RESOLVED', decision: 'APPROVED', decidedBy: 'zm1', decidedByRole: 'ZONAL_MANAGER',
    decidedAt: '2026-06-24T06:00:00.000Z', resolvedAt: '2026-06-24T12:00:00.000Z', slaPaused: false,
    primarySlaSeconds: 5400, secondarySlaSeconds: 21600, createdAt: '2026-06-23T08:00:00.000Z',
  },
];

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const fetchMock = vi.fn();

function renderPage() {
  return render(
    <AuthProvider initialSession={zm}>
      <MemoryRouter initialEntries={['/readiness/vehicle-unavailability']}>
        <Routes>
          <Route path="/readiness/vehicle-unavailability" element={<VehicleUnavailabilityPage />} />
          <Route path="/tickets/:id" element={<div>Ticket drawer stub</div>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

beforeEach(() => {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (/\/vehicle-unavailability\/.+\/history$/.test(u)) return json([rows[1], rows[0]]);
    if (u.endsWith('/vehicle-unavailability') && (!init || init.method === undefined || init.method === 'GET')) return json(rows);
    if (/\/vehicle-unavailability\/.+\/(approve|override|resume-sla)$/.test(u)) return json({ result: 'OK', id: 'rep-1' });
    return json([]);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

const posted = (re: RegExp) =>
  fetchMock.mock.calls.some(([url, init]) => re.test(String(url)) && (init as RequestInit)?.method === 'POST');

describe('Vehicle Unavailability Review (Issue 28 · #245)', () => {
  it('renders a row per report with the reason and BOTH SLA clocks', async () => {
    renderPage();
    const table = within(await screen.findByRole('table', { name: /vehicle unavailability/i }));
    expect(table.getByText('Pune Yard')).toBeInTheDocument();
    expect(table.getByText('Nagpur Depot')).toBeInTheDocument();
    expect(table.getByText(/vehicle on trip/i)).toBeInTheDocument();
    // Both clocks on a row: primary (paused, effective) AND secondary (true elapsed).
    const row = within(screen.getByTestId('vu-row-rep-1'));
    expect(row.getByTestId('vu-primary-rep-1')).toHaveTextContent('2h 0m');
    expect(row.getByTestId('vu-secondary-rep-1')).toHaveTextContent('3h 0m');
  });

  // AC8 — the reference's four KPI cards, counted off queue state rather than off row count.
  it('shows the reference KPI strip: open / SLA paused / on-trip / resumed', async () => {
    renderPage();
    await screen.findByRole('table', { name: /vehicle unavailability/i });
    expect(within(screen.getByTestId('vu-metric-open')).getByText('2')).toBeInTheDocument();
    expect(within(screen.getByTestId('vu-metric-ontrip')).getByText('1')).toBeInTheDocument();
    expect(within(screen.getByTestId('vu-metric-resumed')).getByText('1')).toBeInTheDocument();
  });

  // AC8 — the disagreement between the SE and the manager is shown, not overwritten.
  it('shows the authoritative date over the SE proposal when a manager overrode it', async () => {
    renderPage();
    await screen.findByRole('table', { name: /vehicle unavailability/i });
    const overridden = within(screen.getByTestId('vu-expected-rep-2'));
    expect(overridden.getByText('2026-06-29')).toBeInTheDocument();
    expect(overridden.getByText(/SE proposed 2026-06-27/i)).toBeInTheDocument();
    // The undecided row's two dates agree, so it says so rather than printing the same date twice.
    expect(within(screen.getByTestId('vu-expected-rep-1')).getByText(/as proposed by SE/i)).toBeInTheDocument();
  });

  // AC8 — decision state rides in the reference's existing STATUS column, with who/when beneath it.
  it('distinguishes undecided OPEN from CONFIRMED and RESUMED, and names the decider', async () => {
    renderPage();
    await screen.findByRole('table', { name: /vehicle unavailability/i });
    expect(within(screen.getByTestId('vu-status-rep-1')).getByText('Open')).toBeInTheDocument();
    const confirmed = within(screen.getByTestId('vu-status-rep-2'));
    expect(confirmed.getByText('Confirmed')).toBeInTheDocument();
    expect(confirmed.getByText(/overridden by ZONAL_MANAGER/i)).toBeInTheDocument();
    expect(within(screen.getByTestId('vu-status-rep-3')).getByText('Resumed')).toBeInTheDocument();
  });

  it('approves the SE proposed date via the manager action', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: /vehicle unavailability/i });
    await user.click(within(screen.getByTestId('vu-row-rep-1')).getByRole('button', { name: /^approve$/i }));
    expect(posted(/\/vehicle-unavailability\/rep-1\/approve$/)).toBe(true);
  });

  it('overrides with a new date and a reason, and will not post without the reason', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: /vehicle unavailability/i });
    await user.click(within(screen.getByTestId('vu-row-rep-1')).getByRole('button', { name: /^override$/i }));

    await user.type(await screen.findByLabelText(/expected date/i), '2026-06-28T09:00');
    await user.click(screen.getByRole('button', { name: /save override/i }));
    // Overruling the person standing at the plant without saying why is the one thing this form
    // must not let through — the reason is what the audit row is for.
    expect(posted(/\/vehicle-unavailability\/rep-1\/override$/)).toBe(false);

    await user.type(screen.getByLabelText(/override reason/i), 'yard shut until Thursday');
    await user.click(screen.getByRole('button', { name: /save override/i }));
    expect(posted(/\/vehicle-unavailability\/rep-1\/override$/)).toBe(true);
  });

  it('resumes the SLA via the manager action', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: /vehicle unavailability/i });
    await user.click(within(screen.getByTestId('vu-row-rep-2')).getByRole('button', { name: /resume sla/i }));
    expect(posted(/\/vehicle-unavailability\/rep-2\/resume-sla$/)).toBe(true);
  });

  it('offers no decision actions on a resolved report', async () => {
    renderPage();
    await screen.findByRole('table', { name: /vehicle unavailability/i });
    const resolved = within(screen.getByTestId('vu-row-rep-3'));
    expect(resolved.queryByRole('button', { name: /^approve$/i })).toBeNull();
    expect(resolved.queryByRole('button', { name: /resume sla/i })).toBeNull();
  });

  it('filters by status and reports the visible count', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: /vehicle unavailability/i });
    expect(screen.getByTestId('vu-result-count')).toHaveTextContent('3 / 3 results');
    await user.selectOptions(screen.getByLabelText('Status'), 'RESUMED');
    expect(screen.getByTestId('vu-result-count')).toHaveTextContent('1 / 3 results');
    expect(screen.queryByTestId('vu-row-rep-1')).toBeNull();
    expect(screen.getByTestId('vu-row-rep-3')).toBeInTheDocument();
  });

  it('searches across report, ticket, plant and SE', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: /vehicle unavailability/i });
    await user.type(screen.getByLabelText(/search reports/i), 'nagpur');
    expect(screen.getByTestId('vu-result-count')).toHaveTextContent('1 / 3 results');
    expect(screen.getByTestId('vu-row-rep-2')).toBeInTheDocument();
  });

  // AC1/AC8 — every report the ticket has carried, superseded ones included.
  it('loads the ticket supersession history on demand', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: /vehicle unavailability/i });
    await user.click(within(screen.getByTestId('vu-row-rep-2')).getByRole('button', { name: /history/i }));

    const chain = within(await screen.findByTestId('vu-history-rep-2'));
    expect(chain.getByText(/VUR-rep-2/)).toBeInTheDocument();
    expect(chain.getByText(/VUR-rep-1/)).toBeInTheDocument();
    expect(chain.getByText(/transporter confirmed Monday/i)).toBeInTheDocument();
  });
});
