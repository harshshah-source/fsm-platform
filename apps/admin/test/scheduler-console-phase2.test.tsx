import type { SessionView } from '@fsm/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchChangesTodayView, DispatchTodayView } from '../src/api/dispatchToday';
import { OverrideConflictError } from '../src/api/schedules';
import { AuthProvider } from '../src/auth/AuthProvider';
import TodaysDispatchPage from '../src/pages/dispatch/TodaysDispatchPage';

/**
 * **Scheduler Console — Phase 2: the Console becomes commandable.**
 *
 * Phase 1 made the Console the place a manager understands the day. Phase 2 makes it the place they
 * change it, under the operator's D1 ruling: the six override controls were **moved** out of
 * `ScheduleDetailPage` rather than duplicated, so `#282 R5` still holds at one implementation.
 *
 * These tests are about the properties that make that safe to do from a screen with four regions on
 * it — the mandatory reason, the two 409 gates saying *which* conflict they are, the impact preview
 * that is information and not a gate, the legal-set-only rule, and the invalidation contract without
 * which a committed override leaves three panes showing yesterday's truth.
 */

vi.mock('../src/api/dispatchToday', async () => {
  const actual = await vi.importActual('../src/api/dispatchToday');
  return { ...actual, apiDispatchToday: vi.fn(), apiDispatchChangesToday: vi.fn() };
});
vi.mock('../src/api/dispatch-runs', async () => {
  const actual = await vi.importActual('../src/api/dispatch-runs');
  return { ...actual, apiDispatchRunDecisions: vi.fn(), apiDispatchTicketTrace: vi.fn() };
});
vi.mock('../src/api/candidates', async () => {
  const actual = await vi.importActual('../src/api/candidates');
  return { ...actual, apiCandidates: vi.fn() };
});
vi.mock('../src/api/tickets', async () => {
  const actual = await vi.importActual('../src/api/tickets');
  return { ...actual, apiTicketDetail: vi.fn(), apiTicketAttempts: vi.fn() };
});
vi.mock('../src/api/dispatchSchedule', async () => {
  const actual = await vi.importActual('../src/api/dispatchSchedule');
  return { ...actual, getDispatchInFlight: vi.fn() };
});
vi.mock('../src/api/schedulerPreview', async () => {
  const actual = await vi.importActual('../src/api/schedulerPreview');
  return { ...actual, placeHold: vi.fn(), releaseHold: vi.fn() };
});
vi.mock('../src/api/schedules', async () => {
  const actual = await vi.importActual<typeof import('../src/api/schedules')>('../src/api/schedules');
  return {
    ...actual,
    apiZoneEngineers: vi.fn(),
    apiOverrideBatch: vi.fn(),
    apiOverridePreview: vi.fn(),
    apiAssignTicket: vi.fn(),
  };
});

const { apiDispatchToday, apiDispatchChangesToday } = await import('../src/api/dispatchToday');
const { apiDispatchTicketTrace } = await import('../src/api/dispatch-runs');
const { apiCandidates } = await import('../src/api/candidates');
const { apiTicketDetail, apiTicketAttempts } = await import('../src/api/tickets');
const { getDispatchInFlight } = await import('../src/api/dispatchSchedule');
const { placeHold, releaseHold } = await import('../src/api/schedulerPreview');
const { apiZoneEngineers, apiOverrideBatch, apiOverridePreview, apiAssignTicket } = await import(
  '../src/api/schedules'
);

const ZM: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 7, acted_as_role: null };

const TICKET = '11111111-2222-3333-4444-555555555555';
const TICKET2 = '22222222-3333-4444-5555-666666666666';
const HELD = '99999999-8888-7777-6666-555555555555';
const STRANDED = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const chip = (id: string) => ({
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
});

const view = (over: Partial<DispatchTodayView> = {}): DispatchTodayView => ({
  operatingDay: '2026-08-28',
  chronicThreshold: 3,
  zone: { zoneId: '7', name: 'North Zone' },
  run: { runId: '42', status: 'SUCCESS', trigger: 'CRON', startedAt: '2026-08-28T05:00:00Z', finishedAt: null },
  recovery: null,
  engineers: [
    {
      seId: 'se-1',
      name: 'Ramesh K.',
      coverageType: 'DEDICATED',
      committed: 7,
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
          tickets: [chip(TICKET), chip(TICKET2)],
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
  situation: { placed: 2, unassignable: 1, held: 1, criticalNeedsYou: 0, overCapacity: 0, changesToday: 0, componentBlockedWithheld: null, bucketlessDropped: null },
  rails: {
    unassignable: [
      { ticketId: STRANDED, deviceId: 'DEV-9', plantId: '5', plantName: 'Beta Works', poolEmptyReason: 'NO_COVERAGE', failureCycles: null },
    ],
    held: [
      {
        ticketId: HELD,
        deviceId: 'DEV-4',
        plantName: 'Gamma Plant',
        heldUntil: '2026-08-31',
        expectedFrom: null,
        decidedBy: 'zm1',
        failureCycles: null,
      },
    ],
    policyWithheld: { count: 0, itemised: false },
  },
  escalations: [],
  ...over,
});

const impact = {
  result: 'OK' as const,
  action: 'REASSIGN' as const,
  batchId: 'b1',
  plantId: '4',
  plantName: 'Acme Cement',
  ticketIds: [TICKET],
  from: { seId: 'se-1', seName: 'Ramesh K.', committed: 7, after: 6, dailyCapacity: 8, overCapacity: false },
  to: { seId: 'se-2', seName: 'Priya M.', committed: 0, after: 1, dailyCapacity: 8, overCapacity: false },
  rank: null,
  route: { targetScheduleId: null, appendedAsStop: 1, joinsExistingStop: false, reordersExistingStops: false as const },
  conflicts: { onSite: [], deferred: [] },
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
  vi.mocked(apiDispatchChangesToday).mockResolvedValue({
    operatingDay: '2026-08-28',
    zoneId: '7',
    counts: { adds: 0, removes: 0, swaps: 0, total: 0 },
    changes: [],
  } as DispatchChangesTodayView);
  vi.mocked(apiCandidates).mockResolvedValue({ date: '2026-08-28', plants: [] });
  vi.mocked(apiTicketDetail).mockResolvedValue({ lifecycle: [] } as never);
  vi.mocked(apiTicketAttempts).mockResolvedValue({
    ticketId: TICKET,
    threshold: 3,
    countableAttempts: 0,
    hasSubmission: false,
    isSpecial: false,
    attempts: [],
  });
  vi.mocked(apiDispatchTicketTrace).mockRejectedValue(new Error('no trace'));
  vi.mocked(getDispatchInFlight).mockResolvedValue([]);
  vi.mocked(apiZoneEngineers).mockResolvedValue([
    { engineerId: 'se-1', name: 'Ramesh K.', coverageType: 'DEDICATED', zoneId: '7', committed: 7, dailyCapacity: 8 },
    { engineerId: 'se-2', name: 'Priya M.', coverageType: 'FLOATING', zoneId: '7', committed: 0, dailyCapacity: 8 },
  ] as never);
  vi.mocked(apiOverridePreview).mockResolvedValue(impact as never);
  vi.mocked(apiOverrideBatch).mockResolvedValue({
    result: 'OK',
    batchId: 'b1',
    scheduleId: '9',
    seId: 'se-2',
    status: 'OVERRIDDEN',
  });
});

afterEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

/** Open the Inspector on a placed ticket and start a reassign. */
const openReassign = async (user: ReturnType<typeof userEvent.setup>) => {
  renderAt(`/dispatch/today?sel=ticket:${TICKET}`);
  await screen.findByTestId('inspector-actions');
  await user.click(screen.getByTestId('action-reassign'));
};

describe('Phase 2.3 — the six override controls, absorbed into the Inspector', () => {
  it('offers the override actions on a placed ticket, through the endpoint that already owns them', async () => {
    const user = userEvent.setup();
    await openReassign(user);

    await user.selectOptions(await screen.findByTestId('action-target-se'), 'se-2');
    await user.type(screen.getByTestId('action-reason'), 'customer escalation');
    await user.click(screen.getByTestId('action-confirm'));

    await waitFor(() =>
      expect(apiOverrideBatch).toHaveBeenCalledWith('b1', {
        action: 'REASSIGN',
        ticketId: TICKET,
        newSeId: 'se-2',
        reasonCode: 'customer escalation',
      }),
    );
  });

  /** `OverrideCommand` makes `reasonCode` mandatory on all six. An override with no stated why is not
   *  an override, and the gate belongs on the button rather than in a server error. */
  it('will not commit without a reason', async () => {
    const user = userEvent.setup();
    await openReassign(user);

    await user.selectOptions(await screen.findByTestId('action-target-se'), 'se-2');
    expect(screen.getByTestId('action-confirm')).toBeDisabled();

    await user.type(screen.getByTestId('action-reason'), 'x');
    expect(screen.getByTestId('action-confirm')).toBeEnabled();
  });

  it('shows the two-lane impact before the confirm, keyed on the target and not on the reason', async () => {
    const user = userEvent.setup();
    await openReassign(user);

    await user.selectOptions(await screen.findByTestId('action-target-se'), 'se-2');
    await user.type(screen.getByTestId('action-reason'), 'ab');
    await waitFor(() => expect(apiOverridePreview).toHaveBeenCalled());

    const callsAfterTyping = vi.mocked(apiOverridePreview).mock.calls.length;
    await user.type(screen.getByTestId('action-reason'), 'cdef');
    // Typing more of the justification must not fire a projection per keystroke.
    expect(vi.mocked(apiOverridePreview).mock.calls.length).toBe(callsAfterTyping);
  });

  /** #258 Q2 — the preview is information, not a gate. A projection that fails (including the
   *  deliberate NOT_PROJECTABLE refusal) loses the panel and keeps the Confirm. */
  it('keeps the Confirm when the projection fails', async () => {
    const user = userEvent.setup();
    vi.mocked(apiOverridePreview).mockRejectedValue(new Error('NOT_PROJECTABLE'));
    await openReassign(user);

    await user.selectOptions(await screen.findByTestId('action-target-se'), 'se-2');
    await user.type(screen.getByTestId('action-reason'), 'still going ahead');

    await waitFor(() => expect(apiOverridePreview).toHaveBeenCalled());
    expect(screen.getByTestId('action-confirm')).toBeEnabled();
  });

  /**
   * The gate that matters most, and the one the old shared client got wrong: both conflicts are 409s
   * answered by resending with `confirm: true`, but they are *different facts*. A deferral conflict
   * used to print "SE is ON_SITE on affected work" — true of neither the engineer nor the ticket.
   */
  it('renders a deferral conflict as a deferral, not as an ON_SITE conflict', async () => {
    const user = userEvent.setup();
    vi.mocked(apiOverrideBatch).mockRejectedValueOnce(
      new OverrideConflictError({
        code: 'CONFLICT_DEFERRED',
        message: 'Affected work is held to a future vehicle-return date.',
        ticketIds: [TICKET],
      }),
    );
    await openReassign(user);

    await user.selectOptions(await screen.findByTestId('action-target-se'), 'se-2');
    await user.type(screen.getByTestId('action-reason'), 'urgent');
    await user.click(screen.getByTestId('action-confirm'));

    const conflict = await screen.findByTestId('action-conflict');
    expect(conflict).toHaveTextContent(/held to a future vehicle-return date/i);
    expect(conflict).not.toHaveTextContent(/ON_SITE/);
  });

  it('renders an ON_SITE conflict as ON_SITE, and resends with confirm on the second gate', async () => {
    const user = userEvent.setup();
    vi.mocked(apiOverrideBatch).mockRejectedValueOnce(
      new OverrideConflictError({
        code: 'OVERRIDE_ON_SITE_CONFLICT',
        message: 'SE holds ON_SITE on affected work.',
        ticketIds: [TICKET],
      }),
    );
    await openReassign(user);

    await user.selectOptions(await screen.findByTestId('action-target-se'), 'se-2');
    await user.type(screen.getByTestId('action-reason'), 'urgent');
    await user.click(screen.getByTestId('action-confirm'));

    const conflict = await screen.findByTestId('action-conflict');
    expect(conflict).toHaveTextContent(/ON_SITE/);

    await user.click(screen.getByTestId('action-conflict-confirm'));
    await waitFor(() =>
      expect(apiOverrideBatch).toHaveBeenLastCalledWith('b1', expect.objectContaining({ confirm: true })),
    );
  });

  /** §8.4 — without this, an override commits and three of four regions keep showing the old plan. */
  it('invalidates the single lifted fetch after a committed override', async () => {
    const user = userEvent.setup();
    await openReassign(user);

    const before = vi.mocked(apiDispatchToday).mock.calls.length;
    await user.selectOptions(await screen.findByTestId('action-target-se'), 'se-2');
    await user.type(screen.getByTestId('action-reason'), 'done');
    await user.click(screen.getByTestId('action-confirm'));

    await waitFor(() => expect(vi.mocked(apiDispatchToday).mock.calls.length).toBeGreaterThan(before));
  });

  /** The one place multi-select exists in the product — `SPLIT_BATCH` takes `ticketIds[]`. */
  it('splits a stop with a ticket selection, the only multi-select in the Console', async () => {
    const user = userEvent.setup();
    renderAt('/dispatch/today?sel=stop:b1');

    await user.click(await screen.findByTestId('action-split'));
    await user.selectOptions(await screen.findByTestId('action-target-se'), 'se-2');
    await user.click(screen.getByLabelText(`Move ticket ${TICKET2}`));
    await user.type(screen.getByTestId('action-reason'), 'balance the lane');
    await user.click(screen.getByTestId('action-confirm'));

    await waitFor(() =>
      expect(apiOverrideBatch).toHaveBeenCalledWith('b1', {
        action: 'SPLIT_BATCH',
        ticketIds: [TICKET2],
        newSeId: 'se-2',
        reasonCode: 'balance the lane',
      }),
    );
  });

  it('never offers an engineer as a target for their own work', async () => {
    const user = userEvent.setup();
    await openReassign(user);

    const picker = await screen.findByTestId('action-target-se');
    expect(within(picker).queryByText(/Ramesh/)).not.toBeInTheDocument();
    expect(within(picker).getByText(/Priya/)).toBeInTheDocument();
  });
});

describe('Phase 2.4 — assign, hold and release, on ids already in the payload', () => {
  /**
   * The legal-set rule, tested where it actually bites. `assignTicket` refuses an already-assigned
   * ticket, so an Assign button on placed work would be a button that always fails; and a placed
   * ticket has a batch, so override is its door. Neither is a preference — both follow from the data.
   */
  it('offers the override actions on placed work, and not Assign', async () => {
    renderAt(`/dispatch/today?sel=ticket:${TICKET}`);
    await screen.findByTestId('inspector-actions');

    expect(screen.getByTestId('action-reassign')).toBeInTheDocument();
    expect(screen.getByTestId('action-defer')).toBeInTheDocument();
    expect(screen.getByTestId('action-remove')).toBeInTheDocument();
    // Not disabled — absent. `assignTicket` refuses an already-assigned ticket, so an Assign here
    // would be a control that always fails.
    expect(screen.queryByTestId('action-assign')).not.toBeInTheDocument();
  });

  it('offers Assign and Hold on unplaced work, and no override actions', async () => {
    renderAt(`/dispatch/today?sel=ticket:${STRANDED}`);
    await screen.findByTestId('inspector-actions');

    expect(screen.getByTestId('action-assign')).toBeInTheDocument();
    expect(screen.getByTestId('action-hold')).toBeInTheDocument();
    // There is no batch holding this ticket, so there is nothing to override.
    expect(screen.queryByTestId('action-reassign')).not.toBeInTheDocument();
    expect(screen.queryByTestId('action-remove')).not.toBeInTheDocument();
  });

  it('assigns unplaced work to an engineer', async () => {
    const user = userEvent.setup();
    vi.mocked(apiAssignTicket).mockResolvedValue({
      result: 'OK',
      scheduleId: '9',
      batchId: 'b2',
      ticketId: STRANDED,
      seId: 'se-2',
    });
    renderAt(`/dispatch/today?sel=ticket:${STRANDED}`);

    await user.click(await screen.findByTestId('action-assign'));
    await user.selectOptions(await screen.findByTestId('assign-target-se'), 'se-2');
    await user.click(screen.getByTestId('assign-confirm'));

    await waitFor(() => expect(apiAssignTicket).toHaveBeenCalledWith(STRANDED, 'se-2', undefined));
  });

  /**
   * The backend deliberately returns this refusal as a populated 409 so the operator can see the
   * return date they would be overwriting. The client used to throw it away as `REQUEST_FAILED_409`,
   * which made both declared refusal variants unreachable.
   */
  it('shows the reported return date when a hold is refused, instead of a bare failure', async () => {
    const user = userEvent.setup();
    vi.mocked(placeHold).mockResolvedValue({
      result: 'CONFLICT_VEHICLE_UNAVAILABLE',
      expectedFrom: '2026-09-04',
      reportId: 'vu-1',
      message: 'The vehicle is reported unavailable until 2026-09-04.',
    });
    renderAt(`/dispatch/today?sel=ticket:${STRANDED}`);

    await user.click(await screen.findByTestId('action-hold'));
    await user.type(screen.getByTestId('hold-until'), '2026-09-01');
    await user.type(screen.getByTestId('hold-reason'), 'awaiting part');
    await user.click(screen.getByTestId('hold-confirm'));

    const conflict = await screen.findByTestId('hold-conflict');
    expect(conflict).toHaveTextContent('2026-09-04');
    expect(conflict).not.toHaveTextContent(/REQUEST_FAILED/);
  });

  /** A held ticket's only live action. Offering "Hold" again would invite overwriting the return date
   *  the operator already chose, without showing it to them. */
  it('offers only release on a held ticket, and says the ticket re-enters the next run', async () => {
    const user = userEvent.setup();
    vi.mocked(releaseHold).mockResolvedValue({ result: 'OK', ticketId: HELD });
    renderAt(`/dispatch/today?sel=ticket:${HELD}`);

    const band = await screen.findByTestId('inspector-actions');
    expect(within(band).getByText(/held until 2026-08-31/i)).toBeInTheDocument();
    expect(within(band).queryByTestId('action-hold')).not.toBeInTheDocument();
    expect(band).toHaveTextContent(/re-enters the very next run/i);

    await user.click(screen.getByTestId('action-release-hold'));
    await waitFor(() => expect(releaseHold).toHaveBeenCalledWith(HELD));
  });

  /** Phase 2.4 — a critical escalation is resolved in the Inspector rather than two pages away. */
  it('resolves a critical escalation in place', async () => {
    const user = userEvent.setup();
    vi.mocked(apiDispatchToday).mockResolvedValue(
      view({
        escalations: [
          {
            insertionId: 'i1',
            ticketId: STRANDED,
            slaBucket: 'CRITICAL',
            createdAt: '2026-08-28T11:42:00Z',
            insertionType: 'SYSTEM_CRITICAL',
            assignedSeId: null,
            assignedSeName: null,
          },
        ],
      }),
    );
    renderAt('/dispatch/today');

    await user.click(await screen.findByTestId(`escalation-resolve-${STRANDED}`));

    const band = await screen.findByTestId('inspector-actions');
    expect(within(band).getByTestId('action-assign')).toBeInTheDocument();
  });
});

describe('Phase 2.1 — Run Now is a Zonal Manager control now that the clamp exists (#291)', () => {
  it('renders Run Now for a Zonal Manager', async () => {
    renderAt('/dispatch/today');
    expect(await screen.findByTestId('console-run-now')).toBeInTheDocument();
  });
});
