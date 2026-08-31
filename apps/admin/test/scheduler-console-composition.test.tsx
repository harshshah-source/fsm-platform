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
  ...over,
});

const view = (over: Partial<DispatchTodayView> = {}): DispatchTodayView => ({
  operatingDay: TODAY,
  chronicThreshold: 3,
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

const scheduleRow = (seId: string, date: string, batchCount: number, ticketCount: number) => ({
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

    await waitFor(() => expect(apiListSchedules).toHaveBeenCalledWith(YESTERDAY));
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

    await user.click(await screen.findByTestId('attention-strip'));
    expect(await screen.findByTestId('console-attention')).toBeInTheDocument();
    expect(screen.queryByTestId('console-work-rail')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('rail-back-to-pool'));
    expect(await screen.findByTestId('console-work-rail')).toBeInTheDocument();
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
   * The roster is a drop target too, and it shipped inert — which made the gesture operators actually
   * reach for do nothing at all. Wanting to move a device to an engineer, you drag it onto *that
   * engineer*: the name, in the list on the left. Reported as "I can't drag and drop a device".
   *
   * A row means **this engineer, today**, so it is the same question the board's today column asks and
   * it is answered by the same `dropAction` — asserted here through the same seeded dialog, so the two
   * doors cannot start disagreeing about one gesture.
   */
  it('chip → an engineer in the roster: opens Reassign seeded, exactly as the board cell does', async () => {
    renderAt('/dispatch/today');
    const chip = await screen.findByTestId(`chip-${SYS_TICKET}`);

    const dt = dataTransfer();
    fireEvent.dragStart(chip, { dataTransfer: dt });
    fireEvent.drop(screen.getByTestId('person-se-2'), { dataTransfer: dt });

    const select = await screen.findByTestId('action-target-se');
    await waitFor(() => expect(select).toHaveValue('se-2'));
    expect(screen.getByTestId('action-confirm')).toBeDisabled();
    expect(apiOverrideBatch).not.toHaveBeenCalled();
  });

  /** The engineer who already holds it is not a reassign target — in the roster as on the board. */
  it('chip → the engineer who already holds it: the roster row refuses, nothing opens', async () => {
    renderAt('/dispatch/today');
    const chip = await screen.findByTestId(`chip-${SYS_TICKET}`);

    const dt = dataTransfer();
    fireEvent.dragStart(chip, { dataTransfer: dt });
    fireEvent.drop(screen.getByTestId('person-se-1'), { dataTransfer: dt });

    await waitFor(() => expect(screen.queryByTestId('action-target-se')).not.toBeInTheDocument());
    expect(apiOverrideBatch).not.toHaveBeenCalled();
  });

  it('chip → the same engineer on a later day: opens Defer with the date seeded', async () => {
    const user = userEvent.setup();
    renderAt('/dispatch/today');
    await screen.findByTestId('console-board');
    // Widen to week so a future cell of the same engineer is on screen alongside today.
    await user.click(screen.getByTestId('span-week'));

    const chip = await screen.findByTestId(`chip-${SYS_TICKET}`);
    const dt = dataTransfer();
    fireEvent.dragStart(chip, { dataTransfer: dt });
    fireEvent.drop(screen.getByTestId(`cell-se-1-${TOMORROW}`), { dataTransfer: dt });

    expect(await screen.findByTestId('action-defer-date')).toHaveValue(TOMORROW);
    expect(apiOverrideBatch).not.toHaveBeenCalled();
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
