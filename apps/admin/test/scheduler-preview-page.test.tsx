import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildNav } from '../src/components/shell/nav';
import { SchedulerPreviewPage } from '../src/pages/schedules/SchedulerPreviewPage';

/**
 * #251 — the Scheduler Preview page.
 *
 * The behaviours worth pinning are the ones an operator could be misled by:
 *  - the as-of caveat is **present and carries the real watermark** (AC-6) — a preview that implied
 *    it was predicting future severities would be actively wrong;
 *  - a hold on a ticket carrying a vehicle-return date **asks before overwriting** (AC-4), rather
 *    than silently replacing an operational fact with a scheduling preference;
 *  - the hold sends the day **after** the previewed date, because `notDeferredOn` is inclusive — an
 *    off-by-one here would produce a hold that visibly does nothing.
 */
const TICKET = '11111111-1111-1111-1111-111111111111';
const SE = '22222222-2222-2222-2222-222222222222';

const PREVIEW = {
  targetDate: '2026-06-22',
  bucketsAsOf: '2026-06-21T06:00:00.000Z',
  previewToken: 'tok-1',
  errors: [],
  holds: [],
  zones: [
    {
      zoneId: '1',
      targetDate: '2026-06-22',
      bucketsAsOf: '2026-06-21T06:00:00.000Z',
      mode: 'DEFICIT',
      recommended: 1,
      unassignable: 0,
      withheldBelowThreshold: 2,
      unassignableReasons: { NO_COVERAGE: 0, ALL_DROPPED: 0, dropBuckets: {} },
      decisions: [
        {
          ticketId: TICKET,
          plantId: '7',
          processingRank: 1,
          companyTier: 'GOLD',
          deviceBucket: 'CRITICAL',
          tierOverrideId: null,
          seId: SE,
          coverageType: 'DEDICATED',
          score: 4.2,
          candidatesTotal: 1,
          passedCount: 1,
          dropCounts: {},
          poolEmptyReason: null,
          plannerBias: false,
          clusterSeed: true,
          capacityAtDecision: { used: 1, cap: 10 },
        },
      ],
      plan: [{ seId: SE, plants: [{ plantId: '7', ticketIds: [TICKET] }] }],
    },
  ],
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

describe('Scheduler Preview nav (#251)', () => {
  const link = (role: string) =>
    buildNav(role)
      .flatMap((g) => g.items)
      .find((i) => i.to === '/schedules/preview');

  it('is visible to every manager role and to nobody else', () => {
    expect(link('ZONAL_MANAGER')).toBeDefined();
    expect(link('CENTRAL_SERVICE_MANAGER')).toBeDefined();
    expect(link('OPERATIONS_HEAD')).toBeDefined();
    expect(link('SERVICE_ENGINEER')).toBeUndefined();
    expect(link('WAREHOUSE_MANAGER')).toBeUndefined();
  });
});

describe('Scheduler Preview page (#251)', () => {
  it('renders the projected plan and the as-of caveat with the real watermark', async () => {
    fetchMock.mockImplementation(async () => json(PREVIEW));
    render(<SchedulerPreviewPage />);

    await waitFor(() => expect(screen.getByTestId('preview-se-list')).toBeInTheDocument());
    expect(screen.getByTestId(`preview-se-${SE}`)).toBeInTheDocument();
    expect(screen.getByTestId(`preview-ticket-${TICKET}`)).toBeInTheDocument();

    // AC-6 — the caveat states the watermark, not a placeholder, and says the run re-evaluates.
    const caveat = screen.getByTestId('buckets-as-of');
    expect(caveat.textContent).toMatch(/21 Jun 2026/);
    expect(caveat.textContent).toMatch(/re-evaluates at dispatch/i);
  });

  it('AC-4: a vehicle-return conflict asks before overwriting, and only confirms on demand', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/schedules/preview')) return json(PREVIEW);
      if (url.includes('/schedules/holds')) {
        const body = JSON.parse(String(init?.body ?? '{}'));
        return body.confirm === true
          ? json({ result: 'OK', ticketId: TICKET, heldUntil: '2026-06-23' })
          : json({ result: 'CONFLICT_VEHICLE_UNAVAILABLE', expectedFrom: '2026-06-25T00:00:00.000Z', reportId: '9' });
      }
      return json({});
    });
    render(<SchedulerPreviewPage />);
    await waitFor(() => expect(screen.getByTestId(`preview-ticket-${TICKET}`)).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Hold' }));

    const conflict = await screen.findByTestId('vu-conflict');
    expect(conflict.textContent).toMatch(/2026-06-25/);
    expect(conflict.textContent).toMatch(/would replace it/i);

    // The unconfirmed attempt must not have been treated as a hold.
    const holdCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('/schedules/holds'));
    expect(JSON.parse(String(holdCalls[0][1].body)).confirm).toBe(false);

    await userEvent.click(screen.getByRole('button', { name: 'Hold anyway' }));
    await waitFor(() => {
      const confirmed = fetchMock.mock.calls
        .filter(([u]) => String(u).includes('/schedules/holds'))
        .map(([, i]) => JSON.parse(String((i as RequestInit).body)));
      expect(confirmed.some((b) => b.confirm === true)).toBe(true);
    });
  });

  it('holds until the day AFTER the previewed date — the deferral predicate is inclusive', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/schedules/preview')) return json(PREVIEW);
      return json({ result: 'OK', ticketId: TICKET, heldUntil: '2026-06-23' });
    });
    render(<SchedulerPreviewPage />);
    await waitFor(() => expect(screen.getByTestId(`preview-ticket-${TICKET}`)).toBeInTheDocument());

    // The page defaults to tomorrow; set an explicit date so the assertion is about the arithmetic
    // rather than about whatever day the test happens to run on.
    const dateInput = screen.getByTestId('preview-date');
    await userEvent.clear(dateInput);
    await userEvent.type(dateInput, '2026-06-22');
    await waitFor(() => expect(screen.getByTestId(`preview-ticket-${TICKET}`)).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Hold' }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.filter(([u]) => String(u).includes('/schedules/holds')).pop();
      expect(JSON.parse(String(call![1].body)).heldUntil).toBe('2026-06-23');
    });
  });

  it('surfaces holds in force with a release action', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      json(
        url.includes('/schedules/preview')
          ? {
              ...PREVIEW,
              holds: [
                { ticketId: TICKET, heldUntil: '2026-06-24', zoneId: '1', plantName: 'Kotputli Works', deviceId: '900' },
              ],
            }
          : { result: 'OK', ticketId: TICKET },
      ),
    );
    render(<SchedulerPreviewPage />);

    const holds = await screen.findByTestId('preview-holds');
    expect(holds.textContent).toMatch(/Kotputli Works/);
    expect(holds.textContent).toMatch(/returns 2026-06-24/);

    await userEvent.click(screen.getByRole('button', { name: 'Release' }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/schedules/holds/release'))).toBe(true),
    );
  });

  it('refuses a hold on an already-dispatched ticket by pointing at the override path', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      json(
        url.includes('/schedules/preview')
          ? PREVIEW
          : { result: 'NOT_HOLDABLE', status: 'OPEN', assignmentState: 'FORMALLY_ASSIGNED' },
      ),
    );
    render(<SchedulerPreviewPage />);
    await waitFor(() => expect(screen.getByTestId(`preview-ticket-${TICKET}`)).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Hold' }));
    const notice = await screen.findByTestId('preview-notice');
    expect(notice.textContent).toMatch(/already on a day plan/i);
  });
});
