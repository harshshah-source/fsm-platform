import type { SessionView } from '@fsm/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssignableWorkView } from '../src/api/assignWork';
import type { CandidatesView } from '../src/api/candidates';
import type { DispatchChangesTodayView, DispatchTodayView } from '../src/api/dispatchToday';
import { AuthProvider } from '../src/auth/AuthProvider';
import TodaysDispatchPage from '../src/pages/dispatch/TodaysDispatchPage';

/**
 * **Scheduler Console — Phase 4: Assign mode.**
 *
 * The last phase, approved under §14 **D2** with §3.4's *mixed-commitment rule* as a written
 * condition, and scoped by §14 **D4**, answered on 2026-08-28: the Console's pool is **zone-scoped**
 * and the standalone `/assign` route keeps the pan-India case.
 *
 * Three things are being asserted here and each of them is a correctness rule, not a layout
 * preference:
 *
 * 1. **Scope (D4).** `GET /schedules/assignable-work` answers *pan-India* for a CSM or Operations
 *    Head who is not acting in a zone. Rendered beside a one-zone deck that is the same failure B5
 *    fixed for the attention band, one region over — two panes on one screen disagreeing about which
 *    zone the operator is standing in. The Console narrows it to the zone the deck is showing.
 * 2. **The mixed-commitment rule (§3.4).** Draft work and committed work may share a screen, a frame
 *    and a grammar. They may **never share a lane object**. `/assign` chips write nothing on
 *    placement; Console lane chips write immediately. The two lane vocabularies are therefore never
 *    on screen at once — which the board and the draft having collided on `data-testid="lane-*"`
 *    should have made obvious long before a rule was written down.
 * 3. **The roster (D4, second half).** `GET /schedules/engineers` is *also* pan-India for a CSM. The
 *    Console must not call it: it already holds the zone's active roster, with the committed load
 *    from the same definition the recommender enforces against, in the one lifted payload.
 */

vi.mock('../src/api/dispatchToday', async () => {
  const actual = await vi.importActual('../src/api/dispatchToday');
  return { ...actual, apiDispatchToday: vi.fn(), apiDispatchChangesToday: vi.fn() };
});
vi.mock('../src/api/assignWork', async () => {
  const actual = await vi.importActual('../src/api/assignWork');
  return { ...actual, apiAssignableWork: vi.fn() };
});
vi.mock('../src/api/candidates', async () => {
  const actual = await vi.importActual('../src/api/candidates');
  return { ...actual, apiCandidates: vi.fn() };
});
vi.mock('../src/api/schedules', async () => {
  const actual = await vi.importActual('../src/api/schedules');
  return {
    ...actual,
    apiZoneEngineers: vi.fn(),
    apiAssignableTickets: vi.fn(),
    apiAssignBatch: vi.fn(),
    apiDistributePreview: vi.fn(),
  };
});
vi.mock('../src/api/dashboard', async () => {
  const actual = await vi.importActual('../src/api/dashboard');
  return { ...actual, apiActionRequired: vi.fn() };
});
vi.mock('../src/api/dispatchSchedule', async () => {
  const actual = await vi.importActual('../src/api/dispatchSchedule');
  return { ...actual, getDispatchInFlight: vi.fn(), getDispatchSchedule: vi.fn() };
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
const { apiAssignableWork } = await import('../src/api/assignWork');
const { apiCandidates } = await import('../src/api/candidates');
const { apiZoneEngineers, apiAssignableTickets, apiAssignBatch } = await import('../src/api/schedules');
const { apiActionRequired } = await import('../src/api/dashboard');
const { getDispatchInFlight, getDispatchSchedule } = await import('../src/api/dispatchSchedule');
const { listZones } = await import('../src/api/org');

const CSM: SessionView = { user_id: 'csm1', role: 'CENTRAL_SERVICE_MANAGER', zone_id: null, acted_as_role: null };
const ZM: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 7, acted_as_role: null };

const view = (over: Partial<DispatchTodayView> = {}): DispatchTodayView => ({
  operatingDay: '2026-08-28',
  chronicThreshold: 3,
  agingThresholdHours: 4,
  zone: { zoneId: '7', name: 'North Zone' },
  run: { runId: '42', status: 'SUCCESS', trigger: 'CRON', startedAt: '2026-08-28T05:00:00Z', finishedAt: null },
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
          batchId: 'b-1',
          stopSequence: 1,
          plantId: 'p-1',
          plantName: 'Kotputli Works',
          status: 'AUTO_ASSIGNED',
          runId: '42',
          tickets: [
            {
              ticketId: 'tk-committed',
              sortOrder: 1,
              slaBucket: 'CRITICAL',
              companyTier: 'GOLD',
              addSource: null,
              addedBy: null,
              addReason: null,
              coverageTypeAtAssign: 'DEDICATED',
              systemPlaced: true,
              returnDueToday: false,
              failureCycles: 0,
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
  ],
  situation: {
    placed: 1,
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
  operatingDay: '2026-08-28',
  zoneId: '7',
  counts: { adds: 0, removes: 0, swaps: 0, total: 0 },
  changes: [],
});

/**
 * A pan-India pool exactly as the backend answers it for a CSM who is not acting in a zone: two
 * companies, three plants, and only **one** of them in the zone the Console is showing.
 */
const POOL: AssignableWorkView = {
  date: '2026-08-28',
  totals: { openUnassigned: 21, criticalCount: 6, heldCount: 4, plants: 3 },
  companies: [
    {
      companyId: 'c-1',
      companyName: 'UltraTech',
      plants: [
        {
          plantId: 'p-far',
          plantName: 'Chennai Works',
          zoneId: '9',
          openUnassigned: 12,
          totalDevices: 40,
          criticalCount: 4,
          oldestInactivityHours: 61,
          heldCount: 3,
        },
        {
          plantId: 'p-near',
          plantName: 'Kotputli Works',
          zoneId: '7',
          openUnassigned: 5,
          totalDevices: 38,
          criticalCount: 2,
          oldestInactivityHours: 30,
          heldCount: 1,
        },
      ],
    },
    {
      companyId: 'c-2',
      companyName: 'Acme Cement',
      plants: [
        {
          plantId: 'p-other-zone',
          plantName: 'Pali Works',
          zoneId: '9',
          openUnassigned: 4,
          totalDevices: 10,
          criticalCount: 0,
          oldestInactivityHours: null,
          heldCount: 0,
        },
      ],
    },
  ],
};

const CANDIDATES: CandidatesView = {
  date: '2026-08-28',
  plants: [
    {
      plantId: 'p-near',
      plantName: 'Kotputli Works',
      zoneId: '7',
      candidates: [
        {
          seId: 'se-1',
          name: 'Ramesh K.',
          coverageType: 'DEDICATED',
          tierRank: 1,
          verdict: 'PASSED',
          dropReason: null,
          committed: 2,
          dailyCapacity: 8,
          availabilityStatus: 'AVAILABLE',
          kitComplete: true,
          missingKit: [],
        },
      ],
    },
  ],
};

const renderAt = (entry: string, session: SessionView = CSM) =>
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
  vi.mocked(apiAssignableWork).mockResolvedValue(POOL);
  vi.mocked(apiCandidates).mockResolvedValue(CANDIDATES);
  vi.mocked(apiAssignableTickets).mockResolvedValue([{ plantId: 'p-near', ticketIds: ['tk-1', 'tk-2'] }]);
  vi.mocked(apiAssignBatch).mockResolvedValue({
    reasonCode: 'why',
    lanes: [{ seId: 'se-1', result: 'OK', assigned: 2, alreadyAssigned: 0, skipped: [] }],
  } as never);
  vi.mocked(apiZoneEngineers).mockResolvedValue([]);
  vi.mocked(apiActionRequired).mockResolvedValue([]);
  vi.mocked(getDispatchInFlight).mockResolvedValue([]);
  vi.mocked(getDispatchSchedule).mockRejectedValue(new Error('forbidden'));
  vi.mocked(listZones).mockResolvedValue([{ zoneId: 7, name: 'North Zone' }] as never);
});

afterEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('Phase 4.1 — Assign mode is a mode of the Console, reached and left from the board', () => {
  it('is off by default, and entering it is reflected in the URL so the state is shareable', async () => {
    const user = userEvent.setup();
    renderAt('/dispatch/today?zoneId=7');

    expect(await screen.findByTestId('console-board')).toBeInTheDocument();
    expect(screen.queryByTestId('console-assign-mode')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('assign-mode-toggle'));

    expect(await screen.findByTestId('console-assign-mode')).toBeInTheDocument();
    expect(screen.getByTestId('assign-mode-exit')).toBeInTheDocument();
  });

  it('does not fetch the pool until the operator actually asks for it', async () => {
    renderAt('/dispatch/today?zoneId=7');
    await screen.findByTestId('console-board');
    // The Console opens on the board. Fetching a pan-India pool nobody asked for on every open is a
    // read the operator never sees and, for an Operations Head, a large one.
    expect(apiAssignableWork).not.toHaveBeenCalled();
  });

  it('leaves Assign mode and puts the committed board back', async () => {
    const user = userEvent.setup();
    renderAt('/dispatch/today?zoneId=7&assign=1');

    await screen.findByTestId('console-assign-mode');
    await user.click(screen.getByTestId('assign-mode-exit'));

    expect(await screen.findByTestId('console-board')).toBeInTheDocument();
    expect(screen.queryByTestId('console-assign-mode')).not.toBeInTheDocument();
  });
});

describe('Phase 4.2 — the mixed-commitment rule (§3.4)', () => {
  /**
   * The rule, stated as the only thing that can be tested about it: the two lane vocabularies are
   * never on screen together. A committed lane (`lane-se-1`, written the moment it changed) and a
   * draft lane (`lane-1`, which writes nothing until commit) would otherwise be two identically
   * shaped objects on one screen meaning opposite things.
   */
  it('never shows a committed lane and a draft lane at the same time', async () => {
    const user = userEvent.setup();
    renderAt('/dispatch/today?zoneId=7&assign=1');

    const region = await screen.findByTestId('console-assign-mode');
    // The committed vocabulary is gone: no board, and no `lane-<seId>` for the engineer who has one.
    expect(screen.queryByTestId('console-board')).not.toBeInTheDocument();
    expect(screen.queryByTestId('lane-se-1')).not.toBeInTheDocument();

    // …and it stays gone once the draft actually holds a lane for that *same* engineer. This is the
    // stronger form of the assertion the numbered-lane version could only approximate: se-1 now has
    // work in both vocabularies over the course of one session, and the two names never coincide.
    await within(region).findByTestId('pool-plant-c-1-p-near');
    await user.click(within(region).getByLabelText('Select Kotputli Works for UltraTech'));
    await user.click(within(region).getByTestId('assign-target-se-1'));

    expect(await within(region).findByTestId('draft-lane-se-1')).toBeInTheDocument();
    expect(screen.queryByTestId('lane-se-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('console-board')).not.toBeInTheDocument();
  });

  /**
   * A selection is a *committed* object — the Inspector's whole subject. Carrying one into a drafting
   * surface would leave an Actions band offering immediate writes beside lanes that write nothing.
   */
  it('drops a committed selection on entering, and takes the Inspector with it', async () => {
    const user = userEvent.setup();
    renderAt('/dispatch/today?zoneId=7&sel=engineer:se-1');

    expect(await screen.findByTestId('console-inspector')).toBeInTheDocument();
    await user.click(screen.getByTestId('assign-mode-toggle'));

    await screen.findByTestId('console-assign-mode');
    expect(screen.queryByTestId('console-inspector')).not.toBeInTheDocument();
    expect(screen.queryByTestId('console-inspector-empty')).not.toBeInTheDocument();
  });

  /**
   * The draft is client state narrowed to one zone's pool. Nothing about a zone change invalidates
   * it on its own, so a CSM could draft North's plants, switch the picker to West, and be one Commit
   * away from handing out North's work under West's heading — the D4 defect, arriving by the back
   * door after D4 had been implemented at the front.
   */
  it('leaves Assign mode when the zone changes, rather than carrying the draft into it', async () => {
    const user = userEvent.setup();
    vi.mocked(listZones).mockResolvedValue([
      { zoneId: 7, name: 'North Zone' },
      { zoneId: 9, name: 'West Zone' },
    ] as never);
    renderAt('/dispatch/today?zoneId=7&assign=1', CSM);

    const region = await screen.findByTestId('console-assign-mode');
    // The pool is a fetch of its own: waiting on the region alone races its first render.
    await within(region).findByTestId('pool-plant-c-1-p-near');
    await user.click(within(region).getByLabelText('Select Kotputli Works for UltraTech'));
    await user.click(within(region).getByTestId('assign-target-se-1'));
    await within(region).findByTestId('draft-lane-se-1');

    await user.selectOptions(await screen.findByLabelText(/zone/i), '9');

    await waitFor(() => expect(screen.queryByTestId('console-assign-mode')).not.toBeInTheDocument());
  });

  /**
   * The claim survives the recomposition; the *form* of it changed deliberately. "Nothing is written
   * until you commit — this draft lives in this browser tab only" explained a storage model. The
   * ribbon states the consequence and puts the three populations beside it, which is the same promise
   * in the operator's vocabulary rather than the implementation's.
   */
  it('says out loud that nothing in the draft is written yet', async () => {
    renderAt('/dispatch/today?zoneId=7&assign=1');
    const region = await screen.findByTestId('console-assign-mode');
    expect(within(region).getByTestId('assign-nothing-written')).toHaveTextContent(
      /nothing has changed in the system yet/i,
    );
    expect(within(region).getByText(/written only when you commit, one engineer at a time/i)).toBeInTheDocument();
  });
});

describe('Phase 4.3 — the pool is zone-scoped (D4)', () => {
  it('shows only the zone the deck is showing, out of a pan-India pool', async () => {
    renderAt('/dispatch/today?zoneId=7&assign=1');

    const region = await screen.findByTestId('console-assign-mode');
    expect(within(region).getByTestId('pool-plant-c-1-p-near')).toBeInTheDocument();
    // Both out-of-zone plants are gone — including the busiest row in the payload, which is exactly
    // the one a pan-India pool would have put at the top of a zone's screen.
    expect(within(region).queryByTestId('pool-plant-c-1-p-far')).not.toBeInTheDocument();
    expect(within(region).queryByTestId('pool-plant-c-2-p-other-zone')).not.toBeInTheDocument();
    // A company with nothing left in this zone is not an empty heading.
    expect(within(region).queryByText('Acme Cement')).not.toBeInTheDocument();
  });

  /**
   * The totals are the server's, computed over the pan-India set. Narrowing the rows and keeping the
   * ledger would put "21 unassigned" above five rows totalling five — the ledger is the one number
   * this surface exists to make honest.
   */
  it('re-derives the ledger over the narrowed pool, never the pan-India totals', async () => {
    renderAt('/dispatch/today?zoneId=7&assign=1');

    const region = await screen.findByTestId('console-assign-mode');
    // 5, not the payload's pan-India 21 — on the one surface whose purpose is "how much is left".
    expect(within(region).getByTestId('ledger-open')).toHaveTextContent('5');
    expect(within(region).getByTestId('stage-available')).toHaveTextContent('5');
    expect(within(region).getByTestId('stage-remaining')).toHaveTextContent('5');
  });

  /**
   * `GET /schedules/engineers` is pan-India for a CSM who is not acting in a zone, exactly like the
   * pool. The Console already holds the zone's active roster with its committed load, so calling it
   * would fetch a wider answer to a question already answered — and offer another zone's engineers as
   * lane targets for this zone's work.
   */
  it('takes its engineers from the deck payload and never calls the pan-India roster', async () => {
    renderAt('/dispatch/today?zoneId=7&assign=1');

    const region = await screen.findByTestId('console-assign-mode');
    const target = within(region).getByTestId('assign-target-se-1');
    expect(target).toHaveTextContent(/Ramesh K\./);
    // `2/8` — the deck's own committed figure, not a second count of it.
    expect(target).toHaveTextContent(/2\s*\/\s*8/);
    expect(apiZoneEngineers).not.toHaveBeenCalled();
  });

  it('asks for candidates for a plant in this zone only', async () => {
    renderAt('/dispatch/today?zoneId=7&assign=1');
    await screen.findByTestId('console-assign-mode');
    await waitFor(() => expect(apiCandidates).toHaveBeenCalledWith(['p-near']));
  });
});

describe('Phase 4 — pool → draft → review → commit, and the deck that follows it', () => {
  it('commits the drafted lane and invalidates the one lifted fetch', async () => {
    const user = userEvent.setup();
    renderAt('/dispatch/today?zoneId=7&assign=1');

    const region = await screen.findByTestId('console-assign-mode');
    const openCalls = vi.mocked(apiDispatchToday).mock.calls.length;

    await within(region).findByTestId('pool-plant-c-1-p-near');
    await user.click(within(region).getByLabelText('Select Kotputli Works for UltraTech'));
    // Ticking work and choosing a person is the whole gesture — no lane to open, no dropdown to set.
    await user.click(within(region).getByTestId('assign-target-se-1'));
    await within(region).findByTestId('draft-lane-se-1');
    await user.click(within(region).getByTestId('assign-review'));

    await screen.findByTestId('review-commit-screen');
    expect(screen.getByTestId('review-committing')).toHaveTextContent('2');

    await user.type(screen.getByTestId('review-reason'), 'zone backlog');
    await user.click(screen.getByRole('button', { name: /Commit 2 assignments/i }));

    await waitFor(() =>
      expect(apiAssignBatch).toHaveBeenCalledWith('zone backlog', [{ seId: 'se-1', ticketIds: ['tk-1', 'tk-2'] }]),
    );
    // §8.4 — a write anywhere in the Console invalidates the payload every region reads. The board an
    // operator returns to must already show the work they just handed out.
    await waitFor(() => expect(vi.mocked(apiDispatchToday).mock.calls.length).toBeGreaterThan(openCalls));
  });

  it('serves a ZM the same mode, over their own zone, with no zone picker involved', async () => {
    renderAt('/dispatch/today?assign=1', ZM);
    const region = await screen.findByTestId('console-assign-mode');
    expect(within(region).getByTestId('pool-plant-c-1-p-near')).toBeInTheDocument();
    expect(within(region).queryByTestId('pool-plant-c-1-p-far')).not.toBeInTheDocument();
  });
});
