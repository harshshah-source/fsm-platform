import type { SessionView } from '@fsm/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { AdminShell } from '../src/components/AdminShell';
import type { NotificationItem, NotificationList } from '../src/api/notifications';
import { NOTIFICATION_POLL_MS, notificationLabel, notificationLink, relativeTime } from '../src/components/shell/NotificationTray';

/**
 * #344 — the top-bar bell. It was a decorative `<button>` with no handler and no state
 * (`TopBar.tsx:215-221`), while the backend has been writing real in-app rows for managers since
 * Issue 03: cross-zone escalations a CSM must decide, `INTRADAY_ESCALATION_REQUIRED` a ZM must act
 * on. The rows existed, the endpoints existed, and no admin surface ever read them.
 *
 * The tests drive the shell, not the tray in isolation, because the two halves of the defect are a
 * *badge in the top bar* and a *tray that navigates* — both only exist in the shell's router.
 *
 * The mocked client is the api module: this slice adds no backend, and pinning the fetch shape
 * (`GET /notifications`, `POST /notifications/:id/read`, `POST /notifications/read-all`) is the
 * separate job of `notifications-client.test.ts`.
 */
vi.mock('../src/api/notifications', async () => {
  const actual = await vi.importActual<typeof import('../src/api/notifications')>('../src/api/notifications');
  return {
    ...actual,
    apiNotificationList: vi.fn(),
    apiNotificationMarkRead: vi.fn(),
    apiNotificationMarkAllRead: vi.fn(),
  };
});

import {
  apiNotificationList,
  apiNotificationMarkAllRead,
  apiNotificationMarkRead,
} from '../src/api/notifications';

const listMock = vi.mocked(apiNotificationList);
const markReadMock = vi.mocked(apiNotificationMarkRead);
const markAllMock = vi.mocked(apiNotificationMarkAllRead);

const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };
const csm: SessionView = { user_id: 'csm1', role: 'CENTRAL_SERVICE_MANAGER', zone_id: null, acted_as_role: null };
const opsHead: SessionView = { user_id: 'oh1', role: 'OPERATIONS_HEAD', zone_id: null, acted_as_role: null };
const warehouse: SessionView = { user_id: 'wm1', role: 'WAREHOUSE_MANAGER', zone_id: null, acted_as_role: null };

function row(over: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: '1',
    type: 'INTRADAY_ESCALATION_REQUIRED',
    title: 'Manual assignment needed',
    body: 'CRITICAL ticket TCK-9 could not be auto-assigned.',
    entityType: 'ticket',
    entityId: 'TCK-9',
    metadata: null,
    read: false,
    readAt: null,
    createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    ...over,
  };
}

function list(items: NotificationItem[]): NotificationList {
  return { items, unreadCount: items.filter((i) => !i.read).length };
}

/** Reports where a deep link landed, so "click navigates" is asserted on the URL, not on a spy. */
function LocationProbe() {
  const { pathname } = useLocation();
  return <div data-testid="location">{pathname}</div>;
}

function TicketProbe() {
  const { ticketId } = useParams();
  return <div data-testid="location">{`/tickets/${ticketId}`}</div>;
}

function renderShell(session: SessionView) {
  return render(
    <AuthProvider initialSession={session}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route element={<AdminShell />}>
            <Route index element={<div>home</div>} />
            <Route path="cross-zone" element={<LocationProbe />} />
            <Route path="intraday" element={<LocationProbe />} />
            <Route path="tickets/:ticketId" element={<TicketProbe />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

/** The other top-bar reads (zones, ingestion) go through `fetch`; only the notifications client is mocked. */
function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })),
  );
}

beforeEach(() => {
  stubFetch();
  listMock.mockResolvedValue(list([]));
  markReadMock.mockResolvedValue({ ok: true });
  markAllMock.mockResolvedValue({ updated: 0 });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  sessionStorage.clear();
});

const openTray = async (user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> => {
  await user.click(screen.getByRole('button', { name: /notifications/i }));
  return await screen.findByRole('dialog', { name: /notifications/i });
};

describe('#344 AC1 — the bell carries the unread count', () => {
  it('shows the unread count returned by the list call', async () => {
    listMock.mockResolvedValue(list([row({ id: '1' }), row({ id: '2' }), row({ id: '3', read: true })]));
    renderShell(zm);

    const bell = await screen.findByRole('button', { name: /notifications/i });
    await waitFor(() => expect(within(bell).getByTestId('notification-badge')).toHaveTextContent('2'));
    expect(bell).toHaveAccessibleName(/2 unread/i);
  });

  it('shows no badge at all when nothing is unread', async () => {
    listMock.mockResolvedValue(list([row({ id: '1', read: true })]));
    renderShell(zm);

    await waitFor(() => expect(listMock).toHaveBeenCalled());
    expect(screen.queryByTestId('notification-badge')).not.toBeInTheDocument();
  });

  it('caps the badge at 99+ rather than widening the top bar', async () => {
    listMock.mockResolvedValue({ items: [row()], unreadCount: 137 });
    renderShell(zm);

    expect(await screen.findByTestId('notification-badge')).toHaveTextContent('99+');
  });

  it('re-reads the list every 60 s so the badge is not stuck on the page load', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    listMock.mockResolvedValue(list([row()]));
    renderShell(zm);

    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POLL_MS);
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
  });
});

describe('#344 AC2 — the tray lists the newest rows with a type label and relative time', () => {
  it('opens on click and renders each row with its type label, title and age', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue(
      list([
        row({ id: '1', type: 'CROSS_ZONE_AUTO_ESCALATION', title: 'Platinum cross-zone escalation' }),
        row({ id: '2', type: 'INTRADAY_ESCALATION_REQUIRED', title: 'Manual assignment needed' }),
      ]),
    );
    renderShell(csm);
    await waitFor(() => expect(listMock).toHaveBeenCalled());

    const tray = await openTray(user);

    expect(within(tray).getByText('Platinum cross-zone escalation')).toBeInTheDocument();
    expect(within(tray).getByText('Manual assignment needed')).toBeInTheDocument();
    expect(within(tray).getAllByText('Cross-zone')).toHaveLength(1);
    expect(within(tray).getAllByText('Intra-day')).toHaveLength(1);
    expect(within(tray).getAllByText('5m ago')).toHaveLength(2);
  });

  it('renders the newest first, in the order the backend returned', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue(
      list([
        row({ id: '1', title: 'newest' }),
        row({ id: '2', title: 'older', createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString() }),
      ]),
    );
    renderShell(zm);
    await waitFor(() => expect(listMock).toHaveBeenCalled());

    const tray = await openTray(user);
    const titles = within(tray)
      .getAllByRole('listitem')
      .map((li) => li.textContent ?? '');

    expect(titles[0]).toContain('newest');
    expect(titles[1]).toContain('older');
    expect(titles[1]).toContain('3h ago');
  });

  it('says so when there is nothing to show, rather than opening an empty box', async () => {
    const user = userEvent.setup();
    renderShell(zm);
    await waitFor(() => expect(listMock).toHaveBeenCalled());

    const tray = await openTray(user);

    expect(within(tray).getByText(/no notifications/i)).toBeInTheDocument();
  });

  it('surfaces a failed read instead of showing an empty tray', async () => {
    const user = userEvent.setup();
    listMock.mockRejectedValue(new Error('REQUEST_FAILED_500'));
    renderShell(zm);
    await waitFor(() => expect(listMock).toHaveBeenCalled());

    const tray = await openTray(user);

    expect(within(tray).getByRole('alert')).toHaveTextContent(/could not be loaded/i);
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    renderShell(zm);
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    await openTray(user);

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog', { name: /notifications/i })).not.toBeInTheDocument();
  });
});

describe('#344 AC3 — clicking a row marks it read and navigates', () => {
  it('an intra-day escalation lands on the Intra-day Queue and is marked read', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue(list([row({ id: '7', type: 'INTRADAY_ESCALATION_REQUIRED' })]));
    renderShell(zm);
    await waitFor(() => expect(listMock).toHaveBeenCalled());

    const tray = await openTray(user);
    await user.click(within(tray).getByRole('button', { name: /manual assignment needed/i }));

    expect(markReadMock).toHaveBeenCalledWith('7');
    expect(await screen.findByTestId('location')).toHaveTextContent('/intraday');
    expect(screen.queryByRole('dialog', { name: /notifications/i })).not.toBeInTheDocument();
  });

  it('a cross-zone escalation lands on the Cross-Zone queue', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue(
      list([row({ id: '8', type: 'CROSS_ZONE_MANUAL_FLAG', title: 'Cross-zone flag raised' })]),
    );
    renderShell(csm);
    await waitFor(() => expect(listMock).toHaveBeenCalled());

    const tray = await openTray(user);
    await user.click(within(tray).getByRole('button', { name: /cross-zone flag raised/i }));

    expect(await screen.findByTestId('location')).toHaveTextContent('/cross-zone');
  });

  it('a ticket-entity notification with no queue of its own opens the ticket', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue(
      list([row({ id: '9', type: 'INSTALL_FAILED_ACTIVATION', title: 'Activation failed', entityId: 'TCK-42' })]),
    );
    renderShell(opsHead);
    await waitFor(() => expect(listMock).toHaveBeenCalled());

    const tray = await openTray(user);
    await user.click(within(tray).getByRole('button', { name: /activation failed/i }));

    expect(await screen.findByTestId('location')).toHaveTextContent('/tickets/TCK-42');
  });

  it('marks read without navigating when the row has nowhere to go', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue(
      list([row({ id: '10', type: 'DAY_PLAN_DISPATCHED', title: 'Day plan dispatched', entityType: null, entityId: null })]),
    );
    renderShell(zm);
    await waitFor(() => expect(listMock).toHaveBeenCalled());

    const tray = await openTray(user);
    await user.click(within(tray).getByRole('button', { name: /day plan dispatched/i }));

    expect(markReadMock).toHaveBeenCalledWith('10');
    expect(screen.queryByTestId('location')).not.toBeInTheDocument();
    // The tray stays open: nothing moved, so closing it would look like the click was swallowed.
    expect(screen.getByRole('dialog', { name: /notifications/i })).toBeInTheDocument();
  });

  it('drops the badge optimistically rather than waiting for the next poll', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue(list([row({ id: '11' }), row({ id: '12' })]));
    renderShell(zm);
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    expect(await screen.findByTestId('notification-badge')).toHaveTextContent('2');

    const tray = await openTray(user);
    await user.click(within(tray).getAllByRole('button', { name: /manual assignment needed/i })[0]);

    await waitFor(() => expect(screen.getByTestId('notification-badge')).toHaveTextContent('1'));
  });

  it('an already-read row navigates without a second mark-read call', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue(list([row({ id: '13', read: true, readAt: new Date().toISOString() })]));
    renderShell(zm);
    await waitFor(() => expect(listMock).toHaveBeenCalled());

    const tray = await openTray(user);
    await user.click(within(tray).getByRole('button', { name: /manual assignment needed/i }));

    expect(markReadMock).not.toHaveBeenCalled();
    expect(await screen.findByTestId('location')).toHaveTextContent('/intraday');
  });
});

describe('#344 AC4 — mark all read', () => {
  it('clears every unread row and the badge in one call', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue(list([row({ id: '1' }), row({ id: '2' })]));
    markAllMock.mockResolvedValue({ updated: 2 });
    renderShell(zm);
    await waitFor(() => expect(listMock).toHaveBeenCalled());

    const tray = await openTray(user);
    await user.click(within(tray).getByRole('button', { name: /mark all read/i }));

    expect(markAllMock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId('notification-badge')).not.toBeInTheDocument());
  });

  it('offers no mark-all control when there is nothing unread', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue(list([row({ id: '1', read: true })]));
    renderShell(zm);
    await waitFor(() => expect(listMock).toHaveBeenCalled());

    const tray = await openTray(user);

    expect(within(tray).queryByRole('button', { name: /mark all read/i })).not.toBeInTheDocument();
  });
});

describe('#344 AC5 — every admin role', () => {
  it.each([
    ['ZONAL_MANAGER', zm],
    ['CENTRAL_SERVICE_MANAGER', csm],
    ['OPERATIONS_HEAD', opsHead],
    ['WAREHOUSE_MANAGER', warehouse],
  ])('%s gets the bell, the count and an openable tray', async (_role, session) => {
    const user = userEvent.setup();
    listMock.mockResolvedValue(list([row({ id: '1' })]));
    renderShell(session);

    expect(await screen.findByTestId('notification-badge')).toHaveTextContent('1');
    const tray = await openTray(user);
    expect(within(tray).getByText('Manual assignment needed')).toBeInTheDocument();
  });

  /**
   * `/cross-zone` and `/intraday` are behind `RoleRoute` for the three manager roles
   * (`AppRoutes.tsx:359,387`). A Warehouse Manager who somehow holds a cross-zone row must not be
   * sent to a gate that bounces them — the ticket the row is about is reachable, so that is where
   * the link goes.
   */
  it('does not deep-link a Warehouse Manager into a queue their role cannot open', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue(
      list([row({ id: '1', type: 'CROSS_ZONE_DECISION', title: 'Cross-zone escalation approved', entityId: 'TCK-5' })]),
    );
    renderShell(warehouse);
    await waitFor(() => expect(listMock).toHaveBeenCalled());

    const tray = await openTray(user);
    await user.click(within(tray).getByRole('button', { name: /cross-zone escalation approved/i }));

    expect(await screen.findByTestId('location')).toHaveTextContent('/tickets/TCK-5');
  });
});

describe('#344 — the pure helpers', () => {
  const at = (iso: string) => new Date(iso);

  it('relativeTime reads in the units an operator thinks in', () => {
    const now = at('2026-09-03T12:00:00Z');
    expect(relativeTime('2026-09-03T11:59:30Z', now)).toBe('just now');
    expect(relativeTime('2026-09-03T11:45:00Z', now)).toBe('15m ago');
    expect(relativeTime('2026-09-03T08:00:00Z', now)).toBe('4h ago');
    expect(relativeTime('2026-09-01T12:00:00Z', now)).toBe('2d ago');
    expect(relativeTime('2026-07-01T12:00:00Z', now)).toBe('01 Jul');
  });

  it('relativeTime never renders a future stamp as a negative age', () => {
    const now = at('2026-09-03T12:00:00Z');
    expect(relativeTime('2026-09-03T12:00:30Z', now)).toBe('just now');
  });

  it('relativeTime degrades rather than printing NaN', () => {
    expect(relativeTime('not-a-date', at('2026-09-03T12:00:00Z'))).toBe('—');
  });

  it('notificationLabel names the family, and falls back to a readable form for an unknown type', () => {
    expect(notificationLabel('CROSS_ZONE_AUTO_ESCALATION')).toBe('Cross-zone');
    expect(notificationLabel('INTRADAY_MANUAL_ASSIGNED')).toBe('Intra-day');
    expect(notificationLabel('DAY_PLAN_OVERRIDDEN')).toBe('Day plan');
    expect(notificationLabel('SOMETHING_BRAND_NEW')).toBe('Something brand new');
  });

  it('notificationLink prefers the type queue, then the ticket, then nothing', () => {
    expect(notificationLink(row({ type: 'CROSS_ZONE_DECISION' }), 'ZONAL_MANAGER')).toBe('/cross-zone');
    expect(notificationLink(row({ type: 'INTRADAY_DIRECT_ASSIGNED' }), 'ZONAL_MANAGER')).toBe('/intraday');
    expect(notificationLink(row({ type: 'INSTALL_VERIFIED', entityId: 'T1' }), 'ZONAL_MANAGER')).toBe('/tickets/T1');
    expect(notificationLink(row({ type: 'INSTALL_VERIFIED', entityType: 'engineer_master', entityId: 'SE1' }), 'ZONAL_MANAGER')).toBeNull();
    expect(notificationLink(row({ type: 'DAY_PLAN_DISPATCHED', entityType: null, entityId: null }), 'ZONAL_MANAGER')).toBeNull();
    // The queues are role-gated, so the same row resolves differently for a role that cannot open them.
    expect(notificationLink(row({ type: 'INTRADAY_DIRECT_ASSIGNED', entityId: 'T9' }), 'WAREHOUSE_MANAGER')).toBe('/tickets/T9');
  });
});
