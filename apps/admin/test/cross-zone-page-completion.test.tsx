import type { SessionView } from '@fsm/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { CrossZonePage } from '../src/pages/cross-zone/CrossZonePage';

/**
 * #355 — the four doors the Cross-Zone page was missing.
 *
 * The page shipped with #78 as a queue with three `window.prompt` actions on it. What it could not do
 * is everything that happens *after* a first decision: a denied AUTO escalation could not be
 * re-escalated (the route existed with no button — **#93**), a deferral's review date was invisible, an
 * approval could name a zone and an engineer that had nothing to do with each other, and a decided
 * escalation left the product entirely because the queue only reads what is still open.
 */
const OH: SessionView = { user_id: 'oh', role: 'OPERATIONS_HEAD', zone_id: null, acted_as_role: null };
const ZM: SessionView = { user_id: 'zm', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };

const row = (over: Record<string, unknown>) => ({
  escalationId: '10',
  ticketId: 't-auto0001',
  homeZoneId: '1',
  companyId: '900',
  companyTier: 'PLATINUM',
  escalationType: 'AUTO_PLATINUM',
  status: 'PENDING',
  triggerBucket: 'CRITICAL',
  flagReason: null,
  decisionReason: null,
  reviewDate: null,
  targetZoneId: null,
  assignedSeId: null,
  raisedByRole: 'SYSTEM',
  createdAt: '2026-06-30T00:00:00.000Z',
  direction: null,
  ...over,
});

const PENDING = row({});
const DENIED_AUTO = row({
  escalationId: '12',
  ticketId: 't-denied01',
  status: 'DENIED',
  decisionReason: 'no capacity anywhere',
  direction: 'outgoing',
});
const DEFERRED = row({
  escalationId: '13',
  ticketId: 't-defer001',
  status: 'DEFERRED',
  reviewDate: '2026-07-05T00:00:00.000Z',
  decisionReason: 'revisit after the morning batch',
});

const ZONES = [
  { zoneId: 1, name: 'North', zonalManagerUserId: null },
  { zoneId: 3, name: 'West', zonalManagerUserId: null },
];
const ENGINEERS = [
  { seId: 'se-north', name: 'Karan Singh', zoneId: '1', coverageType: 'FLOATING', activityStatus: 'AVAILABLE', availabilityStatus: 'AVAILABLE', activeTicketCount: 1, kitComplete: true, missingKit: [], dailyCapacity: 8, isActive: true },
  { seId: 'se-west', name: 'Deepak Verma', zoneId: '3', coverageType: 'FIXED', activityStatus: 'AVAILABLE', availabilityStatus: 'AVAILABLE', activeTicketCount: 0, kitComplete: true, missingKit: [], dailyCapacity: 8, isActive: true },
];
const HISTORY = [
  {
    auditId: '5001',
    escalationId: '12',
    ticketId: 't-denied01',
    homeZoneId: '1',
    targetZoneId: null,
    companyTier: 'PLATINUM',
    escalationType: 'AUTO_PLATINUM',
    action: 'CROSS_ZONE_DENIED',
    currentStatus: 'DENIED',
    decidedByUserId: 'csm-1',
    decidedByName: 'Anil Yadav',
    decidedByRole: 'CENTRAL_SERVICE_MANAGER',
    actedAsRole: 'ZONAL_MANAGER',
    actingZone: '1',
    reason: 'no capacity anywhere',
    at: '2026-07-01T09:30:00.000Z',
    direction: 'outgoing',
  },
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const fetchMock = vi.fn();

function stub(rows: unknown[], extra?: (url: string, opts?: RequestInit) => Response | undefined) {
  fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
    const u = String(url);
    const hit = extra?.(u, opts);
    if (hit) return hit;
    if (u.includes('/cross-zone/history')) return json(HISTORY);
    if (u.endsWith('/cross-zone')) return json(rows);
    if (u.includes('/org/zones')) return json(ZONES);
    if (u.includes('/engineers')) return json(ENGINEERS);
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
}

function renderPage(session: SessionView = OH) {
  return render(
    <AuthProvider initialSession={session}>
      <MemoryRouter>
        <CrossZonePage />
      </MemoryRouter>
    </AuthProvider>,
  );
}

beforeEach(() => {
  sessionStorage.setItem('fsm.accessToken', 'tok');
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

describe('#355 AC3 — approve is a Modal whose SE picker constrains the zone', () => {
  it('picks a zone and one of that zone’s engineers, and sends the pair', async () => {
    stub([PENDING], (u, opts) =>
      u.endsWith('/cross-zone/10/approve') && opts?.method === 'POST'
        ? json({ result: 'OK', escalationId: '10', status: 'APPROVED' })
        : undefined,
    );
    renderPage(OH);

    fireEvent.click(await screen.findByTestId('cz-approve-10'));
    const zone = await screen.findByTestId('cz-approve-zone');
    fireEvent.change(zone, { target: { value: '3' } });

    // The SE list is the chosen zone's, not everyone's: an engineer from another zone cannot be picked,
    // which is the only way the pair can be guaranteed to agree before it is sent.
    const se = screen.getByTestId('cz-approve-se') as HTMLSelectElement;
    const options = within(se).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(options).toContain('se-west');
    expect(options).not.toContain('se-north');

    fireEvent.change(se, { target: { value: 'se-west' } });
    fireEvent.click(screen.getByTestId('cz-approve-confirm'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/cross-zone/10/approve'),
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/cross-zone/10/approve'));
    const body = String((call![1] as RequestInit).body);
    expect(body).toContain('"targetZoneId":3');
    expect(body).toContain('"seId":"se-west"');
  });

  it('cannot be confirmed until both a zone and an SE are chosen', async () => {
    stub([PENDING]);
    renderPage(OH);
    fireEvent.click(await screen.findByTestId('cz-approve-10'));
    await screen.findByTestId('cz-approve-zone');
    fireEvent.click(screen.getByTestId('cz-approve-confirm'));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/approve'))).toBe(false);
  });

  it('reports a refused approve in the page’s alert rather than swallowing it', async () => {
    stub([PENDING], (u, opts) =>
      u.endsWith('/cross-zone/10/approve') && opts?.method === 'POST'
        ? json({ code: 'SE_NOT_IN_TARGET_ZONE' }, 400)
        : undefined,
    );
    renderPage(OH);
    fireEvent.click(await screen.findByTestId('cz-approve-10'));
    fireEvent.change(await screen.findByTestId('cz-approve-zone'), { target: { value: '3' } });
    fireEvent.change(screen.getByTestId('cz-approve-se'), { target: { value: 'se-west' } });
    fireEvent.click(screen.getByTestId('cz-approve-confirm'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/approve/i);
  });
});

describe('#355 AC2 — the home ZM sees a denied AUTO escalation and can re-escalate it', () => {
  it('offers Re-escalate on the denied AUTO row only', async () => {
    stub([PENDING, DENIED_AUTO], (u, opts) =>
      u.endsWith('/cross-zone/12/re-escalate') && opts?.method === 'POST'
        ? json({ result: 'OK', status: 'ESCALATED_TO_OPS' })
        : undefined,
    );
    renderPage(ZM);

    fireEvent.click(await screen.findByTestId('cz-re-escalate-12'));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/cross-zone/12/re-escalate'),
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    // A pending escalation is the decider's to answer; there is nothing for the ZM to raise yet.
    expect(screen.queryByTestId('cz-re-escalate-10')).toBeNull();
  });

  it('does not offer Re-escalate to a decider — it is the home ZM’s door', async () => {
    stub([DENIED_AUTO]);
    renderPage(OH);
    await screen.findByTestId('cz-row-12');
    expect(screen.queryByTestId('cz-re-escalate-12')).toBeNull();
  });
});

describe('#355 AC4 — a deferral’s review date is on the row', () => {
  it('shows the review date a deferred escalation will come back on', async () => {
    stub([DEFERRED]);
    renderPage(OH);
    const cell = await screen.findByTestId('cz-review-date-13');
    expect(cell).toHaveTextContent(/2026/);
  });

  it('shows a dash where there is no review date to show', async () => {
    stub([PENDING]);
    renderPage(OH);
    expect(await screen.findByTestId('cz-review-date-10')).toHaveTextContent('—');
  });
});

describe('#355 AC5 — the History tab reads decisions back', () => {
  it('lists the decider, the authority they acted under, the reason and the date', async () => {
    stub([PENDING]);
    renderPage(OH);

    fireEvent.click(await screen.findByRole('tab', { name: /history/i }));
    const rowEl = await screen.findByTestId('cz-history-5001');
    expect(rowEl).toHaveTextContent('Anil Yadav');
    expect(rowEl).toHaveTextContent(/denied/i);
    expect(rowEl).toHaveTextContent('no capacity anywhere');
    // The acting tag is the point of the column: a CSM deciding under a ZM's backup authority is not
    // the ZM's own decision, and everywhere else in the product the two look identical.
    expect(rowEl).toHaveTextContent(/acting as ZONAL_MANAGER/i);
  });

  it('only reads the history when the tab is opened', async () => {
    stub([PENDING]);
    renderPage(OH);
    await screen.findByTestId('cz-row-10');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/cross-zone/history'))).toBe(false);
    fireEvent.click(screen.getByRole('tab', { name: /history/i }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/cross-zone/history'))).toBe(true),
    );
  });
});
