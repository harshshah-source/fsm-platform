import type { SessionView } from '@fsm/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchChangesTodayView, DispatchTodayView } from '../src/api/dispatchToday';
import { AuthProvider } from '../src/auth/AuthProvider';
import TodaysDispatchPage from '../src/pages/dispatch/TodaysDispatchPage';

/**
 * **Scheduler Console — the composition correction**
 * (`docs/audits/scheduler-console-ui-composition-correction.md`, approved 2026-08-28).
 *
 * The Phase 1–4 build was rejected on composition — "the board is a column, not a canvas; the day
 * axis does not exist" — and rebuilt as an ENGINEER × DAY board between two rails, with the
 * Plan/Live/Replay mode nav dissolved into date navigation. These tests pin the rules that made the
 * correction a correction rather than a restyle:
 *
 * - **D9** — the Console is date-navigable, but each day answers from the source that can honestly
 *   answer for it, and `GET /dispatch/today` is *never* given a date.
 * - **D10** — drag initiates the authoritative dialog, prefilled; it never commits on release.
 * - **D11** — urgency is an inline token that travels with the ticket whoever assigned it, so the
 *   border can carry provenance alone.
 * - The right rail is one slot with two occupants; the Inspector is contextual, not a placeholder.
 */

vi.mock('../src/api/dispatchToday', async () => {
  const actual = await vi.importActual('../src/api/dispatchToday');
  return { ...actual, apiDispatchToday: vi.fn(), apiDispatchChangesToday: vi.fn() };
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

const { apiDispatchToday, apiDispatchChangesToday } = await import('../src/api/dispatchToday');
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
const SYS_TICKET = '11111111-2222-3333-4444-555555555555';
const HUMAN_CRIT = '22222222-3333-4444-5555-666666666666';
const POOLED = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const GHOST = 'ffffffff-1111-2222-3333-444444444444';

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
  assignedAt: '2026-08-28T05:30:00Z',
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
      name: 'Ramesh K.',
      coverageType: 'DEDICATED',
      committed: 2,
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
            ticket(SYS_TICKET),
            // Critical work a HUMAN assigned — the D11 case: the old grammar's crimson border was
            // reachable only on the systemPlaced branch, so this chip carried no urgency mark.
            ticket(HUMAN_CRIT, {
              slaBucket: 'CRITICAL',
              addSource: 'MANUAL_ASSIGN',
              addedBy: 'csm1',
              systemPlaced: false,
            }),
          ],
        },
      ],
    },
    {
      seId: 'se-2',
      name: 'Priya M.',
      coverageType: 'FLOATING',
      committed: 0,
      dailyCapacity: 8,
      overCapacity: false,
      availability: 'AVAILABLE',
      scheduleId: null,
      scheduleStatus: null,
      stops: [],
    },
  ],
  situation: {
    placed: 2,
    unassignable: 1,
    held: 0,
    criticalNeedsYou: 0,
    overCapacity: 0,
    changesToday: 0,
    componentBlockedWithheld: null,
    bucketlessDropped: null,
  },
  rails: {
    unassignable: [
      { ticketId: POOLED, deviceId: 'DEV-9', plantId: '5', plantName: 'Beta Works', poolEmptyReason: 'NO_COVERAGE', failureCycles: null },
    ],
    held: [],
    policyWithheld: { count: 0, itemised: false },
  },
  escalations: [],
  ...over,
});

const changes = (): DispatchChangesTodayView => ({
  operatingDay: TODAY,
  zoneId: '7',
  counts: { adds: 0, removes: 0, swaps: 0, total: 0 },
  changes: [],
});

const scheduleRow = (
  seId: string,
  date: string,
  batchCount: number,
  ticketCount: number,
  /** The stops a `detail=stops` read returns. Omitted = a row that carries counts only. */
  stops?: {
    batchId: string;
    stopSequence: number;
    plantId: string;
    plantName: string;
    status: string;
    tickets: {
      ticketId: string;
      sortOrder: number;
      addSource: string | null;
      addedBy: string | null;
      coverageTypeAtAssign: string | null;
      systemPlaced: boolean;
    }[];
  }[],
) => ({
  scheduleId: `s-${seId}-${date}`,
  seId,
  seName: null,
  zoneId: '7',
  zoneName: 'North Zone',
  dateFrom: date,
  dateTo: date,
  status: 'COMPLETED',
  batchCount,
  ticketCount,
  ...(stops ? { stops } : {}),
});

/** One moved ticket, as the target day's committed read reports it back. */
const movedStop = (ticketId: string) => ({
  batchId: 'b-moved',
  stopSequence: 1,
  plantId: '4',
  plantName: 'Acme Cement',
  status: 'OVERRIDDEN',
  tickets: [
    {
      ticketId,
      sortOrder: 1,
      addSource: 'MANUAL_DAY_MOVE',
      addedBy: 'zm1',
      coverageTypeAtAssign: 'DEDICATED',
      systemPlaced: false,
    },
  ],
});

const projection = (targetDate: string) => ({
  targetDate,
  zones: [
    {
      zoneId: '7',
      targetDate,
      bucketsAsOf: `${TODAY}T04:00:00Z`,
      mode: 'DEFICIT',
      recommended: 2,
      unassignable: 1,
      withheldBelowThreshold: 0,
      decisions: [],
      plan: [{ seId: 'se-2', plants: [{ plantId: '4', ticketIds: [GHOST] }] }],
    },
  ],
  holds: [],
  bucketsAsOf: `${TODAY}T04:00:00Z`,
  previewToken: 'pt',
  errors: [],
});

/** jsdom has no DataTransfer; the handlers only need setData/getData over one shared store. */
const dataTransfer = () => {
  const store: Record<string, string> = {};
  return {
    setData: (k: string, v: string) => {
      store[k] = v;
    },
    getData: (k: string) => store[k] ?? '',
    effectAllowed: '',
    dropEffect: '',
  };
};

const renderAt = (entry: string, session: SessionView = ZM) =>
  render(
    <AuthProvider initialSession={session}>
      <MemoryRouter initialEntries={[entry]}>
        <TodaysDispatchPage />
      </MemoryRouter>
    </AuthProvider>,
  );

beforeEach(() => {
  // The Work Pool rail is collapsed by default since 2026-09-01 (the board is the canvas). These
  // assertions are about what the rail *contains*, not about its default width, so they start from
  // the operator preference that opens it; the default and the toggle are covered explicitly in
  // `scheduler-console-composition.test.tsx`.
  localStorage.setItem('fsm.console.workRailOpen', '1');
  vi.mocked(apiDispatchToday).mockResolvedValue(view());
  vi.mocked(apiDispatchChangesToday).mockResolvedValue(changes());
  vi.mocked(apiListSchedules).mockResolvedValue([]);
  vi.mocked(getSchedulerPreview).mockResolvedValue(projection(TOMORROW) as never);
  vi.mocked(apiActionRequired).mockResolvedValue([]);
  vi.mocked(getDispatchInFlight).mockResolvedValue([]);
  vi.mocked(getDispatchSchedule).mockRejectedValue(new Error('403'));
  vi.mocked(apiCandidates).mockResolvedValue({ date: TODAY, plants: [] });
  vi.mocked(apiTicketDetail).mockResolvedValue({ lifecycle: [] } as never);
  vi.mocked(apiTicketAttempts).mockResolvedValue({
    ticketId: SYS_TICKET,
    threshold: 3,
    countableAttempts: 0,
    hasSubmission: false,
    isSpecial: false,
    attempts: [],
  });
  vi.mocked(apiDispatchTicketTrace).mockRejectedValue(new Error('no trace'));
  vi.mocked(apiZoneEngineers).mockResolvedValue([
    { engineerId: 'se-1', name: 'Ramesh K.', coverageType: 'DEDICATED', zoneId: '7', committed: 2, dailyCapacity: 8, isActive: true },
    { engineerId: 'se-2', name: 'Priya M.', coverageType: 'FLOATING', zoneId: '7', committed: 0, dailyCapacity: 8, isActive: true },
  ] as never);
  vi.mocked(apiOverridePreview).mockRejectedValue(new Error('NOT_PROJECTABLE'));
  vi.mocked(listZones).mockResolvedValue([{ zoneId: 7, name: 'North Zone' }] as never);
});

afterEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The board is the canvas: ENGINEER × DAY
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('The board is an engineer × day grid, and the mode nav is gone (D9)', () => {
  it('renders one row per engineer and one column per visible day, today at full fidelity', async () => {
    renderAt('/dispatch/today');

    const board = await screen.findByTestId('console-board');
    // Rows: the roster, in People-rail order.
    expect(within(board).getByTestId('lane-se-1')).toHaveTextContent('Ramesh K.');
    expect(within(board).getByTestId('lane-se-2')).toHaveTextContent('Priya M.');
    // Columns: yesterday · today · tomorrow in the default day span.
    expect(within(board).getByTestId(`day-column-${YESTERDAY}`)).toHaveAttribute('data-semantic', 'past');
    expect(within(board).getByTestId(`day-column-${TODAY}`)).toHaveAttribute('data-semantic', 'today');
    expect(within(board).getByTestId(`day-column-${TOMORROW}`)).toHaveAttribute('data-semantic', 'future');
    // Today's cell carries the committed chips; the empty lane is a fact, not an omission.
    expect(within(board).getByTestId(`chip-${SYS_TICKET}`)).toBeInTheDocument();
    expect(within(board).getByTestId(`cell-se-2-${TODAY}`)).toHaveTextContent(/no stops/i);
  });

  it('has no Plan/Live/Replay mode nav — the day axis replaced it', async () => {
    renderAt('/dispatch/today');
    await screen.findByTestId('console-board');
    expect(screen.queryByTestId('mode-plan')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mode-live')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mode-replay')).not.toBeInTheDocument();
    expect(screen.getByTestId('day-today')).toBeInTheDocument();
  });

  it('never gives /dispatch/today a date, whatever day is focused', async () => {
    const user = userEvent.setup();
    renderAt('/dispatch/today');
    await screen.findByTestId('console-board');

    await user.click(screen.getByTestId('day-prev'));
    await user.click(screen.getByTestId('day-today'));
    await user.click(screen.getByTestId('day-next'));

    // The live read stays istDate(now) server-side; a ZM names no zone and nobody names a date.
    expect(vi.mocked(apiDispatchToday).mock.calls.every((c) => c[0] === undefined)).toBe(true);
  });
});

describe('Each column answers from the source that can honestly answer for it (§6)', () => {
  it('a past day renders committed counts, as counts, with the affordance saying so', async () => {
    vi.mocked(apiListSchedules).mockImplementation((date?: string) =>
      Promise.resolve(date === YESTERDAY ? [scheduleRow('se-1', YESTERDAY, 3, 7)] : []),
    );
    const user = userEvent.setup();
    renderAt('/dispatch/today');
    await screen.findByTestId('console-board');

    await user.click(screen.getByTestId('day-prev'));

    // `detail=stops` rides along on rows the count path already fetched (#cross-day-move): the
    // Console asks every non-today column for it, and each column still decides what to *render*.
    await waitFor(() => expect(apiListSchedules).toHaveBeenCalledWith(YESTERDAY, 'stops'));
    const cell = await screen.findByTestId(`cell-se-1-${YESTERDAY}`);
    await waitFor(() => expect(cell).toHaveTextContent('3 stops · 7 devices'));
    // Count fidelity is stated, never dressed up as a chip board (§6.3 rule 5).
    expect(within(screen.getByTestId(`day-column-${YESTERDAY}`)).getByText(/counts only/i)).toBeInTheDocument();
  });

  it('focusing a future day runs the projection for that day only, and renders ghosts that cannot be selected', async () => {
    const user = userEvent.setup();
    renderAt('/dispatch/today');
    await screen.findByTestId('console-board');
    // Context columns never fire the recommender — it is the Console's most expensive read.
    expect(getSchedulerPreview).not.toHaveBeenCalled();

    await user.click(screen.getByTestId('day-next'));

    await waitFor(() => expect(getSchedulerPreview).toHaveBeenCalledWith(TOMORROW));
    expect(getSchedulerPreview).toHaveBeenCalledTimes(1);
    const ghost = await screen.findByTestId(`ghost-${GHOST}`);
    // A projection is not a committed object: nothing to inspect, nothing to override — not a button.
    expect(ghost.tagName).toBe('SPAN');
    // Conditional mood, with the as-of watermark, in the column header.
    const header = screen.getByTestId(`day-column-${TOMORROW}`);
    expect(within(header).getByTestId(`projection-summary-${TOMORROW}`)).toHaveTextContent(/would be assigned/i);
  });

  it('a committed schedule on a future day beats the projection (§6.3 rule 3)', async () => {
    vi.mocked(apiListSchedules).mockImplementation((date?: string) =>
      Promise.resolve(date === TOMORROW ? [scheduleRow('se-1', TOMORROW, 2, 4)] : []),
    );
    const user = userEvent.setup();
    renderAt('/dispatch/today');
    await screen.findByTestId('console-board');

    await user.click(screen.getByTestId('day-next'));

    // se-1 has a live WorkSchedule covering the date: that cell is committed, not conditional…
    const committedCell = await screen.findByTestId(`cell-se-1-${TOMORROW}`);
    await waitFor(() => expect(committedCell).toHaveTextContent(/committed/i));
    expect(within(committedCell).queryByTestId(/^ghost-/)).not.toBeInTheDocument();
    // …while se-2, with no committed plan, still renders the projection's ghosts.
    expect(await screen.findByTestId(`ghost-${GHOST}`)).toBeInTheDocument();
  });

  it("the run's decisions are one click from the today column, in the run's own order", async () => {
    vi.mocked(apiDispatchRunDecisions).mockResolvedValue({
      runId: '42',
      total: 1,
      limit: 100,
      offset: 0,
      rows: [
        {
          ticketId: SYS_TICKET,
          zoneId: '7',
          processingRank: 1,
          status: 'DISPATCHED',
          seId: 'se-1',
          seName: 'Ramesh K.',
          plantId: '4',
          plantName: 'Acme Cement',
          deviceId: 'DEV-1',
          companyTier: 'GOLD',
          deviceBucket: 'CRITICAL',
          poolEmptyReason: null,
          candidatesTotal: 4,
          passedCount: 2,
        },
      ],
    } as never);
    const user = userEvent.setup();
    renderAt('/dispatch/today');
    await screen.findByTestId('console-board');

    await user.click(screen.getByTestId('today-run-decisions'));

    const inspector = await screen.findByTestId('console-inspector');
    expect(within(inspector).getByTestId(`decision-row-${SYS_TICKET}`)).toHaveTextContent('Ramesh K.');
    expect(apiDispatchRunDecisions).toHaveBeenCalledWith('42', { zoneId: '7' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The right rail is one slot; the Inspector is contextual
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('One right-rail slot, two occupants (§9, §11)', () => {
  it('shows the Work Pool by default and swaps to the Attention list on the strip, never both', async () => {
    vi.mocked(apiActionRequired).mockResolvedValue([
      { key: 'failed_verification', label: 'Failed Verification items', urgency: 4, count: 5, available: true, source: 't' },
    ]);
    const user = userEvent.setup();
    renderAt('/dispatch/today');

    expect(await screen.findByTestId('console-work-rail')).toBeInTheDocument();
    expect(screen.queryByTestId('console-attention')).not.toBeInTheDocument();
    expect(screen.queryByTestId('console-work-rail-handle')).not.toBeInTheDocument();

    await user.click(await screen.findByTestId('attention-strip'));
    expect(await screen.findByTestId('console-attention')).toBeInTheDocument();
    expect(screen.queryByTestId('console-work-rail')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('rail-back-to-pool'));
    expect(await screen.findByTestId('console-work-rail')).toBeInTheDocument();
  });

  /**
   * **The rail is collapsed until asked for** (operator ruling, 2026-09-01). Composition rule 1 gives
   * the board every pixel that is not spoken for, and a 20rem gutter is spoken for all day on behalf
   * of a panel nobody is reading most of it. Collapsed, the pool is an icon that still carries its
   * own count — hiding the panel must not hide *how much work is in it*.
   */
  it('collapses the Work Pool to a counted handle by default, and opens it on click', async () => {
    localStorage.removeItem('fsm.console.workRailOpen'); // a first-time operator, no preference yet
    const user = userEvent.setup();
    renderAt('/dispatch/today');

    const handle = await screen.findByTestId('console-work-rail-handle');
    expect(screen.queryByTestId('console-work-rail')).not.toBeInTheDocument();
    // The count survives the collapse: the pool says how much is waiting even while shut.
    expect(handle).toHaveTextContent(String(view().rails.unassignable.length));

    await user.click(screen.getByTestId('work-rail-open'));
    expect(await screen.findByTestId('console-work-rail')).toBeInTheDocument();
    expect(screen.queryByTestId('console-work-rail-handle')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('work-rail-collapse'));
    expect(await screen.findByTestId('console-work-rail-handle')).toBeInTheDocument();
  });

  /**
   * The collapse takes width, never a capability. A placed chip dropped on the rail opens Remove
   * prefilled (D10); the handle is the rail's whole surface while shut, so it has to keep that door.
   */
  it('still opens Remove when a placed chip is dropped on the collapsed handle', async () => {
    localStorage.removeItem('fsm.console.workRailOpen');
    renderAt('/dispatch/today');
    const chip = await screen.findByTestId(`chip-${SYS_TICKET}`);

    const dt = dataTransfer();
    fireEvent.dragStart(chip, { dataTransfer: dt });
    fireEvent.drop(screen.getByTestId('console-work-rail-handle'), { dataTransfer: dt });

    expect(await screen.findByTestId('console-inspector')).toBeInTheDocument();
    expect(await screen.findByTestId('action-reason')).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Deferred work is visible on the day it comes back (operator request, 2026-08-31)
// ─────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * **"I postponed it to Thursday — show me it on Thursday."**
 *
 * A defer took work off today's board and the board then said nothing at all about where it went. The
 * operator deferred three devices, watched them vanish, re-ran dispatch, and reasonably read the
 * silence as the system having ignored the decision.
 *
 * It goes in **its own row**, never inside an engineer's cell, and that restraint is the whole design.
 * A deferred ticket is `assignmentState: UNASSIGNED` with no `assignedSeId` — **nobody holds it on the
 * day it returns.** Drawing it in the cell of the engineer it was deferred *from* would say that
 * engineer has it tomorrow, which is false, and would be the one thing §6.3 forbids: a column claiming
 * more than its source can answer. The row says the true thing instead — *this much work lands back in
 * play that day, owned by no one yet*.
 *
 * The row reads from `rails.held`, which the lifted payload already carries. No new fetch, no new
 * endpoint, and it is therefore visible on **every** day column without focusing one.
 */
describe('Deferred work reappears on the day it returns', () => {
  const heldTomorrow = () =>
    view({
      rails: {
        unassignable: [
          { ticketId: POOLED, deviceId: 'DEV-9', plantId: '5', plantName: 'Beta Works', poolEmptyReason: 'NO_COVERAGE', failureCycles: null },
        ],
        held: [
          { ticketId: GHOST, deviceId: 'DEV-77', plantName: 'Gamma Site', heldUntil: TOMORROW, expectedFrom: null, decidedBy: null, deferredBy: null, deferredByName: null, deferredReason: null, failureCycles: null },
        ],
        policyWithheld: { count: 0, itemised: false },
      },
    });

  it('counts the returning work under the day it returns to, not under an engineer', async () => {
    vi.mocked(apiDispatchToday).mockResolvedValue(heldTomorrow());
    const user = userEvent.setup();
    renderAt('/dispatch/today');
    await screen.findByTestId('console-board');
    await user.click(screen.getByTestId('span-week'));

    expect(await screen.findByTestId(`returning-${TOMORROW}`)).toHaveTextContent('1 device');
    // Today gets work back from nobody, and says so rather than borrowing tomorrow's number.
    expect(screen.getByTestId(`returning-${TODAY}`)).toHaveTextContent('—');
    // And emphatically NOT inside the lane of the engineer it was deferred from.
    expect(within(screen.getByTestId(`cell-se-1-${TOMORROW}`)).queryByText(/DEV-77/)).not.toBeInTheDocument();
  });

  /**
   * The forecast is the second half, and the half that carries the operational point: of the three
   * devices this operator deferred, **two were already predicted to fail again the next day**. A row
   * that says "3 coming back" and stays silent about that teaches the postpone was free.
   */
  it('warns when the day it returns to still has no engineer for it', async () => {
    vi.mocked(apiDispatchToday).mockResolvedValue(heldTomorrow());
    vi.mocked(getSchedulerPreview).mockResolvedValue({
      ...projection(TOMORROW),
      zones: [{ ...projection(TOMORROW).zones[0], plan: [], decisions: [{ ticketId: GHOST, seId: null, poolEmptyReason: 'ALL_DROPPED' }] }],
    } as never);

    renderAt(`/dispatch/today?day=${TOMORROW}`);
    expect(await screen.findByTestId(`returning-${TOMORROW}`)).toHaveTextContent(/no engineer for it yet/i);
  });

  /**
   * The count is on every column; the device ids appear on the **focused** one — composition rule 5,
   * the same bargain every other cell on this board makes, so a context column stays a context column.
   * The row is then a door to the same ticket the Work Pool's Held tab opens: one object, one
   * Inspector, whichever door was used (§3.2), and Release-the-hold is waiting there.
   */
  it('the returning row is a door to the same ticket — selecting it opens the same Inspector', async () => {
    vi.mocked(apiDispatchToday).mockResolvedValue(heldTomorrow());
    const user = userEvent.setup();
    renderAt(`/dispatch/today?day=${TOMORROW}`);

    await user.click(await screen.findByTestId(`returning-open-${GHOST}`));
    expect(await screen.findByTestId('console-inspector')).toBeInTheDocument();
  });
});

/**
 * **A manager's decision must not read like the system's.** Both of these shipped drawing a deliberate
 * override as an anonymous event, which is how three deferrals came to look like three devices simply
 * disappearing off the board.
 */
describe('An override says who made it and why', () => {
  it('the Held rail names the manager who deferred it, and prints their reason', async () => {
    vi.mocked(apiDispatchToday).mockResolvedValue(
      view({
        rails: {
          unassignable: [],
          held: [
            {
              ticketId: GHOST,
              deviceId: 'DEV-77',
              plantName: 'Gamma Site',
              heldUntil: TOMORROW,
              expectedFrom: null,
              decidedBy: null,
              deferredBy: 'zm1',
              deferredByName: 'ZM North',
              deferredReason: 'Vehicle return not confirmed yet',
              failureCycles: null,
            },
          ],
          policyWithheld: { count: 0, itemised: false },
        },
      }),
    );
    const user = userEvent.setup();
    renderAt('/dispatch/today');
    await user.click(await screen.findByTestId('pool-tab-held'));

    const row = await screen.findByTestId(`held-deferred-by-${GHOST}`);
    expect(row).toHaveTextContent('deferred by ZM North');
    expect(row).toHaveTextContent('Vehicle return not confirmed yet');
  });

  /** A hold nobody deferred says nothing — absence stays absence, and gets no invented actor. */
  it('a system hold claims no author', async () => {
    vi.mocked(apiDispatchToday).mockResolvedValue(
      view({
        rails: {
          unassignable: [],
          held: [
            {
              ticketId: GHOST,
              deviceId: 'DEV-77',
              plantName: 'Gamma Site',
              heldUntil: TOMORROW,
              expectedFrom: null,
              decidedBy: null,
              deferredBy: null,
              deferredByName: null,
              deferredReason: null,
              failureCycles: null,
            },
          ],
          policyWithheld: { count: 0, itemised: false },
        },
      }),
    );
    const user = userEvent.setup();
    renderAt('/dispatch/today');
    await user.click(await screen.findByTestId('pool-tab-held'));

    expect(await screen.findByText('DEV-77')).toBeInTheDocument();
    expect(screen.queryByTestId(`held-deferred-by-${GHOST}`)).not.toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// D10 — drag initiates, never commits
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('Drag opens the authoritative dialog, prefilled — release writes nothing (D10, §12)', () => {
  it('chip → another engineer, today: opens Reassign with the target seeded and no write fired', async () => {
    renderAt('/dispatch/today');
    const chip = await screen.findByTestId(`chip-${SYS_TICKET}`);
    const target = screen.getByTestId(`cell-se-2-${TODAY}`);

    const dt = dataTransfer();
    fireEvent.dragStart(chip, { dataTransfer: dt });
    fireEvent.drop(target, { dataTransfer: dt });

    // The same dialog the typed path uses, on the same Inspector, with the drop's answer seeded…
    const select = await screen.findByTestId('action-target-se');
    await waitFor(() => expect(select).toHaveValue('se-2'));
    // …and the reason still mandatory: Confirm is disabled until it is typed.
    expect(screen.getByTestId('action-confirm')).toBeDisabled();
    expect(apiOverrideBatch).not.toHaveBeenCalled();
  });

  /**
   * The engineer's name is a drop target too, and it shipped inert — which made the gesture operators
   * actually reach for do nothing at all. Wanting to move a device to an engineer, you drag it onto
   * *that engineer*: their name, in the personnel column. Reported as "I can't drag and drop a device".
   *
   * A row means **this engineer, today**, so it is the same question the board's today column asks and
   * it is answered by the same `dropAction` — asserted here through the same seeded dialog, so the two
   * doors cannot start disagreeing about one gesture.
   *
   * **Retargeted from `person-` to `lane-` by #295**, which deleted the separate People rail and moved
   * this capability into the board's own engineer column. The gesture and its guarantee are unchanged;
   * only the element carrying them moved, which is exactly why this test was retargeted rather than
   * rewritten — it is the regression guard for that move.
   */
  it('chip → an engineer’s row: opens Reassign seeded, exactly as the board cell does', async () => {
    renderAt('/dispatch/today');
    const chip = await screen.findByTestId(`chip-${SYS_TICKET}`);

    const dt = dataTransfer();
    fireEvent.dragStart(chip, { dataTransfer: dt });
    fireEvent.drop(screen.getByTestId('lane-se-2'), { dataTransfer: dt });

    const select = await screen.findByTestId('action-target-se');
    await waitFor(() => expect(select).toHaveValue('se-2'));
    expect(screen.getByTestId('action-confirm')).toBeDisabled();
    expect(apiOverrideBatch).not.toHaveBeenCalled();
  });

  /** The engineer who already holds it is not a reassign target — on their row as in their cell. */
  it('chip → the engineer who already holds it: their row refuses, nothing opens', async () => {
    renderAt('/dispatch/today');
    const chip = await screen.findByTestId(`chip-${SYS_TICKET}`);

    const dt = dataTransfer();
    fireEvent.dragStart(chip, { dataTransfer: dt });
    fireEvent.drop(screen.getByTestId('lane-se-1'), { dataTransfer: dt });

    await waitFor(() => expect(screen.queryByTestId('action-target-se')).not.toBeInTheDocument());
    expect(apiOverrideBatch).not.toHaveBeenCalled();
  });

  /**
   * **This test used to assert the defect.**
   *
   * It read: *"chip → the same engineer on a later day: opens Defer with the date seeded"* — and it
   * passed, because that is exactly what the code did. What it pinned was the mismatch itself: a
   * gesture naming a cell (`this engineer, that day`) answered by an operation that names neither,
   * since `DEFER_TICKET` unassigns the ticket and leaves the target day's run to decide who takes it.
   * The operator saw the chip leave today, an `adjusted` badge on the stop behind it, and nothing at
   * all in the cell they aimed at.
   *
   * It is rewritten rather than deleted because the gesture it describes is still the gesture; only
   * the operation behind it changed. **Defer's own tests are untouched** — see the "Deferred work
   * reappears on the day it returns" suite below, which pins the semantics `DEFER_TICKET` genuinely
   * has, and the typed Defer button that still reaches them.
   */
  it('chip → the same engineer on a later day: opens Move, with both coordinates seeded', async () => {
    const user = userEvent.setup();
    renderAt('/dispatch/today');
    await screen.findByTestId('console-board');
    // Widen to week so a future cell of the same engineer is on screen alongside today.
    await user.click(screen.getByTestId('span-week'));

    const chip = await screen.findByTestId(`chip-${SYS_TICKET}`);
    const dt = dataTransfer();
    fireEvent.dragStart(chip, { dataTransfer: dt });
    fireEvent.drop(screen.getByTestId(`cell-se-1-${TOMORROW}`), { dataTransfer: dt });

    // The move dialog, not the defer one — and the drop answered the date.
    expect(await screen.findByTestId('move-date')).toHaveValue(TOMORROW);
    await waitFor(() => expect(screen.getByTestId('move-target-se')).toHaveValue('se-1'));
    // D10 is unchanged by any of this: a drop still writes nothing.
    expect(apiOverrideBatch).not.toHaveBeenCalled();
  });

  /**
   * The diagonal — another engineer AND another day — used to be refused outright (`dropTargets`
   * returned `null` for it), so the cell never became a drop target and the gesture died under the
   * cursor. It is one decision stated in the two coordinates a cell has, and `MOVE_TICKET` carries
   * both in one command, so there is nothing to split into two dialogs.
   */
  it('chip → a different engineer on a later day: opens Move with both coordinates seeded', async () => {
    const user = userEvent.setup();
    renderAt('/dispatch/today');
    await screen.findByTestId('console-board');
    await user.click(screen.getByTestId('span-week'));

    const chip = await screen.findByTestId(`chip-${SYS_TICKET}`);
    const dt = dataTransfer();
    fireEvent.dragStart(chip, { dataTransfer: dt });
    fireEvent.drop(screen.getByTestId(`cell-se-2-${TOMORROW}`), { dataTransfer: dt });

    expect(await screen.findByTestId('move-date')).toHaveValue(TOMORROW);
    await waitFor(() => expect(screen.getByTestId('move-target-se')).toHaveValue('se-2'));
    expect(apiOverrideBatch).not.toHaveBeenCalled();
  });

  /**
   * **The summary line, which is the half of the fix that is not a write.**
   *
   * The operator's complaint was never only that the ticket did not move — it was that the dialog
   * said "Defer" about a gesture that meant "move". A confirm whose copy describes a different
   * operation is worse than no copy: it is read, believed, and confirmed.
   */
  it('the move dialog states the whole change in the operator’s own terms', async () => {
    const user = userEvent.setup();
    renderAt('/dispatch/today');
    await screen.findByTestId('console-board');
    await user.click(screen.getByTestId('span-week'));

    const chip = await screen.findByTestId(`chip-${SYS_TICKET}`);
    const dt = dataTransfer();
    fireEvent.dragStart(chip, { dataTransfer: dt });
    fireEvent.drop(screen.getByTestId(`cell-se-2-${TOMORROW}`), { dataTransfer: dt });

    const summary = await screen.findByTestId('move-summary');
    // From this day to that day… (the board's own `dayLabel`, so the dialog and the column agree)
    expect(summary).toHaveTextContent('Fri, 28 Aug');
    expect(summary).toHaveTextContent('Sat, 29 Aug');
    // …and from this engineer to that one.
    expect(summary).toHaveTextContent('Ramesh K.');
    await waitFor(() => expect(summary).toHaveTextContent('Priya M.'));
    // And it must not describe itself as the operation it is not.
    expect(screen.getByTestId('move-form')).toHaveTextContent(/not a defer/i);
  });

  /**
   * The whole write, end to end: confirm sends `MOVE_TICKET` — never `DEFER_TICKET` — with both
   * coordinates and the mandatory reason, and the board then takes the operator to the day the work
   * landed on. Refetching without the focus change would leave them looking at the column the work
   * just left, which is the same silence the old behaviour produced.
   */
  it('confirming commits MOVE_TICKET and takes the operator to the day it landed on', async () => {
    vi.mocked(apiOverrideBatch).mockResolvedValue({
      result: 'OK',
      batchId: 'b-moved',
      scheduleId: 's-2',
      seId: 'se-1',
      status: 'OVERRIDDEN',
      movedToDate: TOMORROW,
    } as never);
    const user = userEvent.setup();
    renderAt('/dispatch/today');
    await screen.findByTestId('console-board');
    await user.click(screen.getByTestId('span-week'));

    const chip = await screen.findByTestId(`chip-${SYS_TICKET}`);
    const dt = dataTransfer();
    fireEvent.dragStart(chip, { dataTransfer: dt });
    fireEvent.drop(screen.getByTestId(`cell-se-1-${TOMORROW}`), { dataTransfer: dt });

    await screen.findByTestId('move-date');
    await user.type(screen.getByTestId('move-reason'), 'Vehicle back tomorrow');
    await waitFor(() => expect(screen.getByTestId('move-confirm')).toBeEnabled());
    await user.click(screen.getByTestId('move-confirm'));

    await waitFor(() =>
      expect(apiOverrideBatch).toHaveBeenCalledWith('b1', {
        action: 'MOVE_TICKET',
        ticketId: SYS_TICKET,
        newSeId: 'se-1',
        targetDate: TOMORROW,
        reasonCode: 'Vehicle back tomorrow',
      }),
    );
    // The board goes where the work went.
    await waitFor(() =>
      expect(screen.getByTestId(`day-column-${TOMORROW}`).querySelector('[data-testid^="day-focus-"]')).toHaveClass(
        'font-semibold',
      ),
    );
  });

  /**
   * **A moved ticket is drawn as committed work, in the cell it was dropped on.** This is the
   * assertion the original bug report reduces to: the operator drops on Wednesday and expects to see
   * their ticket on Wednesday. The old path could not satisfy it even in principle — a deferred
   * ticket is `UNASSIGNED` and belongs to nobody, so no engineer's cell could honestly draw it.
   */
  it('the target day renders the moved ticket as committed work, not as a projection', async () => {
    vi.mocked(apiListSchedules).mockImplementation((date?: string) =>
      Promise.resolve(date === TOMORROW ? [scheduleRow('se-1', TOMORROW, 1, 1, [movedStop(SYS_TICKET)])] : []),
    );
    const user = userEvent.setup();
    renderAt('/dispatch/today');
    await screen.findByTestId('console-board');

    await user.click(screen.getByTestId('day-next'));

    const cell = await screen.findByTestId(`cell-se-1-${TOMORROW}`);
    // The ticket itself, in that engineer's cell — not a tally, and not a ghost.
    expect(await within(cell).findByTestId(`committed-${SYS_TICKET}`)).toBeInTheDocument();
    expect(within(cell).queryByTestId(`ghost-${SYS_TICKET}`)).not.toBeInTheDocument();
    // Marked as the operator's own move, so it is not mistaken for something the run decided.
    expect(within(cell).getByTestId(`committed-moved-${SYS_TICKET}`)).toBeInTheDocument();
    expect(cell).toHaveTextContent(/committed/i);
  });

  /**
   * The column badge said `projected` on every future column unconditionally — including columns no
   * projection had ever been run for, since only the focused day fires one. Dropping work onto a
   * column advertising a forecast that does not exist is the same mismatch this change is about, one
   * level up, so the badge now says which of the three states is actually true.
   */
  it('an unprojected future column does not claim to be projected', async () => {
    const user = userEvent.setup();
    renderAt('/dispatch/today');
    await screen.findByTestId('console-board');
    await user.click(screen.getByTestId('span-week'));

    // Two days out: never focused, so never projected.
    const far = await screen.findByTestId(`day-column-2026-08-30`);
    await waitFor(() => expect(far).toHaveTextContent(/not projected/i));
  });

  it('a past column refuses the drop — nothing opens, nothing writes', async () => {
    renderAt('/dispatch/today');
    const chip = await screen.findByTestId(`chip-${SYS_TICKET}`);

    const dt = dataTransfer();
    fireEvent.dragStart(chip, { dataTransfer: dt });
    fireEvent.drop(screen.getByTestId(`cell-se-2-${YESTERDAY}`), { dataTransfer: dt });

    expect(screen.queryByTestId('console-inspector')).not.toBeInTheDocument();
    expect(apiOverrideBatch).not.toHaveBeenCalled();
  });

  it('pool row → an engineer cell: opens Assign with the lane seeded', async () => {
    renderAt('/dispatch/today');
    await screen.findByTestId('console-board');
    const row = within(screen.getByTestId('console-work-rail')).getByText('DEV-9').closest('button')!;

    const dt = dataTransfer();
    fireEvent.dragStart(row, { dataTransfer: dt });
    fireEvent.drop(screen.getByTestId(`cell-se-2-${TODAY}`), { dataTransfer: dt });

    const select = await screen.findByTestId('assign-target-se');
    await waitFor(() => expect(select).toHaveValue('se-2'));
  });

  /**
   * **The drop worked and the operator could not see it.** Every assertion above passes in jsdom, where
   * nothing has a height — and the gesture was still reported as broken, because on a real screen the
   * dialog this drop opens rendered ~12,000px below the fold. The Console's deck was unbounded in
   * height (215 unassigned rows in the Work Pool stretched the three-column row to 11,124px), and the
   * Inspector was the band *underneath* that deck, so a drop selected the chip, seeded the dialog, and
   * put the whole visible response off-screen. From the operator's seat: drag a device, drop it, and
   * nothing happens.
   *
   * That was first answered by scroll-chasing the band into view. The operator ruling of 2026-09-01
   * removed the distance instead of chasing it: the Inspector is a **modal overlay**, so the drop's
   * answer opens over the board wherever the reader is, and the board keeps the scroll position they
   * had. This test guards the guarantee, not the old mechanism — the dialog is reachable without the
   * page having to move under anyone.
   */
  it('opens the drop’s answer as an overlay — a dialog below the fold is a dead gesture', async () => {
    // `test/setup.ts` stubs the method jsdom does not implement; this watches it.
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');

    renderAt('/dispatch/today');
    const chip = await screen.findByTestId(`chip-${SYS_TICKET}`);

    const dt = dataTransfer();
    fireEvent.dragStart(chip, { dataTransfer: dt });
    fireEvent.drop(screen.getByTestId(`cell-se-2-${TODAY}`), { dataTransfer: dt });

    await screen.findByTestId('action-target-se');

    // The seeded dialog is inside a real modal, not a band at the far end of the document.
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toContainElement(screen.getByTestId('console-inspector'));
    expect(dialog).toContainElement(screen.getByTestId('action-target-se'));

    // …and nothing scrolls the page out from under the operator to achieve it.
    expect(scrollIntoView).not.toHaveBeenCalled();
    scrollIntoView.mockRestore();
  });

  /**
   * The Console's own Escape handler already deselects, and the overlay closes with the selection.
   * Both doors matter: a modal that can only be dismissed by hunting for its Close button is the same
   * obstruction as a band nobody could find.
   */
  it('closes the overlay on Escape, and the board is still there behind it', async () => {
    const user = userEvent.setup();
    renderAt('/dispatch/today');
    const chip = await screen.findByTestId(`chip-${SYS_TICKET}`);

    await user.click(chip);
    await screen.findByTestId('console-inspector');

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('console-inspector')).not.toBeInTheDocument());
    expect(screen.getByTestId('console-board')).toBeInTheDocument();
  });

  /**
   * **Cancel and Close mean the same thing to the operator.** The overlay is opened by an errand —
   * a drop, or a click on an action — and cancelling that errand ends it. Dropping them back onto an
   * Actions row they did not ask to return to is the modal-era version of the dead gesture above.
   */
  it('closes the overlay when a seeded dialog is cancelled', async () => {
    const user = userEvent.setup();
    renderAt('/dispatch/today');
    const chip = await screen.findByTestId(`chip-${SYS_TICKET}`);

    const dt = dataTransfer();
    fireEvent.dragStart(chip, { dataTransfer: dt });
    fireEvent.drop(screen.getByTestId(`cell-se-2-${TODAY}`), { dataTransfer: dt });

    await screen.findByTestId('action-target-se');
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));

    await waitFor(() => expect(screen.queryByTestId('console-inspector')).not.toBeInTheDocument());
  });

  /**
   * The other half of the same defect, and the reason the distance existed. Composition rule 1: the
   * board "takes all remaining width *and* all remaining height — it is the only region that grows."
   * A Work Pool that renders every unassigned row inline is a second region that grows, and on a live
   * zone it grew to eleven thousand pixels. The population stays whole and browsable; it scrolls
   * inside its own rail instead of stretching the page the Inspector sits at the bottom of.
   */
  it('the Work Pool scrolls inside its rail rather than stretching the deck', async () => {
    renderAt('/dispatch/today');
    const rail = await screen.findByTestId('console-work-rail');
    const list = within(rail).getByTestId('work-rail-scroll');

    expect(list.className).toMatch(/overflow-y-auto/);
    // The rows live inside the scroll region — a scroll container the list is not in bounds nothing.
    expect(within(list).getByText('DEV-9')).toBeInTheDocument();
  });

  it('chip → the Work Pool: opens Remove, which still demands its reason', async () => {
    renderAt('/dispatch/today');
    const chip = await screen.findByTestId(`chip-${SYS_TICKET}`);

    const dt = dataTransfer();
    fireEvent.dragStart(chip, { dataTransfer: dt });
    fireEvent.drop(screen.getByTestId('console-work-rail'), { dataTransfer: dt });

    expect(await screen.findByText(/Remove this ticket from the plan/i)).toBeInTheDocument();
    expect(screen.getByTestId('action-confirm')).toBeDisabled();
    expect(apiOverrideBatch).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// D11 — the four-channel grammar
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('Urgency is a token that travels with the ticket (D11, §7.3)', () => {
  it('marks critical work a human assigned — the case the border grammar could not reach', async () => {
    renderAt('/dispatch/today');

    const chip = await screen.findByTestId(`chip-${HUMAN_CRIT}`);
    // The urgency token renders although systemPlaced is false…
    expect(within(chip).getByTestId(`crit-${HUMAN_CRIT}`)).toHaveTextContent('CRIT');
    // …and the border still carries provenance: dashed = a human decided.
    expect(chip.className).toMatch(/border-dashed/);
  });

  it('spends no border on urgency for system-placed critical work either — one channel, one meaning', async () => {
    renderAt('/dispatch/today');
    const chip = await screen.findByTestId(`chip-${SYS_TICKET}`);
    // WARNING bucket: no urgency token, plain provenance border.
    expect(within(chip).queryByTestId(`crit-${SYS_TICKET}`)).not.toBeInTheDocument();
  });

  it('keeps the grammar reference one click away instead of a permanent strip', async () => {
    renderAt('/dispatch/today');
    await screen.findByTestId('console-board');
    const legend = screen.getByTestId('grammar-legend');
    expect(within(legend).getByText(/system decision/i)).toBeInTheDocument();
    expect(within(legend).getByText(/projected by the preview/i)).toBeInTheDocument();
  });
});
