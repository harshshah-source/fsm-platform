import type { SessionView } from '@fsm/shared';
import { render, screen, within } from '@testing-library/react';
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

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
