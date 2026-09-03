import type { SessionView } from '@fsm/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchChangesTodayView, DispatchTodayView } from '../src/api/dispatchToday';
import { AuthProvider } from '../src/auth/AuthProvider';
import TodaysDispatchPage from '../src/pages/dispatch/TodaysDispatchPage';

/**
 * **Scheduler Console — Phase 1** (`docs/audits/scheduler-console-implementation-slice-2026-08-27.md`).
 *
 * Phase 1 makes the built cockpit whole without a single backend change and without overturning a
 * ruling: the zone picker two of three roles could not open the screen without, Run Now where it
 * actually works, board selection driving one Inspector, and the engine's own score breakdown finally
 * rendered instead of discarded.
 *
 * These tests are written against the *reasons* those things exist, not their markup. Where a rule is
 * a correctness rule — hidden-not-disabled, a count that must never become a list, a zero-result that
 * must not read as a failure — the test says so in its name.
 */

vi.mock('../src/api/dispatchToday', async () => {
  const actual = await vi.importActual('../src/api/dispatchToday');
  return { ...actual, apiDispatchToday: vi.fn(), apiDispatchChangesToday: vi.fn() };
});
vi.mock('../src/api/dispatch-runs', async () => {
  const actual = await vi.importActual('../src/api/dispatch-runs');
  return { ...actual, apiDispatchRunDecisions: vi.fn(), apiDispatchTicketTrace: vi.fn() };
});
vi.mock('../src/api/org', async () => {
  const actual = await vi.importActual('../src/api/org');
  return { ...actual, listZones: vi.fn() };
});
vi.mock('../src/api/dispatchSchedule', async () => {
  const actual = await vi.importActual('../src/api/dispatchSchedule');
  return { ...actual, getDispatchInFlight: vi.fn() };
});
vi.mock('../src/api/bulkUnassign', async () => {
  const actual = await vi.importActual('../src/api/bulkUnassign');
  return { ...actual, runDispatch: vi.fn() };
});
vi.mock('../src/api/candidates', async () => {
  const actual = await vi.importActual('../src/api/candidates');
  return { ...actual, apiCandidates: vi.fn() };
});
vi.mock('../src/api/tickets', async () => {
  const actual = await vi.importActual('../src/api/tickets');
  return { ...actual, apiTicketDetail: vi.fn(), apiTicketAttempts: vi.fn() };
});

const { apiDispatchToday, apiDispatchChangesToday } = await import('../src/api/dispatchToday');
const { apiDispatchTicketTrace } = await import('../src/api/dispatch-runs');
const { listZones } = await import('../src/api/org');
const { getDispatchInFlight } = await import('../src/api/dispatchSchedule');
const { runDispatch } = await import('../src/api/bulkUnassign');
const { apiCandidates } = await import('../src/api/candidates');
const { apiTicketDetail, apiTicketAttempts } = await import('../src/api/tickets');

const ZM: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 7, acted_as_role: null };
const CSM: SessionView = { user_id: 'csm1', role: 'CENTRAL_SERVICE_MANAGER', zone_id: null, acted_as_role: null };
const OH: SessionView = { user_id: 'oh1', role: 'OPERATIONS_HEAD', zone_id: null, acted_as_role: null };

const TICKET = '11111111-2222-3333-4444-555555555555';
const HELD = '99999999-8888-7777-6666-555555555555';
const STRANDED = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const view = (over: Partial<DispatchTodayView> = {}): DispatchTodayView => ({
  operatingDay: '2026-08-27',
  chronicThreshold: 3,
  agingThresholdHours: 4,
  zone: { zoneId: '7', name: 'North Zone' },
  run: { runId: '42', status: 'SUCCESS', trigger: 'CRON', startedAt: '2026-08-27T05:00:00Z', finishedAt: null },
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
          tickets: [
            {
              ticketId: TICKET,
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
            },
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
  situation: { placed: 1, unassignable: 1, held: 1, criticalNeedsYou: 0, overCapacity: 0, changesToday: 0, componentBlockedWithheld: null, bucketlessDropped: null },
  rails: {
    unassignable: [
      { ticketId: STRANDED, deviceId: 'DEV-9', plantId: '5', plantName: 'Beta Works', poolEmptyReason: 'NO_COVERAGE', failureCycles: null },
    ],
    held: [
      { ticketId: HELD, deviceId: 'DEV-4', plantName: 'Gamma Plant', heldUntil: '2026-08-29', expectedFrom: null, decidedBy: 'zm1', deferredBy: null, deferredByName: null, deferredReason: null, failureCycles: null },
    ],
    policyWithheld: { count: 5, itemised: false },
  },
  escalations: [],
  ...over,
});

const changes = (): DispatchChangesTodayView => ({
  operatingDay: '2026-08-27',
  zoneId: '7',
  counts: { adds: 0, removes: 0, swaps: 0, total: 0 },
  changes: [],
});

const trace = (scoreBreakdown: Record<string, unknown> | null) => ({
  runId: '42',
  ticketId: TICKET,
  seId: 'se-1',
  scoreBreakdown,
  recStatus: 'SUGGESTED',
  seNames: { 'se-1': 'Ramesh K.' },
  identity: {
    deviceId: 'DEV-1',
    vehicleNo: 'MH-12-AB-1234',
    plantName: 'Acme Cement',
    companyName: 'Acme Ltd',
    transporterName: null,
  },
  trace: {
    chosen: {
      seId: 'se-1',
      coverageType: 'DEDICATED',
      precedenceRank: 1,
      capacityAtDecision: { used: 6, cap: 8 },
      score: 0.82,
      plannerBias: false,
      clusterSeed: false,
    },
    candidatesTotal: 3,
    runnersUp: [],
    dropCounts: {},
    poolEmptyReason: null,
    failureCycles: null,
    deviceId: '869645080787056',
    vehicleNo: 'MH-12-AB-3456',
    companyName: 'Northbound Cement',
    transporterName: 'Sharma Logistics',
    inactivityHours: 18,
    assignedAt: '2026-08-28T05:30:00Z',
    troubleshootingStarted: false,
    actionStatus: 'NOT_STARTED' as const,
    scoreDegenerate: false,
    notEnforcedFilters: [],
  },
});

const renderAt = (entry: string, session: SessionView) =>
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
  vi.mocked(listZones).mockResolvedValue([
    { zoneId: 7, name: 'North Zone' },
    { zoneId: 8, name: 'West Zone' },
  ] as never);
  vi.mocked(getDispatchInFlight).mockResolvedValue([]);
  vi.mocked(apiCandidates).mockResolvedValue({ date: '2026-08-27', plants: [] });
  vi.mocked(apiTicketDetail).mockResolvedValue({ lifecycle: [] } as never);
  vi.mocked(apiTicketAttempts).mockResolvedValue({
    ticketId: TICKET,
    threshold: 3,
    countableAttempts: 0,
    hasSubmission: false,
    isSpecial: false,
    attempts: [],
  });
  vi.mocked(apiDispatchTicketTrace).mockResolvedValue(trace(null) as never);
});

afterEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 1.1 — the zone picker
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('Phase 1.1 — the zone picker (slice C4)', () => {
  /**
   * The hole this closes: `GET /dispatch/today` refuses to guess a zone for a multi-zone role, so a
   * CSM or OH opening the primary screen without a hand-crafted URL got `400 ZONE_REQUIRED`. Two of
   * the surface's three primary users could not open it at all.
   */
  it('a CSM with no zone chosen gets an explicit chooser, never a fabricated fleet summary', async () => {
    renderAt('/dispatch/today', CSM);

    expect(await screen.findByTestId('console-choose-zone')).toBeInTheDocument();
    // No aggregate read exists. Anything numeric here would be invented, so the deck must not load.
    expect(apiDispatchToday).not.toHaveBeenCalled();
    expect(screen.queryByTestId('console-people-rail')).not.toBeInTheDocument();
  });

  it('a CSM who picks a zone gets that zone’s deck, and it is remembered for next time', async () => {
    const user = userEvent.setup();
    renderAt('/dispatch/today', CSM);

    const picker = await screen.findByTestId('console-zone-picker');
    await user.selectOptions(picker, '8');

    await waitFor(() => expect(apiDispatchToday).toHaveBeenCalledWith('8'));
    expect(localStorage.getItem('fsm.console.lastZone')).toBe('8');
  });

  it('a returning CSM lands on the zone they last looked at rather than the chooser', async () => {
    localStorage.setItem('fsm.console.lastZone', '8');
    renderAt('/dispatch/today', CSM);

    await waitFor(() => expect(apiDispatchToday).toHaveBeenCalledWith('8'));
    expect(screen.queryByTestId('console-choose-zone')).not.toBeInTheDocument();
  });

  /** UI§4.4 — hide, don't disable. A picker with one unchangeable option teaches nothing, and
   *  `GET /org/zones` 403s for a ZM anyway, so there is no list to render even if we wanted one. */
  it('a Zonal Manager gets no zone picker at all — hidden, not disabled', async () => {
    renderAt('/dispatch/today', ZM);

    await screen.findByTestId('lane-se-1');
    expect(screen.queryByTestId('console-zone-picker')).not.toBeInTheDocument();
    expect(listZones).not.toHaveBeenCalled();
    // And the ZM's own deck loads with no zone named — the backend resolves it from their token.
    expect(apiDispatchToday).toHaveBeenCalledWith(undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 1.2 — Run Now
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('Phase 1.2 — Run Now on the Console (slice C3)', () => {
  /**
   * What shipped as "Run-dispatch relocated" was a `<Link to="/bulk-unassign">`, and `/bulk-unassign`
   * is `OPERATIONS_HEAD`-only with a redirect miss path. For a ZM and a CSM the button silently
   * bounced them to the dashboard.
   */
  it('is a real trigger, not a link to an Operations-Head-only page', async () => {
    renderAt('/dispatch/today?zoneId=7', OH);

    expect(await screen.findByTestId('console-run-now')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /run dispatch/i })).not.toBeInTheDocument();
  });

  it('warns that engineers are notified before the run is confirmed, not after', async () => {
    const user = userEvent.setup();
    renderAt('/dispatch/today?zoneId=7', OH);

    await user.click(await screen.findByTestId('console-run-now'));

    const warning = screen.getByTestId('run-now-notifies-warning');
    expect(warning).toHaveTextContent(/engineers are notified/i);
    expect(warning).toHaveTextContent(/phones/i);
  });

  /**
   * The engine only considers work that is OPEN *and* UNASSIGNED, so a second press legitimately
   * places nothing. Without a designed zero state this control teaches managers the scheduler is
   * broken.
   */
  it('renders a designed zero-result state that explains itself, not a bare 0', async () => {
    const user = userEvent.setup();
    vi.mocked(runDispatch).mockResolvedValue({
      result: 'OK',
      summary: { zones: 1, schedules: 0, tickets: 0, errors: [], runId: '43' },
    });
    renderAt('/dispatch/today?zoneId=7', OH);

    await user.click(await screen.findByTestId('console-run-now'));
    await user.click(screen.getByTestId('run-now-confirm'));

    const zero = await screen.findByTestId('run-now-zero-result');
    expect(zero).toHaveTextContent(/no new assignments/i);
    expect(zero).toHaveTextContent(/open/i);
    expect(zero).toHaveTextContent(/unassigned/i);
  });

  it('a completed run invalidates the one lifted fetch, so the board cannot show stale state', async () => {
    const user = userEvent.setup();
    vi.mocked(runDispatch).mockResolvedValue({
      result: 'OK',
      summary: { zones: 1, schedules: 2, tickets: 3, errors: [], runId: '43' },
    });
    renderAt('/dispatch/today?zoneId=7', OH);

    await screen.findByTestId('console-run-now');
    const before = vi.mocked(apiDispatchToday).mock.calls.length;

    await user.click(screen.getByTestId('console-run-now'));
    await user.click(screen.getByTestId('run-now-confirm'));

    await screen.findByTestId('run-now-result');
    expect(vi.mocked(apiDispatchToday).mock.calls.length).toBeGreaterThan(before);
  });

  it('surfaces the populated 409 when a run is already in flight, rather than a generic failure', async () => {
    const user = userEvent.setup();
    vi.mocked(runDispatch).mockResolvedValue({
      result: 'ALREADY_RUNNING',
      message: 'A dispatch run for North Zone started at 05:00 by the scheduler.',
    });
    renderAt('/dispatch/today?zoneId=7', OH);

    await user.click(await screen.findByTestId('console-run-now'));
    await user.click(screen.getByTestId('run-now-confirm'));

    expect(await screen.findByTestId('run-now-refused')).toHaveTextContent(/started at 05:00/i);
  });

  /**
   * **Updated by Phase 2.1.** This asserted the control was *absent* for a ZM, which was right while
   * the endpoint was CSM/OH-only: rendering it would have offered a button that 403s. #291 widened the
   * role list **together with** the server-side zone clamp, so the correct assertion is now the
   * opposite one — a ZM can reach it. The pairing is what the decision record exists to protect, and
   * `dispatch-run-zone-clamp.e2e-spec.ts` is where the clamp itself is pinned.
   */
  it('is available to a Zonal Manager now that the zone clamp ships with it (#291)', async () => {
    renderAt('/dispatch/today', ZM);

    expect(await screen.findByTestId('console-run-now')).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 1.3 — selection and the Inspector
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('Phase 1.3 — one selection, one Inspector', () => {
  it('opens with nothing selected, no Inspector, and the Work Pool holding the rail', async () => {
    renderAt('/dispatch/today', ZM);
    await screen.findByTestId('lane-se-1');
    // No empty placeholder: the Inspector is contextual and absent until something is selected
    // (composition correction §5.5) — the board owns the height instead.
    expect(screen.queryByTestId('console-inspector')).not.toBeInTheDocument();
    // This file's beforeEach sets the operator preference that opens the rail; the collapsed default
    // is the composition suite's subject, not this one's.
    expect(screen.getByTestId('console-work-rail')).toBeInTheDocument();
  });

  it('selecting a ticket chip on the board opens the Inspector on that ticket', async () => {
    const user = userEvent.setup();
    renderAt('/dispatch/today', ZM);

    await user.click(await screen.findByTestId(`chip-${TICKET}`));

    const inspector = await screen.findByTestId('console-inspector');
    expect(inspector).toHaveTextContent(TICKET.slice(0, 8));
    expect(within(inspector).getByText('Acme Cement')).toBeInTheDocument();
  });

  /**
   * The rule that makes the four-region layout coherent: a rail row and a board chip are two doors to
   * the *same* object, so they must produce the same single Inspector — not a second one, and not a
   * different kind of view.
   */
  it('a Work-rail row and a board chip are two doors to one Inspector', async () => {
    const user = userEvent.setup();
    renderAt('/dispatch/today', ZM);

    await user.click(await screen.findByTestId(`chip-${TICKET}`));
    expect(await screen.findByTestId('console-inspector')).toHaveTextContent(TICKET.slice(0, 8));

    await user.click(screen.getByTestId('pool-tab-held'));
    await user.click(screen.getByText('DEV-4'));

    const inspectors = screen.getAllByTestId('console-inspector');
    expect(inspectors).toHaveLength(1);
    expect(inspectors[0]).toHaveTextContent(HELD.slice(0, 8));
  });

  /** Retargeted from the People rail to the personnel column by #295 — one engineer representation,
   *  and clicking it still inspects the engineer rather than diving into their work. */
  it('selecting an engineer in the personnel column inspects that engineer, not their tickets', async () => {
    const user = userEvent.setup();
    renderAt('/dispatch/today', ZM);

    await user.click(await screen.findByTestId('lane-se-2'));

    const inspector = await screen.findByTestId('console-inspector');
    expect(inspector).toHaveTextContent('Priya M.');
    expect(inspector).toHaveTextContent(/floating/i);
  });

  /** Reflected in the URL so a manager can send a colleague the exact thing they are looking at. */
  it('a shared deep link opens on the same object', async () => {
    renderAt(`/dispatch/today?sel=ticket:${TICKET}`, ZM);

    const inspector = await screen.findByTestId('console-inspector');
    expect(inspector).toHaveTextContent(TICKET.slice(0, 8));
  });

  it('a deep link to something this deck does not hold says so, rather than erroring', async () => {
    renderAt('/dispatch/today?sel=stop:not-a-real-batch', ZM);
    expect(await screen.findByTestId('inspector-not-found')).toBeInTheDocument();
  });

  it('Escape clears the selection', async () => {
    const user = userEvent.setup();
    renderAt(`/dispatch/today?sel=ticket:${TICKET}`, ZM);

    await screen.findByTestId('console-inspector');
    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByTestId('console-inspector')).not.toBeInTheDocument());
  });

  /**
   * **Updated by Phase 2.3.** In Phase 1 this asserted a *sentence* stood where the override controls
   * would go — the honest rendering while they lived on `ScheduleDetailPage`, since a greyed-out
   * Reassign would have advertised a working action as broken. The operator's D1 ruling then approved
   * absorbing those controls here, so the placeholder is gone and the real band is asserted instead.
   * `scheduler-console-phase2.test.tsx` owns the behaviour; this keeps Phase 1's structural claim —
   * selecting a ticket produces an Actions band — from silently regressing.
   */
  it('renders the real Actions band on a selected ticket', async () => {
    renderAt(`/dispatch/today?sel=ticket:${TICKET}`, ZM);

    await screen.findByTestId('console-inspector');
    expect(await screen.findByTestId('inspector-actions')).toBeInTheDocument();
    expect(screen.queryByTestId('inspector-actions-pending')).not.toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 1.4 — the per-term score breakdown
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('Phase 1.4 — the score breakdown, served and no longer discarded (slice C7)', () => {
  const breakdown = {
    rankScore: 0.8,
    urgency: 0.5,
    repeatPenalty: 1,
    ageScore: 0,
    distanceScore: 0.25,
    distanceKm: 12.4,
    weights: {
      company_priority_rank: 0.5,
      dispatch_urgency: 0.3,
      repeat_failure_penalty: 0.2,
      distance: 0.4,
      device_age: 0,
      repeat_failure_bonus: 0,
    },
    baseScore: 0.45,
    clusterMultiplier: 1.25,
    score: 0.5625,
    mode: 'DEFICIT',
    weightSetRef: 'ws-2026-08',
  };

  it('renders each weighted term with its value, weight and contribution', async () => {
    vi.mocked(apiDispatchTicketTrace).mockResolvedValue(trace(breakdown) as never);
    renderAt(`/dispatch/today?sel=ticket:${TICKET}`, ZM);

    const panel = await screen.findByTestId('score-breakdown');
    const rank = within(panel).getByTestId('score-term-company_priority_rank');
    expect(rank).toHaveTextContent('0.800'); // the feature
    expect(rank).toHaveTextContent('0.50'); // the weight
    expect(rank).toHaveTextContent('+0.400'); // the contribution
  });

  /** A ticket property in a score that picks an engineer: it shifts every candidate identically and
   *  decides nothing. Showing what it contributed is honest; offering it as a control would not be. */
  it('shows the repeat-failure penalty as a subtraction, and offers no control for it', async () => {
    vi.mocked(apiDispatchTicketTrace).mockResolvedValue(trace(breakdown) as never);
    renderAt(`/dispatch/today?sel=ticket:${TICKET}`, ZM);

    const panel = await screen.findByTestId('score-breakdown');
    expect(within(panel).getByTestId('score-term-repeat_failure_penalty')).toHaveTextContent('−0.200');
    expect(within(panel).queryByRole('slider')).not.toBeInTheDocument();
    expect(within(panel).queryByRole('spinbutton')).not.toBeInTheDocument();
  });

  /** Dropping zero-weight rows would make Catch-up and Steady mode look identical. */
  it('keeps a zero-weighted term visible and says it was not consulted', async () => {
    vi.mocked(apiDispatchTicketTrace).mockResolvedValue(trace(breakdown) as never);
    renderAt(`/dispatch/today?sel=ticket:${TICKET}`, ZM);

    const panel = await screen.findByTestId('score-breakdown');
    expect(within(panel).getByTestId('score-term-device_age')).toHaveTextContent(/not weighted here/i);
  });

  /** UI§34.1 — the engine's enum names never reach a user-facing surface. */
  it('translates the mode enum instead of printing DEFICIT at an operator', async () => {
    vi.mocked(apiDispatchTicketTrace).mockResolvedValue(trace(breakdown) as never);
    renderAt(`/dispatch/today?sel=ticket:${TICKET}`, ZM);

    const panel = await screen.findByTestId('score-breakdown');
    expect(panel).toHaveTextContent(/Catch-up/);
    expect(panel).not.toHaveTextContent(/DEFICIT/);
  });

  /** #267 — never a fabricated 0 km. "Not available" and "zero distance" are different statements. */
  it('renders an unavailable distance as unavailable, never as 0 km', async () => {
    vi.mocked(apiDispatchTicketTrace).mockResolvedValue(
      trace({ ...breakdown, distanceKm: 'NOT_AVAILABLE' }) as never,
    );
    renderAt(`/dispatch/today?sel=ticket:${TICKET}`, ZM);

    const panel = await screen.findByTestId('score-breakdown');
    expect(panel).toHaveTextContent(/not available/i);
    expect(panel).not.toHaveTextContent(/0\.0 km/);
  });

  /** `score = max(baseScore, 0) × clusterMultiplier`, so a negative base makes the total stop
   *  matching the rows. Saying so beats letting an operator conclude the arithmetic is wrong. */
  it('explains the floor when a negative base score makes the total not equal the rows', async () => {
    vi.mocked(apiDispatchTicketTrace).mockResolvedValue(
      trace({ ...breakdown, baseScore: -0.15, score: 0 }) as never,
    );
    renderAt(`/dispatch/today?sel=ticket:${TICKET}`, ZM);

    expect(await screen.findByTestId('score-floored')).toHaveTextContent(/floored at zero/i);
  });

  /** An unassignable decision persists a reason, not a computation. An empty score table for it would
   *  invent a comparison the engine never made. */
  it('renders an unassignable decision as a reason, not as an empty score table', async () => {
    vi.mocked(apiDispatchTicketTrace).mockResolvedValue(
      trace({ reason: 'NO_ELIGIBLE_SE', mode: 'DEFICIT', weightSetRef: 'ws-2026-08' }) as never,
    );
    renderAt(`/dispatch/today?sel=ticket:${TICKET}`, ZM);

    expect(await screen.findByTestId('score-breakdown-none')).toHaveTextContent(/no engineer was eligible/i);
    expect(screen.queryByTestId('score-breakdown')).not.toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The rails, and the contract rules they must not break
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('The Work rail keeps the engine’s contracts', () => {
  /** `{count, itemised: false}` is published contract: those tickets get no recommendation, no row
   *  and no trace, so there is nothing to list and a list would be an invention. */
  it('renders policy-withheld as a count that says it is not itemised, and gives it no tab', async () => {
    renderAt('/dispatch/today', ZM);

    const rail = await screen.findByTestId('console-work-rail');
    expect(within(rail).getByText(/Counted by the run, not itemised/i)).toBeInTheDocument();
    expect(within(rail).queryByTestId('pool-tab-policyWithheld')).not.toBeInTheDocument();
  });

  it('renders a missing pool-empty reason as not recorded, never as a guess', async () => {
    vi.mocked(apiDispatchToday).mockResolvedValue(
      view({
        rails: {
          unassignable: [
            { ticketId: STRANDED, deviceId: 'DEV-9', plantId: '5', plantName: 'Beta Works', poolEmptyReason: null, failureCycles: null },
          ],
          held: [],
          policyWithheld: { count: 0, itemised: false },
        },
      }),
    );
    renderAt('/dispatch/today', ZM);

    const rail = await screen.findByTestId('console-work-rail');
    expect(within(rail).getByText(/reason not recorded/i)).toBeInTheDocument();
  });

  /** Phase 0.3 measured the population behind these chips at zero devices. A filter that can never
   *  light is worse than no filter, so they arrive with Phase 3.4 — absent, not empty. */
  it('does not yet offer Repeated or Inactive filters, whose population Phase 0.3 measured at zero', async () => {
    renderAt('/dispatch/today', ZM);

    const rail = await screen.findByTestId('console-work-rail');
    expect(within(rail).queryByText(/^Repeated$/)).not.toBeInTheDocument();
    expect(within(rail).queryByText(/^Inactive$/)).not.toBeInTheDocument();
  });
});

describe('Find, over the payload already in memory', () => {
  it('filters the board without refetching — every object is already in the one payload', async () => {
    const user = userEvent.setup();
    renderAt('/dispatch/today', ZM);

    await screen.findByTestId('lane-se-1');
    const before = vi.mocked(apiDispatchToday).mock.calls.length;

    await user.type(screen.getByTestId('console-find'), 'Priya');

    await waitFor(() => expect(screen.queryByTestId('lane-se-1')).not.toBeInTheDocument());
    expect(screen.getByTestId('lane-se-2')).toBeInTheDocument();
    expect(vi.mocked(apiDispatchToday).mock.calls.length).toBe(before);
  });

  it('keeps a lane whose engineer misses but whose plant matches — hiding it would hide the match', async () => {
    const user = userEvent.setup();
    renderAt('/dispatch/today', ZM);

    await screen.findByTestId('lane-se-1');
    await user.type(screen.getByTestId('console-find'), 'Acme');

    expect(screen.getByTestId('lane-se-1')).toBeInTheDocument();
    expect(screen.queryByTestId('lane-se-2')).not.toBeInTheDocument();
  });
});
