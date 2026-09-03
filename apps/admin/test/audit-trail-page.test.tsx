import type { SessionView } from '@fsm/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { buildNav } from '../src/components/shell/nav';
import { AuditTrailPage } from '../src/pages/admin/AuditTrailPage';
import type { AuditLedgerRow } from '../src/api/auditTrail';

/**
 * #342 — the Audit Trail ledger page.
 *
 * What is worth pinning here is not the layout but the three things that make the screen usable as
 * evidence: the filters reach the server (a page that filters client-side over one loaded page would
 * lie about "no matches"), the acting authority is visible on the row rather than folded into the
 * actor, and a ZM is told that what they are looking at is clamped rather than being shown a zone
 * control the server would ignore.
 */
const ROW = (over: Partial<AuditLedgerRow> = {}): AuditLedgerRow => ({
  id: '900',
  at: '2026-07-01T10:05:00.000Z',
  action: 'BATCH_APPROVED',
  actorId: 'aaaaaaaa-0000-0000-0000-000000000001',
  actorName: 'Priya Nair',
  actorRole: 'CENTRAL_SERVICE_MANAGER',
  actedAsRole: 'ZONAL_MANAGER',
  actingZoneId: 1,
  zoneId: 1,
  zoneName: 'NORTH',
  entityType: 'dispatch_run',
  entityId: 'run-77',
  metadata: { previous: 'HOLD', next: 'APPROVED', reason: 'covering north while ZM is out' },
  ...over,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const fetchMock = vi.fn();
/** Every `/audit-trail` URL the page asked for, in order. */
const auditCalls: string[] = [];

beforeEach(() => {
  auditCalls.length = 0;
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

/** Routes the page's two calls; `pages` maps a cursor (or '' for the first page) to its response. */
function server(pages: Record<string, { rows: AuditLedgerRow[]; nextCursor: string | null }>) {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/org/zones')) return json([{ zoneId: 1, name: 'NORTH', zonalManagerUserId: null }]);
    if (url.includes('/audit-trail')) {
      auditCalls.push(url);
      const cursor = new URL(url, 'http://x').searchParams.get('cursor') ?? '';
      return json(pages[cursor] ?? { rows: [], nextCursor: null });
    }
    return json([]);
  });
}

const session = (role: SessionView['role'], zoneId: number | null): SessionView => ({
  user_id: 'u-1',
  role,
  zone_id: zoneId,
  acted_as_role: null,
});

function renderPage(role: SessionView['role'], zoneId: number | null = null) {
  return render(
    <MemoryRouter initialEntries={['/audit-trail']}>
      <AuthProvider initialSession={session(role, zoneId)}>
        <AuditTrailPage />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('#342 — Audit Trail page', () => {
  it('lists an audited action with its actor, its acting authority, its zone and its from/to change', async () => {
    server({ '': { rows: [ROW()], nextCursor: null } });
    renderPage('OPERATIONS_HEAD');

    const row = await screen.findByTestId('audit-row-900');
    expect(within(row).getByText('BATCH_APPROVED')).toBeInTheDocument();
    expect(within(row).getByText('Priya Nair')).toBeInTheDocument();
    // AC4's half of the story on the ledger: the borrowed authority is its own column, not a suffix.
    expect(within(row).getByText('ZONAL_MANAGER')).toBeInTheDocument();
    expect(within(row).getByText('NORTH')).toBeInTheDocument();
    // AC3 — metadata read as from → to.
    expect(within(row).getByText('HOLD')).toBeInTheDocument();
    expect(within(row).getByText('APPROVED')).toBeInTheDocument();
    expect(within(row).getByText(/covering north while ZM is out/)).toBeInTheDocument();
  });

  it('AC1 — applying a filter re-queries the server with it, rather than filtering what is loaded', async () => {
    server({ '': { rows: [ROW()], nextCursor: null } });
    renderPage('OPERATIONS_HEAD');
    await screen.findByTestId('audit-row-900');
    expect(auditCalls).toHaveLength(1);

    await userEvent.type(screen.getByTestId('audit-filter-action'), 'SETTING_UPDATED');
    await userEvent.type(screen.getByTestId('audit-filter-entity-type'), 'ticket');
    await userEvent.click(screen.getByTestId('audit-apply'));

    await waitFor(() => expect(auditCalls).toHaveLength(2));
    expect(auditCalls[1]).toContain('action=SETTING_UPDATED');
    expect(auditCalls[1]).toContain('entityType=ticket');
  });

  it('AC1 — a date range is sent as an instant window, not a bare date', async () => {
    server({ '': { rows: [], nextCursor: null } });
    renderPage('OPERATIONS_HEAD');
    await waitFor(() => expect(auditCalls).toHaveLength(1));

    await userEvent.type(screen.getByTestId('audit-filter-from'), '2026-07-01');
    await userEvent.click(screen.getByTestId('audit-apply'));

    await waitFor(() => expect(auditCalls).toHaveLength(2));
    const from = new URL(auditCalls[1], 'http://x').searchParams.get('from');
    expect(from).toMatch(/^2026-0[67]-\d{2}T/); // an ISO instant; the local day start may cross UTC midnight
  });

  it('AC5 — "Load more" pages with the keyset cursor and appends rather than replaces', async () => {
    server({
      '': { rows: [ROW({ id: '900' })], nextCursor: '900' },
      '900': { rows: [ROW({ id: '899', action: 'SETTING_UPDATED' })], nextCursor: null },
    });
    renderPage('OPERATIONS_HEAD');
    await screen.findByTestId('audit-row-900');

    await userEvent.click(screen.getByTestId('audit-load-more'));

    await screen.findByTestId('audit-row-899');
    expect(screen.getByTestId('audit-row-900')).toBeInTheDocument(); // appended, not replaced
    expect(auditCalls[1]).toContain('cursor=900');
    await waitFor(() => expect(screen.getByTestId('audit-load-more')).toBeDisabled());
  });

  it('AC2 — a ZM gets no zone control and is told the ledger is clamped; a CSM gets the zone filter', async () => {
    server({ '': { rows: [], nextCursor: null } });
    const zm = renderPage('ZONAL_MANAGER', 1);
    await waitFor(() => expect(auditCalls).toHaveLength(1));
    expect(screen.getByTestId('audit-zone-clamp-note')).toBeInTheDocument();
    expect(screen.queryByTestId('audit-filter-zone')).not.toBeInTheDocument();
    // The clamp is the server's; the page must not smuggle a zoneId of its own into the query.
    expect(auditCalls[0]).not.toContain('zoneId=');
    zm.unmount();

    auditCalls.length = 0;
    renderPage('CENTRAL_SERVICE_MANAGER');
    await waitFor(() => expect(auditCalls).toHaveLength(1));
    expect(await screen.findByTestId('audit-filter-zone')).toBeInTheDocument();
    expect(screen.queryByTestId('audit-zone-clamp-note')).not.toBeInTheDocument();
  });

  it('clicking an actor pivots the ledger onto that actor', async () => {
    server({ '': { rows: [ROW()], nextCursor: null } });
    renderPage('OPERATIONS_HEAD');
    await screen.findByTestId('audit-row-900');

    await userEvent.click(screen.getByRole('button', { name: /Priya Nair/ }));

    await waitFor(() => expect(auditCalls).toHaveLength(2));
    expect(auditCalls[1]).toContain('actorUserId=aaaaaaaa-0000-0000-0000-000000000001');
  });

  it('is in the nav for every manager role, and for no one else', () => {
    const hasLink = (role: string) =>
      buildNav(role)
        .flatMap((g) => g.items)
        .some((i) => i.to === '/audit-trail');
    expect(hasLink('ZONAL_MANAGER')).toBe(true);
    expect(hasLink('CENTRAL_SERVICE_MANAGER')).toBe(true);
    expect(hasLink('OPERATIONS_HEAD')).toBe(true);
    expect(hasLink('WAREHOUSE_MANAGER')).toBe(false);
    expect(hasLink('SERVICE_ENGINEER')).toBe(false);
  });
});
