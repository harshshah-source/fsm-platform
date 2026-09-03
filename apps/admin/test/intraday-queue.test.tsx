import type { SessionView } from '@fsm/shared';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { IntradayQueuePage } from '../src/pages/schedules/IntradayQueuePage';

/**
 * Issue 31 slice 4 — the Intra-day Queue page (`/intraday`, v2-reference/13-intraday-queue). Two event
 * streams merged into one table: the ZM manual same-day updates (MANUAL_ZM_UPDATE) and the
 * system-triggered CRITICAL insertions (#268). A metric strip + a table (Event / Ticket / SE / At).
 * Manager roles only.
 *
 * **#356** is the hygiene pass over that page. It was untrustworthy in three ways at once, all of them
 * invisible from the screen itself: the reads were unbounded (552 insertion rows for one ZM), it loaded
 * exactly once so a dispatcher acted on whatever was true when the tab was opened, and two different
 * kinds of intra-day change read as the same thing because the manager-assignment rows rendered their
 * raw `ACCEPTED` enum. The tests below pin each: the page asks for a bounded page and pages through it,
 * it refreshes without a reload, and no cell shows an enum.
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

/** The server's page envelope (#356) — the page reads `rows`, never a bare array. */
const page = (items: unknown[], nextCursor: string | null = null, limit = 50) => json({ rows: items, nextCursor, limit });

/** Every URL the page requests, in order — what the assertions about `take` / `status` read. */
const requested = (): string[] => fetchMock.mock.calls.map((c) => String(c[0]));
const lastMatching = (fragment: string): string =>
  [...requested()].reverse().find((u) => u.includes(fragment)) ?? '';

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
    const u = String(url);
    if (u.includes('/intraday-updates')) return page(rows);
    if (u.includes('/intraday-insertions')) return page(insertions);
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
   * insertion rows would "land in this same view later" and they never did. Both a direct assignment
   * and an escalation must be visible here — the operational-visibility half of #268's Q-B criterion.
   */
  it('renders the system-triggered CRITICAL insertion rows alongside the ZM manual updates', async () => {
    renderPage();
    const table = within(await screen.findByRole('table', { name: /intra-day queue/i }));

    const assigned = table.getByTestId('iq-row-ins-201');
    expect(assigned).toHaveTextContent(/critical/i);
    expect(assigned).toHaveTextContent('t-3333cc');

    const escalated = table.getByTestId('iq-row-ins-202');
    expect(escalated).toHaveTextContent(/no capacity/i);
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
 * #356 AC3 — no raw enum reaches the screen.
 *
 * `ACCEPTED` is the status a **manager's** own assignment leaves on an insertion row, and it was the
 * only live status the page had no label for: it fell through to `row.status` and rendered the enum.
 * Two different things then read as one — a system assignment and a manager's decision — on the screen
 * whose whole job is telling a dispatcher what has changed and who changed it.
 */
const managerAssigned = {
  ...insertions[1],
  insertionId: '204',
  ticketId: 't-6666ffff',
  status: 'ACCEPTED',
  offeredSeId: 'se-3333',
  createdAt: '2026-06-25T06:40:00.000Z',
};

describe('#356 — labels', () => {
  beforeEach(() => {
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('/intraday-updates')) return page(rows);
      if (u.includes('/intraday-insertions')) return page([...insertions, managerAssigned]);
      return json([]);
    });
  });

  it('AC3 — a manager assignment is named, not spelled ACCEPTED', async () => {
    renderPage();
    const table = within(await screen.findByRole('table', { name: /intra-day queue/i }));
    const row = table.getByTestId('iq-row-ins-204');
    expect(row).toHaveTextContent(/manager assignment/i);
    expect(row).not.toHaveTextContent(/ACCEPTED/);
  });

  it('AC3 — no row anywhere in the table shows a raw enum', async () => {
    renderPage();
    const table = await screen.findByRole('table', { name: /intra-day queue/i });
    const text = table.textContent ?? '';
    for (const raw of ['ASSIGNED_DIRECT', 'ESCALATION_REQUIRED', 'ACCEPTED', 'PENDING_ACCEPTANCE', 'TIMED_OUT', 'DECLINED']) {
      expect(text).not.toContain(raw);
    }
  });
});

describe('#356 — bounded reads, filters and paging', () => {
  it('AC1 — asks for a bounded page rather than the whole ledger', async () => {
    renderPage();
    await screen.findByRole('table', { name: /intra-day queue/i });
    expect(lastMatching('/intraday-insertions')).toContain('take=50');
    expect(lastMatching('/intraday-updates')).toContain('take=50');
  });

  it('AC1 — a status chip narrows the read server-side', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: /intra-day queue/i });

    await user.click(screen.getByTestId('iq-status-ESCALATION_REQUIRED'));
    await waitFor(() => expect(lastMatching('/intraday-insertions')).toContain('status=ESCALATION_REQUIRED'));
    // The ZM-update stream carries no status, so a status filter excludes it rather than pretending
    // the filter applied to it.
    await waitFor(() => expect(screen.queryByTestId('iq-row-101')).toBeNull());
    expect(screen.getByTestId('iq-row-ins-202')).toBeInTheDocument();
  });

  it('AC1 — the date filter reaches the server as `since`', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: /intra-day queue/i });

    await user.selectOptions(screen.getByTestId('iq-since'), '1');
    await waitFor(() => expect(lastMatching('/intraday-insertions')).toContain('since='));
    expect(lastMatching('/intraday-updates')).toContain('since=');
  });

  it('AC1 — Next pages with the cursor the server handed back, and Prev comes home', async () => {
    const secondPage = [{ ...insertions[0], insertionId: '301', ticketId: 't-7777gggg' }];
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('/intraday-updates')) return page(rows);
      if (u.includes('/intraday-insertions')) {
        return u.includes('cursor=202') ? page(secondPage) : page(insertions, '202');
      }
      return json([]);
    });

    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: /intra-day queue/i });

    const next = screen.getByTestId('iq-next');
    expect(next).toBeEnabled();
    await user.click(next);

    await waitFor(() => expect(screen.getByTestId('iq-row-ins-301')).toBeInTheDocument());
    expect(screen.queryByTestId('iq-row-ins-201')).toBeNull();

    await user.click(screen.getByTestId('iq-prev'));
    await waitFor(() => expect(screen.getByTestId('iq-row-ins-201')).toBeInTheDocument());
  });

  it('AC1 — Next is disabled when the server says this page is the end', async () => {
    renderPage();
    await screen.findByRole('table', { name: /intra-day queue/i });
    expect(screen.getByTestId('iq-next')).toBeDisabled();
    expect(screen.getByTestId('iq-prev')).toBeDisabled();
  });
});

describe('#356 — the queue refreshes without a reload', () => {
  it('AC2 — the Refresh button re-reads both streams', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: /intra-day queue/i });
    const before = requested().filter((u) => u.includes('/intraday-insertions')).length;

    await user.click(screen.getByTestId('iq-refresh'));

    await waitFor(() =>
      expect(requested().filter((u) => u.includes('/intraday-insertions')).length).toBeGreaterThan(before),
    );
    expect(requested().filter((u) => u.includes('/intraday-updates')).length).toBeGreaterThan(0);
  });

  it('AC2 — the page re-reads on its own every 30 s while the tab is visible', async () => {
    vi.useFakeTimers();
    try {
      renderPage();
      await vi.waitFor(() => expect(requested().some((u) => u.includes('/intraday-insertions'))).toBe(true));
      const before = requested().filter((u) => u.includes('/intraday-insertions')).length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });

      expect(requested().filter((u) => u.includes('/intraday-insertions')).length).toBeGreaterThan(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('AC2 — a hidden tab is not polled: a dispatcher who left the page open all night comes back to one read, not a thousand', async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    try {
      renderPage();
      await vi.waitFor(() => expect(requested().some((u) => u.includes('/intraday-insertions'))).toBe(true));
      const before = requested().filter((u) => u.includes('/intraday-insertions')).length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });

      expect(requested().filter((u) => u.includes('/intraday-insertions')).length).toBe(before);
    } finally {
      visibility.mockRestore();
      vi.useRealTimers();
    }
  });
});

/**
 * #277 — the intra-day manual-assign modal (Issue 30, admin client the endpoints never had). Only an
 * `ESCALATION_REQUIRED` row offers Assign — `ASSIGNED_DIRECT` already has an SE. `available-ses`
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
      if (u.includes('/intraday-updates')) return page(rows);
      if (u.includes('/intraday-insertions/202/available-ses')) return json(candidates);
      if (u.includes('/intraday-insertions/202/manual-assign') && opts?.method === 'POST') {
        assigned = true;
        return json({ result: 'OK', insertionId: '202', scheduleId: '1', batchId: '1', seId: 'se-9999' });
      }
      if (u.includes('/intraday-insertions')) return page(assigned ? [insertions[0], afterAssign] : insertions);
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
      if (u.includes('/intraday-updates')) return page(rows);
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
      if (u.includes('/intraday-insertions')) return page(confirmed ? [insertions[0]] : insertions);
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
 * still formally assigned (escalate-only, #282 R4), and `assignTicket` refuses an assigned ticket, so
 * the queue's own Assign would 409 on exactly the rows it looks most needed on. The row carries who
 * holds the work; the door that works is a reassign on that engineer's day plan.
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
      if (u.includes('/intraday-updates')) return page(rows);
      if (u.includes('/intraday-insertions')) return page([...insertions, stranded]);
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
