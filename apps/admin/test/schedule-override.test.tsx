import type { SessionView } from '@fsm/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { ScheduleDetailPage } from '../src/pages/schedules/ScheduleDetailPage';

/**
 * Issue 13b slice 3 — ZM override controls on the Schedule detail page. Each action POSTs
 * `/api/batches/:id/override` with a mandatory free-text reason and the page refetches to reflect the
 * immediate OVERRIDDEN flip (AC#3/#4). No approval gate. Reorder is slice 4; the ON_SITE conflict
 * banner is slice 5.
 */
const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };

interface MutTicket {
  ticketId: string;
  sortOrder: number;
  removed?: boolean;
  deferredToDate?: string;
}
interface MutStop {
  batchId: string;
  stopSequence: number;
  plantId: string;
  plantName: string;
  status: string;
  movedAway?: boolean;
  tickets: MutTicket[];
}

let stops: MutStop[];
let overridden: boolean;
const fetchMock = vi.fn();

const ENGINEERS = [
  { engineerId: 'se-north-1', coverageType: 'MULTI_PLANT', zoneId: '1', dailyCapacity: 10, isActive: true },
  { engineerId: 'se-north-2', coverageType: 'MULTI_PLANT', zoneId: '1', dailyCapacity: 10, isActive: true },
];

function detailBody() {
  return {
    scheduleId: '10',
    seId: 'se-north-1',
    status: overridden ? 'OVERRIDDEN' : 'AUTO_ASSIGNED',
    dateFrom: '2026-06-22',
    dateTo: '2026-06-22',
    stops: stops
      .filter((s) => !s.movedAway)
      .slice()
      .sort((a, b) => a.stopSequence - b.stopSequence)
      .map((s) => ({
        ...s,
        deviceCount: s.tickets.filter((t) => !t.removed).length,
        tickets: s.tickets
          .filter((t) => !t.removed)
          .map((t) => ({ ticketId: t.ticketId, sortOrder: t.sortOrder, reasoning: null })),
      })),
  };
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

function stub() {
  fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
    const u = String(url);
    const method = opts?.method ?? 'GET';
    if (u.includes('/schedules/engineers')) return json(ENGINEERS);
    if (u.includes('/batches/') && u.includes('/override') && method === 'POST') {
      const batchId = u.match(/batches\/(\d+)\/override/)![1];
      const body = JSON.parse(String(opts?.body)) as {
        action: string;
        ticketId?: string;
        ticketIds?: string[];
        deferredToDate?: string;
        stopSequence?: number;
      };
      const stop = stops.find((s) => s.batchId === batchId)!;
      if (body.action === 'REMOVE_TICKET') {
        stop.tickets.find((t) => t.ticketId === body.ticketId)!.removed = true;
      }
      if (body.action === 'DEFER_TICKET') {
        stop.tickets.find((t) => t.ticketId === body.ticketId)!.deferredToDate = body.deferredToDate;
      }
      if (body.action === 'SWAP_SE') {
        stop.movedAway = true;
      }
      if (body.action === 'REASSIGN') {
        stop.tickets.find((t) => t.ticketId === body.ticketId)!.removed = true;
      }
      if (body.action === 'SPLIT_BATCH') {
        for (const id of body.ticketIds ?? []) {
          stop.tickets.find((t) => t.ticketId === id)!.removed = true;
        }
      }
      if (body.action === 'REORDER') {
        const others = stops.filter((s) => s !== stop);
        const pos = Math.max(1, Math.min(body.stopSequence ?? 1, stops.length));
        const ordered = [...others];
        ordered.splice(pos - 1, 0, stop);
        ordered.forEach((s, i) => (s.stopSequence = i + 1));
      }
      overridden = true;
      return json({ result: 'OK', batchId, scheduleId: '10', seId: 'se-north-1', status: 'OVERRIDDEN' });
    }
    return json(detailBody()); // GET detail
  });
  vi.stubGlobal('fetch', fetchMock);
}

function renderPage() {
  return render(
    <AuthProvider initialSession={zm}>
      <MemoryRouter initialEntries={['/schedules/se-north-1']}>
        <Routes>
          <Route path="/schedules/:engineerId" element={<ScheduleDetailPage />} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

beforeEach(() => {
  overridden = false;
  stops = [
    {
      batchId: '100',
      stopSequence: 1,
      plantId: '7',
      plantName: 'Pune Depot',
      status: 'AUTO_ASSIGNED',
      tickets: [
        { ticketId: 'tkt-1', sortOrder: 1 },
        { ticketId: 'tkt-2', sortOrder: 2 },
      ],
    },
  ];
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

function overrideCall(action: string) {
  return fetchMock.mock.calls.find(
    ([url, opts]) =>
      String(url).includes('/override') &&
      (opts as RequestInit | undefined)?.method === 'POST' &&
      String((opts as RequestInit).body).includes(`"action":"${action}"`),
  );
}

describe('ZM override — Remove ticket (Issue 13b AC#3/#4)', () => {
  it('removes a ticket with a mandatory reason and reflects the refetched OVERRIDDEN state', async () => {
    stub();
    renderPage();

    const stop = within((await screen.findAllByTestId('schedule-stop'))[0]);
    const row = within(stop.getByTestId('ticket-row-tkt-1'));

    await userEvent.click(row.getByRole('button', { name: /remove/i }));

    // Reason is mandatory — Confirm is blocked until a reason is entered.
    const confirm = stop.getByRole('button', { name: /confirm remove/i });
    expect(confirm).toBeDisabled();

    await userEvent.type(stop.getByLabelText(/reason/i), 'duplicate visit');
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);

    await waitFor(() => {
      const call = overrideCall('REMOVE_TICKET');
      expect(call).toBeTruthy();
      const body = String((call![1] as RequestInit).body);
      expect(body).toContain('"ticketId":"tkt-1"');
      expect(body).toContain('"reasonCode":"duplicate visit"');
      expect(String(call![0])).toContain('/batches/100/override');
    });

    // Refetch reflects the removal + the OVERRIDDEN flip.
    await waitFor(() => {
      expect(screen.queryByTestId('ticket-row-tkt-1')).toBeNull();
    });
    expect(screen.getByTestId('schedule-status-OVERRIDDEN')).toBeInTheDocument();
  });
});

describe('ZM override — Defer ticket (Issue 13b AC#3)', () => {
  it('defers a ticket to a date with a mandatory reason and reflects OVERRIDDEN', async () => {
    stub();
    renderPage();

    const stop = within((await screen.findAllByTestId('schedule-stop'))[0]);
    const row = within(stop.getByTestId('ticket-row-tkt-2'));

    await userEvent.click(row.getByRole('button', { name: /defer/i }));

    // Both a target date and a reason are mandatory before Confirm enables.
    const confirm = row.getByRole('button', { name: /confirm defer/i });
    expect(confirm).toBeDisabled();

    fireEvent.change(row.getByLabelText(/defer to/i), { target: { value: '2026-06-25' } });
    await userEvent.type(row.getByLabelText(/reason/i), 'awaiting access');
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);

    await waitFor(() => {
      const call = overrideCall('DEFER_TICKET');
      expect(call).toBeTruthy();
      const body = String((call![1] as RequestInit).body);
      expect(body).toContain('"ticketId":"tkt-2"');
      expect(body).toContain('"deferredToDate":"2026-06-25"');
      expect(body).toContain('"reasonCode":"awaiting access"');
      expect(String(call![0])).toContain('/batches/100/override');
    });

    await waitFor(() => {
      expect(screen.getByTestId('schedule-status-OVERRIDDEN')).toBeInTheDocument();
    });
  });
});

describe('ZM override — Swap SE (Issue 13b AC#3/#4)', () => {
  it('swaps a whole batch to a target SE picked from the zone list, with a mandatory reason', async () => {
    stub();
    renderPage();

    const stop = within((await screen.findAllByTestId('schedule-stop'))[0]);
    await userEvent.click(stop.getByRole('button', { name: /swap se/i }));

    // Target SE comes from the zone-scoped engineer list (not the Ops-Head /org/engineers).
    const picker = await stop.findByLabelText(/target se/i);
    expect(within(picker).getByRole('option', { name: 'se-north-2' })).toBeInTheDocument();

    const confirm = stop.getByRole('button', { name: /confirm swap/i });
    expect(confirm).toBeDisabled();

    await userEvent.selectOptions(picker, 'se-north-2');
    await userEvent.type(stop.getByLabelText(/reason/i), 'se1 off sick');
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);

    await waitFor(() => {
      const call = overrideCall('SWAP_SE');
      expect(call).toBeTruthy();
      const body = String((call![1] as RequestInit).body);
      expect(body).toContain('"newSeId":"se-north-2"');
      expect(body).toContain('"reasonCode":"se1 off sick"');
      expect(String(call![0])).toContain('/batches/100/override');
    });

    // The swapped batch leaves this SE's schedule; the schedule reflects OVERRIDDEN.
    await waitFor(() => {
      expect(screen.queryByTestId('schedule-stop')).toBeNull();
    });
    expect(screen.getByTestId('schedule-status-OVERRIDDEN')).toBeInTheDocument();
  });
});

describe('ZM override — Reassign ticket (Issue 13b AC#3/#4)', () => {
  it('reassigns one ticket to a target SE with a mandatory reason', async () => {
    stub();
    renderPage();

    const stop = within((await screen.findAllByTestId('schedule-stop'))[0]);
    const row = within(stop.getByTestId('ticket-row-tkt-1'));

    await userEvent.click(row.getByRole('button', { name: /reassign/i }));

    const picker = await row.findByLabelText(/target se/i);
    const confirm = row.getByRole('button', { name: /confirm reassign/i });
    expect(confirm).toBeDisabled();

    await userEvent.selectOptions(picker, 'se-north-2');
    await userEvent.type(row.getByLabelText(/reason/i), 'closer se');
    await userEvent.click(confirm);

    await waitFor(() => {
      const call = overrideCall('REASSIGN');
      expect(call).toBeTruthy();
      const body = String((call![1] as RequestInit).body);
      expect(body).toContain('"ticketId":"tkt-1"');
      expect(body).toContain('"newSeId":"se-north-2"');
      expect(body).toContain('"reasonCode":"closer se"');
    });

    await waitFor(() => {
      expect(screen.queryByTestId('ticket-row-tkt-1')).toBeNull();
    });
    expect(screen.getByTestId('schedule-status-OVERRIDDEN')).toBeInTheDocument();
  });
});

describe('ZM override — Split batch (Issue 13b AC#3/#4)', () => {
  it('splits selected tickets to a target SE with a mandatory reason', async () => {
    stub();
    renderPage();

    const stop = within((await screen.findAllByTestId('schedule-stop'))[0]);
    await userEvent.click(stop.getByRole('button', { name: /split batch/i }));

    const confirm = stop.getByRole('button', { name: /confirm split/i });
    expect(confirm).toBeDisabled();

    // Pick a subset of tickets, a target SE, and a reason.
    await userEvent.click(within(stop.getByTestId('ticket-row-tkt-2')).getByRole('checkbox'));
    await userEvent.selectOptions(await stop.findByLabelText(/target se/i), 'se-north-2');
    await userEvent.type(stop.getByLabelText(/reason/i), 'load balance');
    await userEvent.click(confirm);

    await waitFor(() => {
      const call = overrideCall('SPLIT_BATCH');
      expect(call).toBeTruthy();
      const body = String((call![1] as RequestInit).body);
      expect(body).toContain('"ticketIds":["tkt-2"]');
      expect(body).toContain('"newSeId":"se-north-2"');
      expect(body).toContain('"reasonCode":"load balance"');
    });

    // The moved ticket leaves the stop; the kept ticket stays.
    await waitFor(() => {
      expect(screen.queryByTestId('ticket-row-tkt-2')).toBeNull();
    });
    expect(screen.getByTestId('ticket-row-tkt-1')).toBeInTheDocument();
  });
});

describe('ZM override — Reorder stops (Issue 13b AC#3)', () => {
  it('moves a stop to a new position with a mandatory reason and reflects the new order', async () => {
    stub();
    // Local two-stop fixture (the stub reads `stops` lazily at fetch time).
    stops = [
      { batchId: '100', stopSequence: 1, plantId: '7', plantName: 'Pune Depot', status: 'AUTO_ASSIGNED', tickets: [{ ticketId: 'tkt-1', sortOrder: 1 }] },
      { batchId: '101', stopSequence: 2, plantId: '8', plantName: 'Mumbai Yard', status: 'AUTO_ASSIGNED', tickets: [{ ticketId: 'tkt-9', sortOrder: 1 }] },
    ];
    renderPage();

    let rows = await screen.findAllByTestId('schedule-stop');
    expect(rows[0]).toHaveTextContent('Pune Depot');
    expect(rows[1]).toHaveTextContent('Mumbai Yard');

    // Move Pune (stop 1) to position 2.
    const pune = within(rows[0]);
    await userEvent.click(pune.getByRole('button', { name: /reorder/i }));
    const confirm = pune.getByRole('button', { name: /confirm reorder/i });
    expect(confirm).toBeDisabled();

    fireEvent.change(pune.getByLabelText(/move to position/i), { target: { value: '2' } });
    await userEvent.type(pune.getByLabelText(/reason/i), 'cluster route');
    await userEvent.click(confirm);

    await waitFor(() => {
      const call = overrideCall('REORDER');
      expect(call).toBeTruthy();
      const body = String((call![1] as RequestInit).body);
      expect(body).toContain('"stopSequence":2');
      expect(body).toContain('"reasonCode":"cluster route"');
      expect(String(call![0])).toContain('/batches/100/override');
    });

    // Order reflects the move on refetch.
    await waitFor(() => {
      rows = screen.getAllByTestId('schedule-stop');
      expect(rows[0]).toHaveTextContent('Mumbai Yard');
      expect(rows[1]).toHaveTextContent('Pune Depot');
    });
  });
});

function stubConflict() {
  fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
    const u = String(url);
    const method = opts?.method ?? 'GET';
    if (u.includes('/schedules/engineers')) return json(ENGINEERS);
    if (u.includes('/override') && method === 'POST') {
      const body = JSON.parse(String(opts?.body)) as { ticketId?: string; confirm?: boolean };
      if (!body.confirm) {
        return new Response(
          JSON.stringify({
            code: 'OVERRIDE_ON_SITE_CONFLICT',
            message: 'SE holds ON_SITE on affected work — resend with confirm=true and a reason code.',
            ticketIds: ['tkt-1'],
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        );
      }
      stops[0].tickets.find((t) => t.ticketId === body.ticketId)!.removed = true;
      overridden = true;
      return json({ result: 'OK', batchId: '100', scheduleId: '10', seId: 'se-north-1', status: 'OVERRIDDEN' });
    }
    return json(detailBody());
  });
  vi.stubGlobal('fetch', fetchMock);
}

describe('ZM override — ON_SITE conflict banner (Issue 13b AC#5)', () => {
  it('surfaces the conflict, then re-submits with confirm to commit', async () => {
    stubConflict();
    renderPage();

    const stop = within((await screen.findAllByTestId('schedule-stop'))[0]);
    const row = within(stop.getByTestId('ticket-row-tkt-1'));
    await userEvent.click(row.getByRole('button', { name: /remove/i }));
    await userEvent.type(stop.getByLabelText(/reason/i), 'duplicate visit');
    await userEvent.click(stop.getByRole('button', { name: /confirm remove/i }));

    // The first POST hit the 409 — a conflict banner names the affected ON_SITE ticket.
    const banner = await screen.findByTestId('onsite-conflict-banner');
    expect(banner).toHaveTextContent(/ON_SITE/i);
    expect(banner).toHaveTextContent('tkt-1');
    // The ticket is not yet removed (no silent commit).
    expect(screen.getByTestId('ticket-row-tkt-1')).toBeInTheDocument();

    await userEvent.click(within(banner).getByRole('button', { name: /confirm override/i }));

    await waitFor(() => {
      const confirmed = fetchMock.mock.calls.some(
        ([url, opts]) =>
          String(url).includes('/override') &&
          (opts as RequestInit | undefined)?.method === 'POST' &&
          String((opts as RequestInit).body).includes('"confirm":true'),
      );
      expect(confirmed).toBe(true);
    });

    // Now it commits and the banner clears.
    await waitFor(() => {
      expect(screen.queryByTestId('ticket-row-tkt-1')).toBeNull();
    });
    expect(screen.queryByTestId('onsite-conflict-banner')).toBeNull();
  });
});
