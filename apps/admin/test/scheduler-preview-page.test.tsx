import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
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

const ENGINEERS = [
  { engineerId: SE, name: 'Ramesh Kumar', coverageType: 'DEDICATED', zoneId: '1', committed: 1, dailyCapacity: 6, isActive: true },
];
const PLANTS = [{ plantId: '7', name: 'ACP-9106', zoneId: '1' }];
const ZONE_MODES = [{ zoneId: '1', zoneName: 'Rajasthan North', mode: 'DEFICIT', silentCount: 4, eligibleCount: 40 }];

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const fetchMock = vi.fn();

/**
 * #281 — the page links out now (AC8/AC10), so it needs a router. Route the name lookups explicitly:
 * they are separate, best-effort reads and a catch-all mock would hand each of them the preview body.
 */
function renderPage(entry = '/schedules/preview') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <SchedulerPreviewPage />
    </MemoryRouter>,
  );
}

/** Wrap a preview-only mock so the three lookup reads answer with their own payloads. */
function withLookups(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  return async (url: string, init?: RequestInit) => {
    if (url.includes('/schedules/engineers')) return json(ENGINEERS);
    if (url.includes('/planner/plants')) return json(PLANTS);
    if (url.includes('/dashboard/operating-mode')) return json(ZONE_MODES);
    return handler(url, init);
  };
}

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
    fetchMock.mockImplementation(withLookups(async () => json(PREVIEW)));
    renderPage();

    await waitFor(() => expect(screen.getByTestId('preview-se-list')).toBeInTheDocument());
    expect(screen.getByTestId(`preview-se-${SE}`)).toBeInTheDocument();
    expect(screen.getByTestId(`preview-ticket-${TICKET}`)).toBeInTheDocument();

    // AC-6 — the caveat states the watermark, not a placeholder, and says the run re-evaluates.
    const caveat = screen.getByTestId('buckets-as-of');
    expect(caveat.textContent).toMatch(/21 Jun 2026/);
    expect(caveat.textContent).toMatch(/re-evaluates at dispatch/i);
  });

  it('AC-4: a vehicle-return conflict asks before overwriting, and only confirms on demand', async () => {
    fetchMock.mockImplementation(withLookups(async (url: string, init?: RequestInit) => {
      if (url.includes('/schedules/preview')) return json(PREVIEW);
      if (url.includes('/schedules/holds')) {
        const body = JSON.parse(String(init?.body ?? '{}'));
        return body.confirm === true
          ? json({ result: 'OK', ticketId: TICKET, heldUntil: '2026-06-23' })
          : json({ result: 'CONFLICT_VEHICLE_UNAVAILABLE', expectedFrom: '2026-06-25T00:00:00.000Z', reportId: '9' });
      }
      return json({});
    }));
    renderPage();
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
    fetchMock.mockImplementation(withLookups(async (url: string) => {
      if (url.includes('/schedules/preview')) return json(PREVIEW);
      return json({ result: 'OK', ticketId: TICKET, heldUntil: '2026-06-23' });
    }));
    renderPage();
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
    fetchMock.mockImplementation(
      withLookups(async (url: string) =>
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
      ),
    );
    renderPage();

    const holds = await screen.findByTestId('preview-holds');
    expect(holds.textContent).toMatch(/Kotputli Works/);
    expect(holds.textContent).toMatch(/returns 2026-06-24/);

    await userEvent.click(screen.getByRole('button', { name: 'Release' }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/schedules/holds/release'))).toBe(true),
    );
  });

  it('refuses a hold on an already-dispatched ticket by pointing at the override path', async () => {
    fetchMock.mockImplementation(
      withLookups(async (url: string) =>
        json(
          url.includes('/schedules/preview')
            ? PREVIEW
            : { result: 'NOT_HOLDABLE', status: 'OPEN', assignmentState: 'FORMALLY_ASSIGNED' },
        ),
      ),
    );
    renderPage();
    await waitFor(() => expect(screen.getByTestId(`preview-ticket-${TICKET}`)).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Hold' }));
    const notice = await screen.findByTestId('preview-notice');
    expect(notice.textContent).toMatch(/already on a day plan/i);
  });
});

/**
 * #281 AC10 (audit §2.5 D2) — the screen whose entire purpose is letting a human read a plan was
 * rendering `row.seId.slice(0, 8)`, `Plant {stop.plantId}` and `Zone {zoneId}`: three internal keys
 * and not one name. It used `formatPlantDisplayName` zero times. This is the same defect #277 fixed
 * on `PlannerPage`, still live one page away.
 */
describe('#281 AC10 — Scheduler Preview reads in names, not ids', () => {
  beforeEach(() => {
    fetchMock.mockImplementation(withLookups(async () => json(PREVIEW)));
  });

  it('shows the engineer by name in the rail and in the detail panel', async () => {
    renderPage();
    const rail = within(await screen.findByTestId('preview-se-list'));
    expect(rail.getByText('Ramesh Kumar')).toBeInTheDocument();
    expect(rail.queryByText(SE.slice(0, 8))).toBeNull();

    const detail = within(screen.getByTestId('preview-detail'));
    expect(detail.getByText('Ramesh Kumar')).toBeInTheDocument();
  });

  it('shows the plant and zone by name, and the operating mode in plain language', async () => {
    renderPage();
    const detail = within(await screen.findByTestId('preview-detail'));
    // `formatPlantDisplayName` — the mapped name with the AutoPlant code preserved in parentheses.
    expect(detail.getByText(/ARASMETA CEMENT PLANT \(ACP-9106\)/)).toBeInTheDocument();
    expect(detail.queryByText('Plant 7')).toBeNull();
    expect(detail.getByText(/Rajasthan North/)).toBeInTheDocument();
    // Issue 136's vocabulary rule: the engine enum is never rendered raw.
    expect(detail.queryByText(/DEFICIT/)).toBeNull();
    expect(detail.getByText(/Catch-up/)).toBeInTheDocument();
  });

  it('falls back to the id without crashing when a name lookup returns nothing (#277 pattern)', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/schedules/preview')) return json(PREVIEW);
      // Every lookup fails — the projection is the primary content and must still render.
      return new Response('nope', { status: 500 });
    });
    renderPage();

    const rail = within(await screen.findByTestId('preview-se-list'));
    expect(rail.getByText(SE.slice(0, 8))).toBeInTheDocument();
    expect(screen.getByTestId(`preview-ticket-${TICKET}`)).toBeInTheDocument();
  });

  it('opens a projected ticket by its real id rather than showing a truncated uuid alone', async () => {
    renderPage();
    const row = within(await screen.findByTestId(`preview-ticket-${TICKET}`));
    const link = row.getByRole('link', { name: new RegExp(TICKET) });
    expect(link).toHaveAttribute('href', `/tickets/${TICKET}`);
  });
});

/**
 * #281 AC8 / #280 R8 — contextual, per-record cross-view movement. Not a switcher and not a tab
 * strip: where this view renders a specific SE, it offers that SE's record on the sibling view, and
 * the link says which question it moves to.
 */
describe('#281 AC8 — Preview links to the committed plan for the same SE', () => {
  beforeEach(() => {
    fetchMock.mockImplementation(withLookups(async () => json(PREVIEW)));
  });

  it('offers the selected SE their committed day plan, labelled with the question it answers', async () => {
    renderPage();
    const detail = within(await screen.findByTestId('preview-detail'));
    const link = detail.getByTestId('preview-to-schedule');
    expect(link.querySelector('a')).toHaveAttribute('href', `/schedules/${SE}`);
    expect(link.textContent).toMatch(/committed/i);
  });

  it('AC3: never presents the projection as a commitment', async () => {
    renderPage();
    const note = await screen.findByTestId('dispatch-timeline-note');
    expect(note.textContent).toMatch(/would/i);
    expect(note.textContent).toMatch(/not committed|nothing here is committed/i);
  });

  it('accepts a date and SE from the URL so a sibling view can link INTO a specific projection', async () => {
    renderPage(`/schedules/preview?date=2026-06-22&se=${SE}`);
    await waitFor(() => expect(screen.getByTestId('preview-date')).toHaveValue('2026-06-22'));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes('date=2026-06-22'))).toBe(true),
    );
    const detail = within(screen.getByTestId('preview-detail'));
    expect(detail.getByText('Ramesh Kumar')).toBeInTheDocument();
  });
});
