import type { SessionView } from '@fsm/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { IntradayQueuePage } from '../src/pages/schedules/IntradayQueuePage';

/**
 * Issue 31 slice 4 — the Intra-day Queue page (`/intraday`, v2-reference/13-intraday-queue). Today the
 * queue renders the ZM manual same-day updates (MANUAL_ZM_UPDATE: ADD / REMOVE / REORDER); the
 * system-triggered CRITICAL insertions arrive with Issue 29 into the same view. A metric strip of
 * update-type counts + a table (Event / Ticket / SE / At). Manager roles only; manual updates need no
 * SE Acceptance.
 */
const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };

const rows = [
  { auditId: '101', actorId: 'zm-1', actorRole: 'ZONAL_MANAGER', updateType: 'ADD', ticketId: 't-1111aaaa', seId: 'se-1111', createdAt: '2026-06-25T06:10:00.000Z' },
  { auditId: '102', actorId: 'zm-1', actorRole: 'ZONAL_MANAGER', updateType: 'REMOVE', ticketId: 't-2222bbbb', seId: 'se-2222', createdAt: '2026-06-25T06:20:00.000Z' },
  { auditId: '103', actorId: 'zm-1', actorRole: 'ZONAL_MANAGER', updateType: 'REORDER', ticketId: null, seId: 'se-1111', createdAt: '2026-06-25T06:30:00.000Z' },
];

// #268 — the system-triggered CRITICAL insertion ledger this page never bound (the #197 audit gap).
const insertions = [
  {
    insertionId: '201',
    ticketId: 't-3333cccc',
    zoneId: '1',
    companyId: 'c-1',
    companyTier: 'GOLD',
    insertionType: 'SYSTEM_CRITICAL',
    slaBucket: 'CRITICAL',
    offeredSeId: 'se-3333',
    offeredAt: '2026-06-25T06:15:00.000Z',
    acceptanceDeadline: '2026-06-25T06:15:00.000Z',
    status: 'ASSIGNED_DIRECT',
    declineReasonCode: null,
    retryCount: 0,
    whatsappSent: false,
    createdAt: '2026-06-25T06:15:00.000Z',
  },
  {
    insertionId: '202',
    ticketId: 't-4444dddd',
    zoneId: '1',
    companyId: 'c-1',
    companyTier: 'GOLD',
    insertionType: 'SYSTEM_CRITICAL',
    slaBucket: 'HIGH_CRITICAL',
    offeredSeId: null,
    offeredAt: '2026-06-25T06:25:00.000Z',
    acceptanceDeadline: null,
    status: 'ESCALATION_REQUIRED',
    declineReasonCode: null,
    retryCount: 0,
    whatsappSent: false,
    createdAt: '2026-06-25T06:25:00.000Z',
  },
];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const fetchMock = vi.fn();

function renderPage() {
  return render(
    <AuthProvider initialSession={zm}>
      <MemoryRouter initialEntries={['/intraday']}>
        <Routes>
          <Route path="/intraday" element={<IntradayQueuePage />} />
          <Route path="/tickets/:id" element={<div>Ticket drawer stub</div>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

beforeEach(() => {
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).endsWith('/intraday-updates')) return json(rows);
    if (String(url).endsWith('/intraday-insertions')) return json(insertions);
    return json([]);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

describe('Intra-day Queue (Issue 31)', () => {
  it('renders a row per manual same-day update with its event type', async () => {
    renderPage();
    const table = within(await screen.findByRole('table', { name: /intra-day queue/i }));
    expect(table.getByTestId('iq-row-101')).toHaveTextContent(/add/i);
    expect(table.getByTestId('iq-row-102')).toHaveTextContent(/remove/i);
    expect(table.getByTestId('iq-row-103')).toHaveTextContent(/reorder/i);
    // Manual ZM updates need no SE Acceptance (AC#2).
    expect(table.getByTestId('iq-row-101')).toHaveTextContent(/no acceptance required/i);
  });

  it('shows a metric strip of update-type counts', async () => {
    renderPage();
    await screen.findByRole('table', { name: /intra-day queue/i });
    const strip = within(screen.getByTestId('iq-metric-strip'));
    expect(strip.getByTestId('iq-metric-ADD')).toHaveTextContent('1');
    expect(strip.getByTestId('iq-metric-REMOVE')).toHaveTextContent('1');
    expect(strip.getByTestId('iq-metric-REORDER')).toHaveTextContent('1');
  });

  /**
   * #268 — closes the #197 audit gap: FE-13's own docstring said the system-triggered CRITICAL
   * insertion rows would "land in this same view later" and they never did (zero
   * `intraday-insertions` references in `apps/admin` before this). Both a direct assignment and an
   * escalation must be visible here — the operational-visibility half of #268's Q-B acceptance
   * criterion.
   */
  it('renders the system-triggered CRITICAL insertion rows alongside the ZM manual updates', async () => {
    renderPage();
    const table = within(await screen.findByRole('table', { name: /intra-day queue/i }));

    const assigned = table.getByTestId('iq-row-ins-201');
    expect(assigned).toHaveTextContent(/critical/i);
    expect(assigned).toHaveTextContent('t-3333cc');
    expect(assigned).toHaveTextContent(/assigned_direct/i);

    const escalated = table.getByTestId('iq-row-ins-202');
    expect(escalated).toHaveTextContent(/escalation_required/i);
    // No SE was ever offered anything on a no-candidate escalation (#268 — offeredSeId is null).
    expect(escalated).not.toHaveTextContent('undefined');
  });

  it('the ZM manual-update rows still say no acceptance is required', async () => {
    renderPage();
    const table = within(await screen.findByRole('table', { name: /intra-day queue/i }));
    expect(table.getByTestId('iq-row-101')).toHaveTextContent(/no acceptance required/i);
  });
});

/**
 * #277 — the intra-day manual-assign modal (Issue 30, admin client the endpoints never had). Only an
 * `ESCALATION_REQUIRED` row offers Assign — `ASSIGNED_DIRECT` already has an SE. `available-ses` now
 * returns #274's candidate row instead of a bare `string[]`, so the modal identifies every candidate.
 */
const candidates = [
  {
    seId: 'se-9999',
    name: 'Priya Rao',
    coverageType: 'DEDICATED',
    tierRank: 1,
    verdict: 'PASSED',
    dropReason: null,
    committed: 3,
    dailyCapacity: 8,
    availabilityStatus: 'AVAILABLE',
    kitComplete: true,
    missingKit: [],
  },
];

describe('#277 — intra-day manual-assign modal', () => {
  it('offers Assign only on the escalated row, never on an already-assigned one', async () => {
    renderPage();
    const table = within(await screen.findByRole('table', { name: /intra-day queue/i }));
    expect(within(table.getByTestId('iq-row-ins-202')).getByRole('button', { name: /assign/i })).toBeInTheDocument();
    expect(within(table.getByTestId('iq-row-ins-201')).queryByRole('button', { name: /assign/i })).toBeNull();
  });

  it('lists candidates by name, never a bare id, and assigning refetches the row into its new state', async () => {
    let assigned = false;
    // The real backend moves the row to ACCEPTED on a successful manual-assign (`manualAssign`,
    // `intraday-insertion.service.ts`) rather than deleting it — the refetch here mirrors that.
    const afterAssign = { ...insertions[1], status: 'ACCEPTED' as const, offeredSeId: 'se-9999' };
    fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/intraday-updates')) return json(rows);
      if (u.endsWith('/intraday-insertions')) return json(assigned ? [insertions[0], afterAssign] : insertions);
      if (u.includes('/intraday-insertions/202/available-ses')) return json(candidates);
      if (u.includes('/intraday-insertions/202/manual-assign') && opts?.method === 'POST') {
        assigned = true;
        return json({ result: 'OK', insertionId: '202', scheduleId: '1', batchId: '1', seId: 'se-9999' });
      }
      return json([]);
    });

    const user = userEvent.setup();
    renderPage();
    const table = within(await screen.findByRole('table', { name: /intra-day queue/i }));
    await user.click(within(table.getByTestId('iq-row-ins-202')).getByRole('button', { name: /assign/i }));

    const modal = within(await screen.findByRole('dialog'));
    expect(await modal.findByText('Priya Rao')).toBeInTheDocument();
    expect(modal.queryByText('se-9999')).toBeNull();

    await user.click(modal.getByRole('button', { name: /^assign$/i }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // The row survives the refetch, no longer escalated — no Assign button left to click a second time.
    await waitFor(() =>
      expect(within(screen.getByTestId('iq-row-ins-202')).queryByRole('button', { name: /assign/i })).toBeNull(),
    );
  });

  it('a return-date hold on the manual assign is resolvable inline, same as every other assign surface', async () => {
    let confirmed = false;
    fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/intraday-updates')) return json(rows);
      if (u.endsWith('/intraday-insertions')) return json(confirmed ? [insertions[0]] : insertions);
      if (u.includes('/intraday-insertions/202/available-ses')) return json(candidates);
      if (u.includes('/intraday-insertions/202/manual-assign') && opts?.method === 'POST') {
        const body = JSON.parse(String(opts?.body)) as { confirm?: boolean };
        if (!body.confirm) {
          return json(
            {
              code: 'CONFLICT_DEFERRED',
              message: 'Ticket is held to a future vehicle-return date.',
              ticketId: 't-4444dddd',
              deferredUntil: '2026-06-30T00:00:00.000Z',
              vuReport: null,
            },
            409,
          );
        }
        confirmed = true;
        return json({ result: 'OK', insertionId: '202', scheduleId: '1', batchId: '1', seId: 'se-9999' });
      }
      return json([]);
    });

    const user = userEvent.setup();
    renderPage();
    const table = within(await screen.findByRole('table', { name: /intra-day queue/i }));
    await user.click(within(table.getByTestId('iq-row-ins-202')).getByRole('button', { name: /assign/i }));

    const modal = within(await screen.findByRole('dialog'));
    await modal.findByText('Priya Rao');
    await user.click(modal.getByRole('button', { name: /^assign$/i }));

    const banner = await modal.findByTestId('deferral-conflict-banner');
    await user.type(within(banner).getByLabelText(/reason/i), 'vehicle back early');
    await user.click(within(banner).getByRole('button', { name: /confirm/i }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(confirmed).toBe(true);
  });
});

/**
 * #288 — work stranded by an engineer going unavailable mid-day arrives in this queue as an
 * `ESCALATION_REQUIRED` row like any other. It is **not** resolvable like any other: the ticket is
 * still formally assigned (escalate-only, #282 R4 — nothing is reassigned automatically), and
 * `assignTicket` refuses an assigned ticket, so the queue's own Assign would 409 on exactly the rows
 * it looks most needed on. The row carries who holds the work; the door that works is a reassign on
 * that engineer's day plan.
 */
const stranded = {
  insertionId: '203',
  ticketId: 't-5555eeee',
  zoneId: '1',
  companyId: 'c-1',
  companyTier: 'GOLD',
  insertionType: 'SE_UNAVAILABLE',
  slaBucket: 'CRITICAL',
  offeredSeId: null,
  offeredAt: '2026-06-25T07:00:00.000Z',
  acceptanceDeadline: null,
  status: 'ESCALATION_REQUIRED',
  declineReasonCode: null,
  retryCount: 0,
  whatsappSent: false,
  createdAt: '2026-06-25T07:00:00.000Z',
  assignedSeId: 'se-7777',
  assignedSeName: 'Ramesh Kumar',
};

describe('#288 — stranded work in the queue', () => {
  beforeEach(() => {
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.endsWith('/intraday-updates')) return json(rows);
      if (u.endsWith('/intraday-insertions')) return json([...insertions, stranded]);
      return json([]);
    });
  });

  it('names the engineer the work is stranded on and sends the manager to their day plan', async () => {
    renderPage();
    const table = within(await screen.findByRole('table', { name: /intra-day queue/i }));
    const row = within(table.getByTestId('iq-row-ins-203'));

    expect(row.getByText(/Ramesh Kumar/)).toBeInTheDocument();
    const link = row.getByRole('link', { name: /day plan/i });
    expect(link).toHaveAttribute('href', '/schedules/se-7777');
  });

  it('does not offer the Assign that cannot resolve it', async () => {
    renderPage();
    const table = within(await screen.findByRole('table', { name: /intra-day queue/i }));
    expect(within(table.getByTestId('iq-row-ins-203')).queryByRole('button', { name: /assign/i })).toBeNull();
    // The capacity escalation, whose ticket nobody holds, still offers it.
    expect(within(table.getByTestId('iq-row-ins-202')).getByRole('button', { name: /assign/i })).toBeInTheDocument();
  });
});
