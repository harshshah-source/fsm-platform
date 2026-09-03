import type { SessionView } from '@fsm/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchChangesTodayView, DispatchTodayView } from '../src/api/dispatchToday';
import { AuthProvider } from '../src/auth/AuthProvider';
import TodaysDispatchPage from '../src/pages/dispatch/TodaysDispatchPage';

/**
 * **#295 — the Console became a dispatch board.**
 *
 * Three changes, and each one is a claim about what an operator can read off the screen:
 *
 * 1. **One engineer representation.** The People rail and the board's Engineer column rendered the
 *    same `engineers[]` array side by side; the rail is gone and its column absorbed what it carried
 *    — including the drop target that was added on 2026-08-31 because operators drag a device onto
 *    *the engineer's name*, not onto a cell out in the grid.
 * 2. **Work cards, not hashes.** `ticketId.slice(0, 8)` told a dispatcher nothing. The card names the
 *    device, the vehicle, the company, the transporter and how long the unit has been quiet.
 * 3. **A status a dispatcher can act on.** Green = somebody started. Red = untouched. Yellow =
 *    untouched too long. Decided on the server (`actionStatus`), rendered here.
 *
 * The pin that matters most across all three: **the existing colour channels survive**. #290 was a
 * whole slice spent separating crimson (critical SLA) from amber (capacity), and a new tri-state that
 * repainted either of them would undo it.
 */

vi.mock('../src/api/dispatchToday', async () => {
  const actual = await vi.importActual('../src/api/dispatchToday');
  return {
    ...actual,
    apiDispatchToday: vi.fn(),
    apiDispatchChangesToday: vi.fn(),
    apiDispatchCardSummaries: vi.fn(),
  };
});
vi.mock('../src/api/dispatch-runs', async () => {
  const actual = await vi.importActual('../src/api/dispatch-runs');
  return { ...actual, apiDispatchRunDecisions: vi.fn(), apiDispatchTicketTrace: vi.fn() };
});
vi.mock('../src/api/schedules', async () => {
  const actual = await vi.importActual('../src/api/schedules');
  return {
    ...actual,
    apiListSchedules: vi.fn(),
    apiZoneEngineers: vi.fn(),
    apiOverrideBatch: vi.fn(),
    apiOverridePreview: vi.fn(),
    apiAssignTicket: vi.fn(),
  };
});
vi.mock('../src/api/schedulerPreview', async () => {
  const actual = await vi.importActual('../src/api/schedulerPreview');
  return { ...actual, getSchedulerPreview: vi.fn() };
});
vi.mock('../src/api/dashboard', async () => {
  const actual = await vi.importActual('../src/api/dashboard');
  return { ...actual, apiActionRequired: vi.fn() };
});
vi.mock('../src/api/dispatchSchedule', async () => {
  const actual = await vi.importActual('../src/api/dispatchSchedule');
  return { ...actual, getDispatchInFlight: vi.fn(), getDispatchSchedule: vi.fn() };
});
vi.mock('../src/api/candidates', async () => {
  const actual = await vi.importActual('../src/api/candidates');
  return { ...actual, apiCandidates: vi.fn() };
});
vi.mock('../src/api/tickets', async () => {
  const actual = await vi.importActual('../src/api/tickets');
  return { ...actual, apiTicketDetail: vi.fn(), apiTicketAttempts: vi.fn() };
});
vi.mock('../src/api/org', async () => {
  const actual = await vi.importActual('../src/api/org');
  return { ...actual, listZones: vi.fn() };
});

const { apiDispatchToday, apiDispatchChangesToday, apiDispatchCardSummaries } = await import(
  '../src/api/dispatchToday'
);
const { apiDispatchRunDecisions, apiDispatchTicketTrace } = await import('../src/api/dispatch-runs');
const { apiListSchedules, apiZoneEngineers, apiOverrideBatch, apiOverridePreview } = await import(
  '../src/api/schedules'
);
const { getSchedulerPreview } = await import('../src/api/schedulerPreview');
const { apiActionRequired } = await import('../src/api/dashboard');
const { getDispatchInFlight, getDispatchSchedule } = await import('../src/api/dispatchSchedule');
const { apiCandidates } = await import('../src/api/candidates');
const { apiTicketDetail, apiTicketAttempts } = await import('../src/api/tickets');
const { listZones } = await import('../src/api/org');

const ZM: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 7, acted_as_role: null };

const TODAY = '2026-08-28';
const YESTERDAY = '2026-08-27';
const TOMORROW = '2026-08-29';
const STARTED = '11111111-2222-3333-4444-555555555555';
const UNTOUCHED = '22222222-3333-4444-5555-666666666666';
const AGED = '33333333-4444-5555-6666-777777777777';
const FUTURE_TICKET = '44444444-5555-6666-7777-888888888888';

const ticket = (id: string, over: Partial<DispatchTodayView['engineers'][0]['stops'][0]['tickets'][0]> = {}) => ({
  ticketId: id,
  sortOrder: 1,
  slaBucket: 'WARNING',
  companyTier: 'GOLD',
  addSource: 'AUTO_DISPATCH',
  addedBy: null,
  addReason: null,
  coverageTypeAtAssign: 'DEDICATED',
  systemPlaced: true,
  returnDueToday: false,
  failureCycles: null,
  deviceId: '869645080787056',
  vehicleNo: 'MH-12-AB-3456',
  companyName: 'Northbound Cement',
  transporterName: 'Sharma Logistics',
  inactivityHours: 18,
  assignedAt: `${TODAY}T05:30:00Z`,
  troubleshootingStarted: false,
  actionStatus: 'NOT_STARTED' as const,
  ...over,
});

const view = (over: Partial<DispatchTodayView> = {}): DispatchTodayView => ({
  operatingDay: TODAY,
  chronicThreshold: 3,
  agingThresholdHours: 4,
  zone: { zoneId: '7', name: 'North Zone' },
  run: { runId: '42', status: 'SUCCESS', trigger: 'CRON', startedAt: `${TODAY}T05:00:00Z`, finishedAt: null },
  recovery: null,
  engineers: [
    {
      seId: 'se-1',
      name: 'Ramesh Kulkarni',
      coverageType: 'DEDICATED',
      committed: 3,
      dailyCapacity: 8,
      overCapacity: false,
      availability: 'AVAILABLE',
      scheduleId: '9',
      scheduleStatus: 'ACTIVE',
      stops: [
        {
          batchId: 'b1',
          stopSequence: 1,
          plantId: '4',
          plantName: 'Acme Cement',
          status: 'AUTO_ASSIGNED',
          runId: '42',
          tickets: [
            ticket(STARTED, { troubleshootingStarted: true, actionStatus: 'IN_PROGRESS' }),
            ticket(UNTOUCHED, { sortOrder: 2, actionStatus: 'NOT_STARTED' }),
            ticket(AGED, { sortOrder: 3, actionStatus: 'AGING_UNTOUCHED', slaBucket: 'CRITICAL' }),
          ],
        },
      ],
    },
    // A FLOATING engineer with nothing on today — both facts have to survive: the third coverage
    // type is a real population, and an empty lane is a fact rather than an omission.
    {
      seId: 'se-2',
      name: 'Priya Mehta',
      coverageType: 'FLOATING',
      committed: 0,
      dailyCapacity: 6,
      overCapacity: false,
      availability: 'AVAILABLE',
      scheduleId: null,
      scheduleStatus: null,
      stops: [],
    },
  ],
  situation: {
    placed: 3,
    unassignable: 0,
    held: 0,
    criticalNeedsYou: 0,
    overCapacity: 0,
    changesToday: 0,
    componentBlockedWithheld: null,
    bucketlessDropped: null,
  },
  rails: { unassignable: [], held: [], policyWithheld: { count: 0, itemised: false } },
  escalations: [],
  ...over,
});

const changes = (): DispatchChangesTodayView => ({
  operatingDay: TODAY,
  zoneId: '7',
  counts: { adds: 0, removes: 0, swaps: 0, total: 0 },
  changes: [],
});

const dataTransfer = () => {
  const store: Record<string, string> = {};
  return {
    setData: (k: string, v: string) => {
      store[k] = v;
    },
    getData: (k: string) => store[k] ?? '',
    dropEffect: '',
    effectAllowed: '',
  };
};

const renderAt = (entry = `/dispatch/today?day=${TODAY}`) =>
  render(
    <AuthProvider initialSession={ZM}>
      <MemoryRouter initialEntries={[entry]}>
        <TodaysDispatchPage />
      </MemoryRouter>
    </AuthProvider>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(apiDispatchToday).mockResolvedValue(view());
  vi.mocked(apiDispatchChangesToday).mockResolvedValue(changes());
  vi.mocked(apiDispatchCardSummaries).mockResolvedValue([]);
  vi.mocked(apiListSchedules).mockResolvedValue([]);
  vi.mocked(getSchedulerPreview).mockResolvedValue({
    zoneId: '7',
    mode: 'PREVENTIVE',
    recommended: 0,
    unassignable: 0,
    withheldBelowThreshold: 0,
    bucketsAsOf: null,
    plan: [],
    decisions: [],
  } as never);
  vi.mocked(apiActionRequired).mockResolvedValue([]);
  vi.mocked(getDispatchInFlight).mockResolvedValue([]);
  vi.mocked(getDispatchSchedule).mockRejectedValue(new Error('403'));
  vi.mocked(apiCandidates).mockResolvedValue({ date: TODAY, plants: [] });
  vi.mocked(apiTicketDetail).mockResolvedValue({ lifecycle: [] } as never);
  vi.mocked(apiTicketAttempts).mockResolvedValue({
    ticketId: STARTED,
    threshold: 3,
    countableAttempts: 0,
    hasSubmission: false,
    isSpecial: false,
    attempts: [],
  });
  vi.mocked(apiDispatchRunDecisions).mockResolvedValue([] as never);
  vi.mocked(apiDispatchTicketTrace).mockRejectedValue(new Error('no trace'));
  vi.mocked(apiZoneEngineers).mockResolvedValue([
    { engineerId: 'se-1', name: 'Ramesh Kulkarni', coverageType: 'DEDICATED', zoneId: '7', committed: 3, dailyCapacity: 8, isActive: true },
    { engineerId: 'se-2', name: 'Priya Mehta', coverageType: 'FLOATING', zoneId: '7', committed: 0, dailyCapacity: 6, isActive: true },
  ] as never);
  vi.mocked(listZones).mockResolvedValue([{ zoneId: 7, name: 'North Zone' }] as never);
  vi.mocked(apiOverrideBatch).mockResolvedValue({} as never);
  vi.mocked(apiOverridePreview).mockRejectedValue(new Error('NOT_PROJECTABLE'));
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('#295 · the engineer column is the only engineer representation', () => {
  it('no longer renders a second roster beside the board', async () => {
    renderAt();
    await screen.findByTestId('console-board');

    expect(screen.queryByTestId('console-people-rail')).not.toBeInTheDocument();
    // One name, one place. The duplication was purely presentational — one array, one fetch — so
    // deleting the rail cannot desynchronise anything, and the assertion is simply that it is gone.
    expect(screen.getAllByText('Ramesh Kulkarni')).toHaveLength(1);
  });

  it('carries the identity the rail used to: avatar, name, load, coverage and workload', async () => {
    renderAt();
    const cell = await screen.findByTestId('lane-se-1');

    expect(within(cell).getByTestId('avatar-se-1')).toHaveTextContent('RK');
    expect(cell).toHaveTextContent('Ramesh Kulkarni');
    expect(within(cell).getByTestId('load-se-1')).toHaveTextContent('3/8');
    expect(cell).toHaveTextContent(/DEDICATED/i);
    expect(cell).toHaveTextContent(/1 stop · 3 devices/i);
  });

  /** Three coverage types, not two. FLOATING is a real population (territory-polygon SEs). */
  it('renders FLOATING as itself rather than folding it into another coverage type', async () => {
    renderAt();
    const cell = await screen.findByTestId('lane-se-2');

    expect(cell).toHaveTextContent(/FLOATING/i);
  });

  it('keeps an engineer with no work — an empty lane is a fact', async () => {
    renderAt();

    expect(await screen.findByTestId('lane-se-2')).toHaveTextContent('Priya Mehta');
    expect(screen.getByTestId('load-se-2')).toHaveTextContent('0/6');
  });

  it('still inspects the engineer when their row is clicked', async () => {
    const user = userEvent.setup();
    renderAt();

    await user.click(await screen.findByTestId('lane-se-2'));

    const inspector = await screen.findByTestId('console-inspector');
    expect(inspector).toHaveTextContent('Priya Mehta');
    expect(inspector).toHaveTextContent(/floating/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('#295 · the drop target the rail used to own', () => {
  /**
   * The regression this whole block exists to prevent. `PeopleRail` shipped inert and was made
   * droppable on 2026-08-31 because operators drag a device onto *the engineer's name in the list*.
   * Reported then as "I can't drag and drop a device"; deleting the rail without moving the handler
   * would file that ticket again.
   */
  it('a card dropped on an engineer’s row opens Reassign, seeded — as the board cell does', async () => {
    renderAt();
    const card = await screen.findByTestId(`chip-${STARTED}`);

    const dt = dataTransfer();
    fireEvent.dragStart(card, { dataTransfer: dt });
    fireEvent.drop(screen.getByTestId('lane-se-2'), { dataTransfer: dt });

    const select = await screen.findByTestId('action-target-se');
    await waitFor(() => expect(select).toHaveValue('se-2'));
    // Nothing is written on release — the dialog opens prefilled and the reason is still mandatory.
    expect(screen.getByTestId('action-confirm')).toBeDisabled();
    expect(apiOverrideBatch).not.toHaveBeenCalled();
  });

  it('the engineer who already holds it is not a target — refused, with nothing opened', async () => {
    renderAt();
    const card = await screen.findByTestId(`chip-${STARTED}`);

    const dt = dataTransfer();
    fireEvent.dragStart(card, { dataTransfer: dt });
    fireEvent.drop(screen.getByTestId('lane-se-1'), { dataTransfer: dt });

    await waitFor(() => expect(screen.queryByTestId('action-target-se')).not.toBeInTheDocument());
    expect(apiOverrideBatch).not.toHaveBeenCalled();
  });

  /** The cross-day gesture is unchanged: same payload, same predicate, both coordinates carried. */
  it('a card dragged onto a later day still opens Move with the date seeded', async () => {
    renderAt();
    const card = await screen.findByTestId(`chip-${STARTED}`);

    const dt = dataTransfer();
    fireEvent.dragStart(card, { dataTransfer: dt });
    fireEvent.drop(screen.getByTestId(`cell-se-1-${TOMORROW}`), { dataTransfer: dt });

    expect(await screen.findByTestId('move-date')).toHaveValue(TOMORROW);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('#295 · the work card', () => {
  it('names the physical things an operator reasons about', async () => {
    renderAt();
    const card = await screen.findByTestId(`chip-${STARTED}`);

    expect(card).toHaveTextContent('869645080787056');
    expect(card).toHaveTextContent('MH-12-AB-3456');
    expect(card).toHaveTextContent('Sharma Logistics');
    expect(card).toHaveTextContent(/18h/);
    // Company and plant were dropped on 2026-09-01 — see "the tiling correction" below.
  });

  /**
   * Null is "the device state has never been recomputed", which is not "silent for zero hours".
   * Drawing the second where the first is true tells a dispatcher the unit just reported in.
   */
  it('says nothing rather than “0h” when inactivity was never computed', async () => {
    vi.mocked(apiDispatchToday).mockResolvedValue(
      view({
        engineers: [
          {
            ...view().engineers[0],
            stops: [{ ...view().engineers[0].stops[0], tickets: [ticket(STARTED, { inactivityHours: null })] }],
          },
        ],
      }),
    );
    renderAt();

    const card = await screen.findByTestId(`chip-${STARTED}`);
    expect(card).not.toHaveTextContent(/0h/);
    expect(card).toHaveTextContent(/inactive\s*—/i);
  });

  it('keeps ticketId as the identity behind the card, whatever it displays', async () => {
    const user = userEvent.setup();
    renderAt();

    await user.click(await screen.findByTestId(`chip-${STARTED}`));

    expect(await screen.findByTestId('console-inspector')).toHaveTextContent(STARTED.slice(0, 8));
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('#295 · the action status channel', () => {
  it('reads the server’s verdict for each of the three states', async () => {
    renderAt();
    await screen.findByTestId('console-board');

    expect(screen.getByTestId(`action-status-${STARTED}`)).toHaveAttribute('data-action-status', 'IN_PROGRESS');
    expect(screen.getByTestId(`action-status-${UNTOUCHED}`)).toHaveAttribute('data-action-status', 'NOT_STARTED');
    expect(screen.getByTestId(`action-status-${AGED}`)).toHaveAttribute('data-action-status', 'AGING_UNTOUCHED');
  });

  /** Colour is never the only carrier — every state says its word, so it survives grayscale. */
  it('says each state in words, not in hue alone', async () => {
    renderAt();
    await screen.findByTestId('console-board');

    expect(screen.getByTestId(`action-status-${STARTED}`)).toHaveTextContent(/started/i);
    expect(screen.getByTestId(`action-status-${UNTOUCHED}`)).toHaveTextContent(/untouched/i);
    expect(screen.getByTestId(`action-status-${AGED}`)).toHaveTextContent(/aged/i);
  });

  /** The threshold is quoted from the payload, so the sentence cannot drift from the rule. */
  it('explains aged using the published threshold rather than a number of its own', async () => {
    renderAt();
    await screen.findByTestId('console-board');

    expect(screen.getByTestId(`action-status-${AGED}`).getAttribute('title')).toMatch(/4/);
  });

  /**
   * **A payload without the field must not take the page down.**
   *
   * `actionStatus` arrives over the network, so the client cannot assume it is one of the three it
   * knows: an admin build deployed ahead of its backend gets a payload with no `actionStatus` at all,
   * which is exactly the state this board was first opened in. Looking the value up in a lookup table
   * and dereferencing the result crashed every card on the board, and with it the whole page.
   *
   * The honest fallback is the one the provenance grammar already uses for an unrecorded fact: say
   * nothing. No rail, no word — never a guessed state, and never a blank screen. The rest of the card
   * is real data and still renders.
   */
  it('renders the card without a status when the payload has none, rather than crashing', async () => {
    vi.mocked(apiDispatchToday).mockResolvedValue(
      view({
        engineers: [
          {
            ...view().engineers[0],
            stops: [
              {
                ...view().engineers[0].stops[0],
                // An older backend: the field is simply not on the wire.
                tickets: [ticket(STARTED, { actionStatus: undefined as never })],
              },
            ],
          },
        ],
      }),
    );
    renderAt();

    const card = await screen.findByTestId(`chip-${STARTED}`);
    expect(card).toHaveTextContent('869645080787056');
    expect(card).toHaveTextContent('MH-12-AB-3456');
    // No fabricated verdict.
    expect(screen.queryByTestId(`action-status-${STARTED}`)).not.toBeInTheDocument();
  });

  /** The same skew leaves the threshold undefined; the sentence must not read "undefinedh". */
  it('does not quote a threshold it was never given', async () => {
    vi.mocked(apiDispatchToday).mockResolvedValue(
      view({ agingThresholdHours: undefined as never }),
    );
    renderAt();

    const status = await screen.findByTestId(`action-status-${UNTOUCHED}`);
    expect(status.getAttribute('title')).not.toMatch(/undefined/);
  });

  /**
   * #290 spent a whole slice separating crimson (critical work) from amber (capacity). A tri-state
   * that repainted either would undo it, so the existing channels are asserted alive on the same
   * cards the new one is drawn on.
   */
  it('leaves the existing channels intact — CRIT still travels with the ticket', async () => {
    renderAt();

    expect(await screen.findByTestId(`crit-${AGED}`)).toHaveTextContent('CRIT');
    expect(screen.getByTestId(`chip-${STARTED}`)).toHaveAttribute('data-provenance', 'AUTO_DISPATCH');
  });

  it('never labels a ticket ADJUSTED — that is a fact about the stop', async () => {
    vi.mocked(apiDispatchToday).mockResolvedValue(
      view({
        engineers: [
          {
            ...view().engineers[0],
            stops: [{ ...view().engineers[0].stops[0], status: 'OVERRIDDEN' }],
          },
        ],
      }),
    );
    renderAt();

    // The badge belongs to the stop header…
    expect(await screen.findByText(/adjusted/i)).toBeInTheDocument();
    // …and to no card on it.
    for (const id of [STARTED, UNTOUCHED, AGED]) {
      expect(screen.getByTestId(`chip-${id}`)).not.toHaveTextContent(/adjusted/i);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('#295 · each column at the fidelity its source can answer', () => {
  it('a past column stays counts — history is not re-enriched with today’s live facts', async () => {
    vi.mocked(apiListSchedules).mockResolvedValue([
      { scheduleId: '1', seId: 'se-1', zoneId: '7', dateFrom: YESTERDAY, dateTo: YESTERDAY, status: 'ACTIVE', batchCount: 2, ticketCount: 9 },
    ] as never);
    renderAt(`/dispatch/today?day=${YESTERDAY}`);

    const cell = await screen.findByTestId(`cell-se-1-${YESTERDAY}`);
    await waitFor(() => expect(cell).toHaveTextContent(/2 stops · 9 devices/));
    expect(apiDispatchCardSummaries).not.toHaveBeenCalled();
  });

  /**
   * A committed future column knows its ticket ids and nothing physical, so it asks **once** for all
   * of them. One request per card would be the N+1 the whole design avoids on today's column.
   */
  it('a focused committed future column enriches its cards in one batched request', async () => {
    vi.mocked(apiListSchedules).mockResolvedValue([
      {
        scheduleId: '2',
        seId: 'se-1',
        zoneId: '7',
        dateFrom: TOMORROW,
        dateTo: TOMORROW,
        status: 'ACTIVE',
        batchCount: 1,
        ticketCount: 1,
        stops: [
          {
            batchId: 'b9',
            stopSequence: 1,
            plantId: '4',
            plantName: 'Acme Cement',
            status: 'AUTO_ASSIGNED',
            tickets: [{ ticketId: FUTURE_TICKET, sortOrder: 1, addSource: 'MANUAL_DAY_MOVE', addedBy: 'zm1', coverageTypeAtAssign: 'DEDICATED', systemPlaced: false }],
          },
        ],
      },
    ] as never);
    vi.mocked(apiDispatchCardSummaries).mockResolvedValue([
      {
        ticketId: FUTURE_TICKET,
        deviceId: '869645080755293',
        vehicleNo: 'MH-14-ZZ-9999',
        companyName: 'Southbound Cement',
        transporterName: 'Rao Transport',
        inactivityHours: 30,
      },
    ]);
    renderAt(`/dispatch/today?day=${TOMORROW}`);

    const cell = await screen.findByTestId(`cell-se-1-${TOMORROW}`);
    await waitFor(() => expect(cell).toHaveTextContent('869645080755293'));
    expect(cell).toHaveTextContent('MH-14-ZZ-9999');
    expect(apiDispatchCardSummaries).toHaveBeenCalledTimes(1);
    expect(apiDispatchCardSummaries).toHaveBeenCalledWith([FUTURE_TICKET], '7');

    /**
     * No status rail on a day that has not happened. Nobody has started work whose day has not
     * begun, and "untouched for six hours" said about tomorrow is a category error, not a fact.
     */
    expect(within(cell).queryByTestId(`action-status-${FUTURE_TICKET}`)).not.toBeInTheDocument();
  });

  /**
   * **The ordinary way an operator reaches tomorrow is by clicking it**, not by deep-linking to it.
   *
   * The counts for a context column are fetched once and cached per `(zone, version, day)`, so by the
   * time the operator focuses that day its rows are already in hand and the request is not re-issued.
   * The enrichment has to hang off *focus*, not off the counts arriving — otherwise the column an
   * operator navigated to shows compact chips for ever, while the same column reached by URL shows
   * cards, which is the same screen disagreeing with itself about what it knows.
   */
  it('enriches a future column when the operator focuses it, not only when deep-linked to it', async () => {
    const user = userEvent.setup();
    vi.mocked(apiListSchedules).mockResolvedValue([
      {
        scheduleId: '2',
        seId: 'se-1',
        zoneId: '7',
        dateFrom: TOMORROW,
        dateTo: TOMORROW,
        status: 'ACTIVE',
        batchCount: 1,
        ticketCount: 1,
        stops: [
          {
            batchId: 'b9',
            stopSequence: 1,
            plantId: '4',
            plantName: 'Acme Cement',
            status: 'AUTO_ASSIGNED',
            tickets: [{ ticketId: FUTURE_TICKET, sortOrder: 1, addSource: 'AUTO_DISPATCH', addedBy: null, coverageTypeAtAssign: 'DEDICATED', systemPlaced: true }],
          },
        ],
      },
    ] as never);
    vi.mocked(apiDispatchCardSummaries).mockResolvedValue([
      {
        ticketId: FUTURE_TICKET,
        deviceId: '869645080755293',
        vehicleNo: 'MH-14-ZZ-9999',
        companyName: 'Southbound Cement',
        transporterName: 'Rao Transport',
        inactivityHours: 30,
      },
    ]);

    // Open on today. Tomorrow is a context column: its counts load, its cards are not enriched.
    renderAt(`/dispatch/today?day=${TODAY}`);
    await screen.findByTestId('console-board');
    await waitFor(() => expect(apiListSchedules).toHaveBeenCalledWith(TOMORROW, 'stops'));
    expect(apiDispatchCardSummaries).not.toHaveBeenCalled();

    // …now click the day. The counts are already cached, so nothing refetches them.
    await user.click(screen.getByTestId(`day-focus-${TOMORROW}`));

    await waitFor(() => expect(apiDispatchCardSummaries).toHaveBeenCalledWith([FUTURE_TICKET], '7'));
    const cell = await screen.findByTestId(`cell-se-1-${TOMORROW}`);
    await waitFor(() => expect(cell).toHaveTextContent('869645080755293'));
  });

  it('degrades to the compact committed chip when the enrichment cannot be read', async () => {
    vi.mocked(apiListSchedules).mockResolvedValue([
      {
        scheduleId: '2',
        seId: 'se-1',
        zoneId: '7',
        dateFrom: TOMORROW,
        dateTo: TOMORROW,
        status: 'ACTIVE',
        batchCount: 1,
        ticketCount: 1,
        stops: [
          {
            batchId: 'b9',
            stopSequence: 1,
            plantId: '4',
            plantName: 'Acme Cement',
            status: 'AUTO_ASSIGNED',
            tickets: [{ ticketId: FUTURE_TICKET, sortOrder: 1, addSource: 'AUTO_DISPATCH', addedBy: null, coverageTypeAtAssign: 'DEDICATED', systemPlaced: true }],
          },
        ],
      },
    ] as never);
    vi.mocked(apiDispatchCardSummaries).mockRejectedValue(new Error('REQUEST_FAILED_500'));
    renderAt(`/dispatch/today?day=${TOMORROW}`);

    // The work is still drawn — reduced, never blank rows under a full card frame.
    expect(await screen.findByTestId(`committed-${FUTURE_TICKET}`)).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * **#295b — the density correction** (operator, 2026-09-01).
 *
 * The board shipped legible and *loose*: a personnel column nearly 18rem wide holding one horizontal
 * line of text, and work cards that stacked five facts down the page. On a real zone — fifteen
 * engineers, a hundred devices — that is a screen the operator scrolls instead of reads.
 *
 * Three corrections, each one asserted here rather than left to the eye:
 *
 * 1. **The personnel column becomes a card**, read top-to-bottom — avatar, name, workload, tags — and
 *    gives the width it was hoarding back to the day columns.
 * 2. **The work card becomes a block**: the operational fields in two columns, labelled, with the
 *    plant it is at, and the opaque hash demoted to a fallback for a device the read could not name.
 * 3. **The action status becomes a fill.** The 3px rail was the whole of the traffic light, and at
 *    board scale nobody saw it. The card is now tinted, which is the position `index.css` reserves
 *    for this channel — the cell keeps capacity, the border keeps provenance.
 */
describe('#295b · the density correction', () => {
  /** The width the personnel column gives back is the whole point of stacking it. */
  it('gives the day columns their width back — the personnel column is compact', async () => {
    renderAt();
    const grid = (await screen.findByTestId('console-board')).querySelector('div.grid') as HTMLElement;

    const first = /^minmax\(([\d.]+)rem,\s*([\d.]+)rem\)/.exec(grid.style.gridTemplateColumns);
    expect(first).not.toBeNull();
    expect(Number(first![2])).toBeLessThanOrEqual(11);
  });

  /** The avatar is the primary identity element on that column, so it has to be seen. */
  it('draws the engineer’s avatar large enough to be the identity anchor', async () => {
    renderAt();
    const avatar = await screen.findByTestId('avatar-se-1');

    expect(avatar.className).toMatch(/\bh-1[0-2]\b/);
    expect(avatar).toHaveTextContent('RK');
  });

  /** Avatar → name → workload → tags. Nothing the old horizontal row carried may be dropped. */
  it('stacks the personnel column top-to-bottom without losing what it carried', async () => {
    renderAt();
    const cell = await screen.findByTestId('lane-se-1');

    expect(cell.className).toMatch(/flex-col/);
    expect(cell).toHaveTextContent('Ramesh Kulkarni');
    expect(within(cell).getByTestId('load-se-1')).toHaveTextContent('3/8');
    expect(cell).toHaveTextContent(/DEDICATED/i);
    expect(cell).toHaveTextContent(/1 stop · 3 devices/i);
  });

  /**
   * **The plant and the company came off the card** (operator, 2026-09-01, second pass).
   *
   * Both were repeated on every card in a cell — the plant is already the stop header the cards sit
   * under, and every ticket at a plant belongs to the same handful of companies, so the two columns
   * printed the same two strings eight times over and paid for it in width. A card is now the three
   * facts that actually differ ticket to ticket. Neither fact is lost: the stop names the plant above
   * the cards, and the Inspector names the company when you open one.
   */
  it('does not repeat the plant or the company on every card', async () => {
    renderAt();
    const card = await screen.findByTestId(`chip-${STARTED}`);

    expect(card).not.toHaveTextContent('Acme Cement');
    expect(card).not.toHaveTextContent('Northbound Cement');
    // The stop above the cards still names the plant — it was never the card's job.
    expect(await screen.findByTestId('stop-b1')).toHaveTextContent('Acme Cement');
  });

  /** Labelled fields, so a value is never guessed at from its shape. */
  it('labels the operational fields on the card', async () => {
    renderAt();
    const card = await screen.findByTestId(`chip-${STARTED}`);

    for (const label of ['Device', 'Vehicle']) {
      expect(within(card).getByText(label)).toBeInTheDocument();
    }
    for (const gone of ['Plant', 'Company']) {
      expect(within(card).queryByText(gone)).not.toBeInTheDocument();
    }
    expect(card).toHaveTextContent('869645080787056');
    expect(card).toHaveTextContent('MH-12-AB-3456');
    // The transporter is drawn without its label — the row it shares with the inactivity clock cannot
    // afford 42px of the word "TRANSPORTER" and still show a name. The tooltip names the field.
    expect(within(card).getByTitle('Transporter: Sharma Logistics')).toHaveTextContent('Sharma Logistics');
  });

  /**
   * **A cell tiles its cards.** One card per row made a fifteen-device stop a scroll; the cards are
   * now narrow enough to sit side by side, and the cell fits as many across as it has room for.
   * `auto-fill` rather than a fixed count: the same cell is ~260px wide on the focused column of a
   * laptop and half a screen wide on a monitor, and a hard `grid-cols-2` would be wrong at both.
   */
  it('tiles the cards across the cell instead of stacking one per row', async () => {
    renderAt();
    const card = await screen.findByTestId(`chip-${STARTED}`);
    const tray = card.parentElement!;

    expect(tray.className.split(' ')).toContain('grid');
    expect(tray.className).toMatch(/auto-fill/);
    // All three of the stop's cards live in the one tray — they tile, they do not nest.
    expect(within(tray).getAllByTestId(/^chip-/)).toHaveLength(3);
  });

  /** The identity fields lead; the hash is not the headline any more. */
  it('does not lead with the opaque ticket hash when the device is known', async () => {
    renderAt();

    expect(await screen.findByTestId(`chip-${STARTED}`)).not.toHaveTextContent(STARTED.slice(0, 8));
  });

  /** …but a card whose device the read could not name still says something rather than nothing. */
  it('falls back to the ticket hash only when there is no device to name', async () => {
    vi.mocked(apiDispatchToday).mockResolvedValue(
      view({
        engineers: [
          {
            ...view().engineers[0],
            stops: [{ ...view().engineers[0].stops[0], tickets: [ticket(STARTED, { deviceId: null })] }],
          },
        ],
      }),
    );
    renderAt();

    expect(await screen.findByTestId(`chip-${STARTED}`)).toHaveTextContent(STARTED.slice(0, 8));
  });

  /**
   * **The traffic light is a fill, not a hairline.** A 3px rail on a card in a hundred-card board is
   * a signal only to a reader who already knows where to look.
   */
  it('tints the whole card with its action status, not just a rail', async () => {
    renderAt();
    await screen.findByTestId('console-board');

    expect(screen.getByTestId(`chip-${STARTED}`).className).toMatch(/bg-action-started-bg/);
    expect(screen.getByTestId(`chip-${UNTOUCHED}`).className).toMatch(/bg-action-untouched-bg/);
    expect(screen.getByTestId(`chip-${AGED}`).className).toMatch(/bg-action-untouched-bg/);
  });

  /**
   * **Two colours, not three** (operator ruling, 2026-09-01). The light answers one question — is
   * anybody on this? — so it gets two hues: green where troubleshooting has begun, red everywhere it
   * has not. Aged work is not a third answer; it is untouched work with a clock on it, and the clock
   * is carried by the *word*. The yellow is gone, and with it the third hue that was competing with
   * the amber over-capacity cell the cards sit on.
   */
  it('paints untouched and aged the same red, and no card yellow', async () => {
    renderAt();
    await screen.findByTestId('console-board');

    const aged = screen.getByTestId(`chip-${AGED}`);
    const untouched = screen.getByTestId(`chip-${UNTOUCHED}`);
    // Aged is untouched work: same fill, same rail, same foreground.
    expect(aged.className).toMatch(/bg-action-untouched-bg/);
    expect(untouched.className).toMatch(/bg-action-untouched-bg/);
    // No card carries the retired yellow — not as a fill, a rail or a word.
    for (const chip of [aged, untouched, screen.getByTestId(`chip-${STARTED}`)]) {
      expect(chip.outerHTML).not.toMatch(/action-aged/);
    }
    // …and the word is what still tells the two red states apart, so it must survive.
    expect(aged).toHaveTextContent(/Aged/);
    expect(untouched).toHaveTextContent(/Untouched/);
    expect(screen.getByTestId(`chip-${STARTED}`)).toHaveTextContent(/Started/);
  });

  /** No verdict on the wire, no fill — an unknown state is drawn as unknown, as it always was. */
  it('leaves the card untinted when the payload carries no verdict', async () => {
    vi.mocked(apiDispatchToday).mockResolvedValue(
      view({
        engineers: [
          {
            ...view().engineers[0],
            stops: [
              {
                ...view().engineers[0].stops[0],
                tickets: [ticket(STARTED, { actionStatus: undefined as never })],
              },
            ],
          },
        ],
      }),
    );
    renderAt();

    expect((await screen.findByTestId(`chip-${STARTED}`)).className).not.toMatch(/bg-action-/);
  });

  /** A long transporter is truncated on the face and kept whole in the tooltip. */
  it('keeps a long transporter name from stretching the card', async () => {
    vi.mocked(apiDispatchToday).mockResolvedValue(
      view({
        engineers: [
          {
            ...view().engineers[0],
            stops: [
              {
                ...view().engineers[0].stops[0],
                tickets: [ticket(STARTED, { transporterName: 'RIMJHIM TRANSPORT COMPANY PRIVATE LIMITED' })],
              },
            ],
          },
        ],
      }),
    );
    renderAt();

    const card = await screen.findByTestId(`chip-${STARTED}`);
    const value = within(card).getByTitle('Transporter: RIMJHIM TRANSPORT COMPANY PRIVATE LIMITED');
    expect(value.className).toMatch(/truncate/);
  });
  /** A committed future card drops the plant for the same reason today's does. */
  it('does not repeat the plant on a committed future card either', async () => {
    vi.mocked(apiListSchedules).mockResolvedValue([
      {
        scheduleId: '2',
        seId: 'se-1',
        zoneId: '7',
        dateFrom: TOMORROW,
        dateTo: TOMORROW,
        status: 'ACTIVE',
        batchCount: 1,
        ticketCount: 1,
        stops: [
          {
            batchId: 'b9',
            stopSequence: 1,
            plantId: '4',
            plantName: 'Bramhaputra Cement',
            status: 'AUTO_ASSIGNED',
            tickets: [{ ticketId: FUTURE_TICKET, sortOrder: 1, addSource: 'AUTO_DISPATCH', addedBy: null, coverageTypeAtAssign: 'DEDICATED', systemPlaced: true }],
          },
        ],
      },
    ] as never);
    vi.mocked(apiDispatchCardSummaries).mockResolvedValue([
      {
        ticketId: FUTURE_TICKET,
        deviceId: '869645080755293',
        vehicleNo: 'MH-14-ZZ-9999',
        companyName: 'Southbound Cement',
        transporterName: 'Rao Transport',
        inactivityHours: 30,
      },
    ]);
    renderAt(`/dispatch/today?day=${TOMORROW}`);

    const card = await screen.findByTestId(`chip-${FUTURE_TICKET}`);
    // Same rule as today's column: the stop names the plant, the card names the unit.
    expect(card).not.toHaveTextContent('Bramhaputra Cement');
    expect(card).toHaveTextContent('869645080755293');
    // Still no verdict on a day that has not begun, and so no tint either.
    expect(card.className).not.toMatch(/bg-action-/);
  });
});
