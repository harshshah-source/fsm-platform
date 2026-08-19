import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CriticalQueueGroup } from '../src/api/dashboard';
import { CriticalQueue } from '../src/pages/dashboard/CriticalQueue';

/**
 * #249 AC5 — the assign surfaces surface the hold instead of swallowing it.
 *
 * The backend now answers a 409 `CONFLICT_DEFERRED` when a manager assigns a ticket whose vehicle is
 * not due back yet. Left unhandled, that is worse than the silent bypass it replaced: the click would
 * simply fail with no explanation. So the queue holds the assign, shows what it is overriding — the
 * return date, and the SE's proposed date beside the authoritative one when a manager has moved it
 * (#245) — and requires a reason before it will resend with `confirm`.
 *
 * The UX is the existing ON_SITE conflict banner extended, not a new pattern: same inline alert, same
 * Confirm/Cancel pair, one added field for the thing that is genuinely new here.
 */
const groups: CriticalQueueGroup[] = [
  {
    companyId: '10',
    companyName: 'Acme Logistics',
    companyTier: 'PLATINUM',
    zoneId: '1',
    plantId: '7',
    plantName: 'Yard-1',
    clusterSize: 1,
    suggestedSes: [],
    tickets: [{ ticketId: 't1', deviceId: '900', slaBucket: 'CRITICAL', latestGpsDatetime: null, status: 'OPEN' }],
  },
];

const engineers = [
  { engineerId: 'se-north-1', coverageType: 'MULTI_PLANT', zoneId: '1', dailyCapacity: 10, isActive: true },
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const CONFLICT = {
  code: 'CONFLICT_DEFERRED',
  message: 'Ticket is held to a future vehicle-return date — resend with confirm=true and a reason.',
  ticketId: 't1',
  deferredUntil: '2026-06-26T00:00:00.000Z',
  vuReport: {
    id: '42',
    proposedFrom: '2026-06-25T09:00:00.000Z',
    expectedFrom: '2026-06-26T09:00:00.000Z',
  },
};

const fetchMock = vi.fn();

/** Answers the first assign with the 409 and every later one with OK — the resend path under test. */
function stubAssign(): { posts: () => { confirm?: boolean; reasonCode?: string; ticketId: string }[] } {
  const bodies: { confirm?: boolean; reasonCode?: string; ticketId: string }[] = [];
  let seen = 0;
  fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
    const u = String(url);
    if (u.includes('/schedules/assign') && (opts?.method ?? 'GET') === 'POST') {
      bodies.push(JSON.parse(String(opts?.body)));
      seen += 1;
      if (seen === 1) return json(CONFLICT, 409);
      return json({ result: 'OK', scheduleId: '1', batchId: '1', ticketId: 't1', seId: 'se-north-1' });
    }
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return { posts: () => bodies };
}

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

describe('#249 AC5 — return-date confirm on the Critical Work Queue assign', () => {
  it('holds the assign, shows the return-date context, and refuses an empty reason', async () => {
    const { posts } = stubAssign();
    const onAssigned = vi.fn();
    render(<CriticalQueue groups={groups} engineers={engineers} onAssigned={onAssigned} />);

    const group = screen.getByText('Yard-1').closest('[data-testid="critical-group"]') as HTMLElement;
    await userEvent.selectOptions(within(group).getByLabelText(/assign to/i), 'se-north-1');
    await userEvent.click(within(group).getByRole('button', { name: /^assign$/i }));

    const banner = await screen.findByTestId('deferral-conflict-banner');
    // The dates a manager needs to decide: when it comes back, what the SE said, what stands now.
    expect(within(banner).getByTestId('deferral-until')).toHaveTextContent('2026-06-26');
    expect(within(banner).getByTestId('deferral-proposed-from')).toHaveTextContent('2026-06-25');
    expect(within(banner).getByTestId('deferral-expected-from')).toHaveTextContent('2026-06-26');

    // Nothing was assigned, and the confirm is unusable until a reason exists.
    expect(onAssigned).not.toHaveBeenCalled();
    expect(within(banner).getByRole('button', { name: /confirm/i })).toBeDisabled();
    await userEvent.type(within(banner).getByLabelText(/reason/i), '   ');
    expect(within(banner).getByRole('button', { name: /confirm/i })).toBeDisabled();
    expect(posts()).toHaveLength(1);
  });

  it('resends with confirm and the reason once the manager states one', async () => {
    const { posts } = stubAssign();
    const onAssigned = vi.fn();
    render(<CriticalQueue groups={groups} engineers={engineers} onAssigned={onAssigned} />);

    const group = screen.getByText('Yard-1').closest('[data-testid="critical-group"]') as HTMLElement;
    await userEvent.selectOptions(within(group).getByLabelText(/assign to/i), 'se-north-1');
    await userEvent.click(within(group).getByRole('button', { name: /^assign$/i }));

    const banner = await screen.findByTestId('deferral-conflict-banner');
    await userEvent.type(within(banner).getByLabelText(/reason/i), 'vehicle sourced locally');
    await userEvent.click(within(banner).getByRole('button', { name: /confirm/i }));

    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[0].confirm).toBeUndefined();
    expect(posts()[1]).toMatchObject({ ticketId: 't1', confirm: true, reasonCode: 'vehicle sourced locally' });
    await waitFor(() => expect(onAssigned).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('deferral-conflict-banner')).not.toBeInTheDocument());
  });

  it('cancelling leaves the hold standing and sends nothing further', async () => {
    const { posts } = stubAssign();
    const onAssigned = vi.fn();
    render(<CriticalQueue groups={groups} engineers={engineers} onAssigned={onAssigned} />);

    const group = screen.getByText('Yard-1').closest('[data-testid="critical-group"]') as HTMLElement;
    await userEvent.selectOptions(within(group).getByLabelText(/assign to/i), 'se-north-1');
    await userEvent.click(within(group).getByRole('button', { name: /^assign$/i }));

    const banner = await screen.findByTestId('deferral-conflict-banner');
    await userEvent.click(within(banner).getByRole('button', { name: /cancel/i }));

    await waitFor(() => expect(screen.queryByTestId('deferral-conflict-banner')).not.toBeInTheDocument());
    expect(posts()).toHaveLength(1);
    expect(onAssigned).not.toHaveBeenCalled();
  });
});
