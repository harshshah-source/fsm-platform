import type { SessionView } from '@fsm/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { TicketDetailDrawer } from '../src/pages/tickets/TicketDetailDrawer';
import { TicketsPage } from '../src/pages/tickets/TicketsPage';

/**
 * #244 AC-5 — the Special surface on the admin console (reference `07-tickets`, `28-tickets-drawer`).
 *
 * Special is an **identification**: a ticket that was repeatedly dispatched, actually reached in the
 * mobile workflow, and never successfully worked. The UI's whole job is therefore to make the claim
 * *checkable* — a badge that says how many attempts, a filter that finds them, and a history that
 * shows window by window what the verdict was derived from. It must never look like a priority
 * mechanism, and it must never be confused with REPEAT / ESCALATED, which are facts about the device.
 *
 * The badge renders from the row's own `isSpecial`, never from a client-side re-derivation of the
 * rule — the #238 `HELD` precedent. A second implementation of the definition in TypeScript is
 * exactly how a queue starts disagreeing with the filter that populates it.
 */
const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };
const SPECIAL_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PLAIN_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const baseRow = {
  workType: 'TROUBLESHOOT',
  status: 'OPEN',
  plantId: '7',
  companyId: '3',
  companyTier: 'GOLD',
  assignmentState: 'UNASSIGNED',
  slaBucket: 'CRITICAL',
  failureCycleState: 'OPEN',
  createdAt: '2026-08-14T10:00:00.000Z',
};

const rows = [
  { ...baseRow, ticketId: SPECIAL_ID, deviceId: '900', repeatFailure: false, isSpecial: true, specialAttempts: 3 },
  { ...baseRow, ticketId: PLAIN_ID, deviceId: '901', repeatFailure: true, isSpecial: false, specialAttempts: 1 },
];

const attempts = {
  ticketId: SPECIAL_ID,
  threshold: 3,
  countableAttempts: 3,
  hasSubmission: false,
  isSpecial: true,
  attempts: [
    {
      attemptId: '1',
      seId: 'se-1',
      seName: 'Amit Yadav',
      openedAt: '2026-08-14T04:00:00.000Z',
      closedAt: '2026-08-14T16:00:00.000Z',
      removalReason: 'PLAN_EXPIRED',
      reached: true,
      submitted: false,
      countable: true,
    },
    {
      attemptId: '2',
      seId: 'se-1',
      seName: 'Amit Yadav',
      openedAt: '2026-08-15T04:00:00.000Z',
      closedAt: '2026-08-15T16:00:00.000Z',
      removalReason: 'ZM_WITHDRAWN',
      reached: true,
      submitted: false,
      countable: false,
    },
    {
      attemptId: '3',
      seId: 'se-2',
      seName: 'Deepak Verma',
      openedAt: '2026-08-16T04:00:00.000Z',
      closedAt: null,
      removalReason: null,
      reached: false,
      submitted: false,
      countable: false,
    },
  ],
};

const fetchMock = vi.fn();

/** Routes every call the page makes; `listUrls` records what the list was asked for. */
function stubApi(listUrls: string[] = []) {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

    if (url.includes('/tickets/special-count')) return json({ count: 1, threshold: 3 });
    if (url.includes('/attempts')) return json(attempts);
    if (url.includes(`/tickets/${SPECIAL_ID}`)) {
      return json({ ...rows[0], lifecycle: [], failureCycleId: null, vehicleId: null, lastStateChangedAt: baseRow.createdAt });
    }
    if (url.includes('/assignment-threshold')) return json({ hours: 24 });
    if (url.includes('/tickets')) {
      listUrls.push(url);
      const specialOnly = url.includes('special=true');
      return json(specialOnly ? rows.filter((r) => r.isSpecial) : rows);
    }
    return json([]);
  });
  vi.stubGlobal('fetch', fetchMock);
}

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

const renderPage = () =>
  render(
    <AuthProvider initialSession={zm}>
      <MemoryRouter>
        <TicketsPage />
      </MemoryRouter>
    </AuthProvider>,
  );

const renderDrawer = () =>
  render(
    <AuthProvider initialSession={zm}>
      <MemoryRouter initialEntries={[`/tickets/${SPECIAL_ID}?tab=Assignment History`]}>
        <Routes>
          <Route path="/tickets/:ticketId" element={<TicketDetailDrawer />} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );

describe('#244 — Special on the ticket queue', () => {
  it('badges only the Special row, and says how many attempts are behind the verdict', async () => {
    stubApi();
    renderPage();

    const badge = await screen.findByTestId('badge-SPECIAL');
    expect(badge).toBeInTheDocument();
    // The count is the checkable part of the claim — a bare word would be an assertion, not evidence.
    expect(badge).toHaveTextContent('3');
    expect(screen.getAllByTestId('badge-SPECIAL')).toHaveLength(1);
  });

  /** The three concepts never share a chip. A REPEAT ticket that is not Special shows REPEAT only. */
  it('never conflates SPECIAL with REPEAT', async () => {
    stubApi();
    renderPage();

    const repeatBadge = await screen.findByTestId('badge-REPEAT');
    const specialBadge = screen.getByTestId('badge-SPECIAL');
    expect(repeatBadge).not.toBe(specialBadge);
    // The repeat-failure row is the one that is NOT special, so the two badges are on different rows.
    expect(repeatBadge.closest('tr')).not.toBe(specialBadge.closest('tr'));
  });

  it('offers a Special filter that narrows the list server-side, with the count beside it', async () => {
    const listUrls: string[] = [];
    stubApi(listUrls);
    renderPage();

    // The count comes from the server, scoped to this caller — never counted from the loaded page.
    expect(await screen.findByTestId('special-count')).toHaveTextContent('1');

    await userEvent.click(screen.getByTestId('special-filter'));

    await waitFor(() => expect(listUrls.some((u) => u.includes('special=true'))).toBe(true));
    await waitFor(() => expect(screen.getAllByRole('row').length).toBeLessThan(3));
  });
});

describe('#244 — the attempt history behind the verdict', () => {
  it('lists every window with its evidence, and marks which ones counted', async () => {
    stubApi();
    renderDrawer();

    const drawer = await screen.findByRole('complementary', { name: /ticket detail/i });
    const panel = await within(drawer).findByTestId('attempt-history');

    // One row per assignment window — including the manager withdrawal and the live one, because a
    // history that showed only the countable attempts could not be checked against the ledger.
    expect(within(panel).getAllByTestId(/^attempt-row-/)).toHaveLength(3);
    expect(within(panel).getByText(/PLAN_EXPIRED/)).toBeInTheDocument();
    expect(within(panel).getByText(/ZM_WITHDRAWN/)).toBeInTheDocument();
    // Two of the three windows went to the same SE, which is exactly the shape a repeatedly-retried
    // ticket has — so this asserts the count, not a single match.
    expect(within(panel).getAllByText(/Amit Yadav/)).toHaveLength(2);
    expect(within(panel).getByText(/Deepak Verma/)).toBeInTheDocument();
  });

  it('states the verdict against the live threshold, so the number is never implicit', async () => {
    stubApi();
    renderDrawer();

    const drawer = await screen.findByRole('complementary', { name: /ticket detail/i });
    const verdict = await within(drawer).findByTestId('special-verdict');

    expect(verdict).toHaveTextContent('3');
    expect(verdict.textContent ?? '').toMatch(/special/i);
  });

  /** The badge must not appear for a ticket the server did not call Special — a client-side guess is
   *  the one thing the whole single-definition discipline exists to prevent. */
  it('shows no verdict chip when the server says the ticket is ordinary', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/attempts')) {
        return json({ ...attempts, isSpecial: false, countableAttempts: 1 });
      }
      if (url.includes(`/tickets/${SPECIAL_ID}`)) {
        return json({ ...rows[0], isSpecial: false, lifecycle: [], failureCycleId: null, vehicleId: null, lastStateChangedAt: baseRow.createdAt });
      }
      return json([]);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderDrawer();

    const drawer = await screen.findByRole('complementary', { name: /ticket detail/i });
    const verdict = await within(drawer).findByTestId('special-verdict');
    expect(verdict).toHaveTextContent(/not special/i);
    expect(verdict).toHaveTextContent('1/3');
  });

  /** A live window is in progress, not a failed attempt — the history must not imply otherwise. */
  it('marks the still-open window as in progress rather than as an outcome', async () => {
    stubApi();
    renderDrawer();

    const drawer = await screen.findByRole('complementary', { name: /ticket detail/i });
    const panel = await within(drawer).findByTestId('attempt-history');
    expect(within(panel).getByText(/in progress/i)).toBeInTheDocument();
  });
});
