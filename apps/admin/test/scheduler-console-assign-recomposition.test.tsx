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
 * **Assign mode, recomposed onto the Console's three regions** — the composition correction's §10,
 * built 2026-08-31.
 *
 * §10 was approved with the rest of the correction on 2026-08-28 and then missed: §15's build order
 * carried stages A–E for the *board* and no stage for Assign mode, so `/dispatch/today` was
 * recomposed into `Engineers │ Board │ Work` while `?assign=1` kept swapping in `/assign`'s own
 * three-column page. §10 predicted precisely the complaint that followed:
 *
 * > It must feel like the same product, which is what the instruction asks and what the current
 * > full-region takeover does not quite deliver.
 *
 * What is asserted here is the recomposition **and the rules it had to leave intact**. The rules are
 * in `scheduler-console-phase4.test.tsx`; this file covers what changed:
 *
 * 1. The three regions are the Console's, in the Console's order, and the roster is the lane-target
 *    list rather than a set of `Select engineer…` dropdowns.
 * 2. *Available → draft → after commit* is on the screen as three counted steps, not as prose about
 *    browser tabs.
 * 3. Leaving with work staged **says what is being discarded** — #272 Q2 ruled that a draft dies with
 *    the surface, never that it should die silently.
 * 4. A commit produces a **receipt** that is honest about being per-lane, and cannot be pressed twice.
 * 5. The escalation strip's verbs work inside Assign mode. They were dead controls: the row set
 *    `?sel=` and nothing rendered, because the Inspector is not on screen here. That is the field-ops
 *    P1 §10 says this recomposition fixes.
 * 6. Role behaviour is unchanged for a ZM and for a CSM — every permission is server-side, and the
 *    only client-side difference remains the zone picker.
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
const OH: SessionView = { user_id: 'oh1', role: 'OPERATIONS_HEAD', zone_id: null, acted_as_role: null };

const engineer = (over: Partial<DispatchTodayView['engineers'][number]> = {}) => ({
  seId: 'se-1',
  name: 'Ramesh K.',
  coverageType: 'DEDICATED',
  committed: 2,
  dailyCapacity: 8,
  overCapacity: false,
  availability: 'AVAILABLE',
  scheduleId: '9',
  scheduleStatus: 'ACTIVE',
  stops: [],
  ...over,
});

const view = (over: Partial<DispatchTodayView> = {}): DispatchTodayView => ({
  operatingDay: '2026-08-28',
  chronicThreshold: 3,
  zone: { zoneId: '7', name: 'North Zone' },
  run: { runId: '42', status: 'SUCCESS', trigger: 'CRON', startedAt: '2026-08-28T05:00:00Z', finishedAt: null },
  recovery: null,
  engineers: [
    engineer(),
    engineer({ seId: 'se-2', name: 'Priya S.', coverageType: 'FLOATING', committed: 7, dailyCapacity: 8 }),
  ],
  situation: {
    placed: 0,
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

const POOL: AssignableWorkView = {
  date: '2026-08-28',
  totals: { openUnassigned: 9, criticalCount: 2, heldCount: 0, plants: 2 },
  companies: [
    {
      companyId: 'c-1',
      companyName: 'UltraTech',
      plants: [
        {
          plantId: 'p-near',
          plantName: 'Kotputli Works',
          zoneId: '7',
          openUnassigned: 5,
          totalDevices: 38,
          criticalCount: 2,
          oldestInactivityHours: 30,
          heldCount: 0,
        },
        {
          plantId: 'p-second',
          plantName: 'Neem Works',
          zoneId: '7',
          openUnassigned: 4,
          totalDevices: 12,
          criticalCount: 0,
          oldestInactivityHours: 12,
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

/** Tick a pool row and hand it to an engineer — the whole recomposed gesture, in one helper. */
const stage = async (user: ReturnType<typeof userEvent.setup>, plant: string, company: string, seId: string) => {
  const region = await screen.findByTestId('console-assign-mode');
  // Scoped to the row, because the fixture holds two plants and both carry a "Select …" checkbox.
  const row = await within(region).findByTestId(`pool-plant-${company}-${plant}`);
  await user.click(within(row).getByRole('checkbox'));
  await user.click(within(region).getByTestId(`assign-target-${seId}`));
  return region;
};

beforeEach(() => {
  vi.mocked(apiDispatchToday).mockResolvedValue(view());
  vi.mocked(apiDispatchChangesToday).mockResolvedValue(changes());
  vi.mocked(apiAssignableWork).mockResolvedValue(POOL);
  vi.mocked(apiCandidates).mockResolvedValue(CANDIDATES);
  vi.mocked(apiAssignableTickets).mockResolvedValue([{ plantId: 'p-near', ticketIds: ['tk-1', 'tk-2', 'tk-3', 'tk-4', 'tk-5'] }]);
  vi.mocked(apiAssignBatch).mockResolvedValue({
    reasonCode: 'why',
    lanes: [{ seId: 'se-1', result: 'OK', assigned: 5, alreadyAssigned: 0, skipped: [] }],
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

describe('§10 — Assign mode is composed onto the Console, not dropped into it', () => {
  /**
   * The failure being fixed, stated as a layout invariant: the same three regions in the same order,
   * so that entering the mode changes *what the regions hold*, never where they are.
   */
  it('keeps the Console frame and its three regions, with the roster on the left', async () => {
    renderAt('/dispatch/today?zoneId=7&assign=1');
    const region = await screen.findByTestId('console-assign-mode');

    // The frame is untouched — this is still the same zone, day and run.
    expect(screen.getByTestId('console-top-bar')).toBeInTheDocument();

    // Left: people. Centre: the draft. Right: the pool. The same order as the committed board.
    expect(within(region).getByTestId('assign-people-rail')).toBeInTheDocument();
    expect(within(region).getByTestId('assign-draft-region')).toBeInTheDocument();
    expect(within(region).getByTestId('assign-pool-rail')).toBeInTheDocument();
  });

  /**
   * The single largest cognitive-load item in the old layout: the people who were rows a moment ago
   * came back as `Select engineer…` dropdowns on boxes named *Lane 1*. `placeOnEngineer` always
   * reused an engineer's existing lane, so the number was only ever a label for a row the engineer
   * already owned.
   */
  it('offers engineers as the lane targets, with no lane numbers and no engineer dropdown', async () => {
    const user = userEvent.setup();
    renderAt('/dispatch/today?zoneId=7&assign=1');
    const region = await screen.findByTestId('console-assign-mode');
    await within(region).findByTestId('pool-plant-c-1-p-near');

    expect(within(region).queryByLabelText(/Engineer for lane/i)).not.toBeInTheDocument();
    expect(within(region).queryByRole('button', { name: /Add engineer lane/i })).not.toBeInTheDocument();

    await user.click(within(region).getByLabelText('Select Kotputli Works for UltraTech'));
    // With work ticked, the rail states what the click will do — to whom, and at what cost.
    expect(within(region).getByTestId('assign-target-se-1')).toHaveAccessibleName(
      /Add 1 selected site to Ramesh K\.'s plan/i,
    );

    await user.click(within(region).getByTestId('assign-target-se-1'));
    const lane = await within(region).findByTestId('draft-lane-se-1');
    expect(lane).toHaveTextContent(/Will be added to Ramesh K\./);
  });

  /**
   * The roster row carries the consequence of its own button: `committed → after / capacity`, from
   * the same arithmetic the lane header and the review screen use. One engineer's day is never
   * counted twice on one screen (#269).
   */
  it('shows what the assignment costs the receiving engineer, on the row that performs it', async () => {
    const user = userEvent.setup();
    renderAt('/dispatch/today?zoneId=7&assign=1');
    await stage(user, 'p-near', 'c-1', 'se-1');

    const load = await screen.findByTestId('assign-target-load-se-1');
    expect(load).toHaveTextContent('2 → 7 / 8'); // 2 committed + the plant's 5 assignable
    expect(load).toHaveAttribute('data-over-capacity', 'false');
  });

  /**
   * Over capacity is a **state, never a barrier** (#258 Q2). Priya is at 7/8; five more takes her to
   * 12, and the console says so on the row, on the lane, and in the ribbon's warning cell — and
   * disables nothing.
   */
  it('states an overload rather than preventing it', async () => {
    const user = userEvent.setup();
    renderAt('/dispatch/today?zoneId=7&assign=1');
    await stage(user, 'p-near', 'c-1', 'se-2');

    expect(await screen.findByTestId('assign-target-load-se-2')).toHaveAttribute('data-over-capacity', 'true');
    expect(screen.getByTestId('draft-lane-se-2')).toHaveAttribute('data-over-capacity', 'true');
    expect(screen.getByTestId('summary-over-capacity')).toHaveTextContent('1 engineer over capacity');
    // Nothing is disabled — the commit path stays open.
    expect(screen.getByTestId('assign-review')).toBeEnabled();
  });

  /** Candidates is contextual detail about the focused plant, in the slot the Inspector occupies. */
  it('answers "who can cover this?" from the engine list, on the focused plant', async () => {
    const user = userEvent.setup();
    renderAt('/dispatch/today?zoneId=7&assign=1');
    const region = await screen.findByTestId('console-assign-mode');
    await within(region).findByTestId('pool-plant-c-1-p-near');

    await user.click(within(region).getByLabelText('Candidates for Kotputli Works'));
    const column = await screen.findByTestId('candidate-column');
    expect(within(column).getByTestId('candidate-plant')).toHaveTextContent(/Kotputli/);
    expect(within(column).getByTestId('candidate-se-1')).toHaveAttribute('data-verdict', 'PASSED');
  });
});

describe('§8/§9 — available → draft → result, in the operator’s vocabulary', () => {
  it('counts the three populations as three labelled steps, and updates them live', async () => {
    const user = userEvent.setup();
    renderAt('/dispatch/today?zoneId=7&assign=1');
    const region = await screen.findByTestId('console-assign-mode');
    await within(region).findByTestId('pool-plant-c-1-p-near');

    expect(within(region).getByTestId('stage-available')).toHaveTextContent(/9.*Not assigned yet/s);
    expect(within(region).getByTestId('stage-staged')).toHaveTextContent(/0.*Selected for assignment/s);
    expect(within(region).getByTestId('stage-remaining')).toHaveTextContent(/9.*Will remain unassigned/s);

    await user.click(within(region).getByLabelText('Select Kotputli Works for UltraTech'));
    await user.click(within(region).getByTestId('assign-target-se-1'));

    // 5 of the 9 staged, so 4 will remain — the residual is live arithmetic over a draft that has
    // written nothing, which is the whole reason the draft is client state.
    await waitFor(() => expect(within(region).getByTestId('stage-staged')).toHaveTextContent(/5/));
    expect(within(region).getByTestId('stage-remaining')).toHaveTextContent(/4/);
    expect(within(region).getByTestId('stage-staged')).toHaveTextContent(/2 critical/);
  });

  it('says what will happen in a sentence, not only in numbers', async () => {
    const user = userEvent.setup();
    renderAt('/dispatch/today?zoneId=7&assign=1');
    const region = await stage(user, 'p-near', 'c-1', 'se-1');

    // The lane says it about one engineer; the footer says it about the whole commit. Both are the
    // same sentence shape on purpose — scoped to the footer here.
    const footer = within(region).getByTestId('assign-review').closest('footer');
    await waitFor(() =>
      expect(footer).toHaveTextContent(/5 devices will be added to 1 engineer's plan · 4 will remain unassigned/i),
    );
  });
});

describe('Leaving without committing — #272 Q2 made audible', () => {
  it('leaves straight away when there is nothing staged', async () => {
    const user = userEvent.setup();
    renderAt('/dispatch/today?zoneId=7&assign=1');
    await screen.findByTestId('console-assign-mode');

    await user.click(screen.getByTestId('assign-mode-exit'));

    expect(await screen.findByTestId('console-board')).toBeInTheDocument();
    expect(screen.queryByTestId('assign-exit-confirm')).not.toBeInTheDocument();
  });

  /**
   * The ruling is that a draft is session-local and dies when the operator leaves. It is *not* that
   * it should die without the operator being told which devices they are about to un-stage.
   */
  it('names what is about to be discarded, and lets the operator stay', async () => {
    const user = userEvent.setup();
    renderAt('/dispatch/today?zoneId=7&assign=1');
    await stage(user, 'p-near', 'c-1', 'se-1');

    await user.click(screen.getByTestId('assign-mode-exit'));

    const confirm = await screen.findByTestId('assign-exit-confirm');
    expect(confirm).toHaveTextContent(/5.*devices are selected for.*1.*engineer/s);
    expect(confirm).toHaveTextContent(/nothing has been written/i);
    // Still in the mode — the question is a question, not a farewell.
    expect(screen.getByTestId('console-assign-mode')).toBeInTheDocument();

    await user.click(within(confirm).getByRole('button', { name: /Keep drafting/i }));
    expect(screen.queryByTestId('assign-exit-confirm')).not.toBeInTheDocument();
    expect(screen.getByTestId('draft-lane-se-1')).toBeInTheDocument();

    await user.click(screen.getByTestId('assign-mode-exit'));
    await user.click(await screen.findByTestId('assign-exit-discard'));
    expect(await screen.findByTestId('console-board')).toBeInTheDocument();
  });

  /** Nothing about the confirm may write. The draft is discarded client-side and that is all. */
  it('writes nothing when a draft is discarded', async () => {
    const user = userEvent.setup();
    renderAt('/dispatch/today?zoneId=7&assign=1');
    await stage(user, 'p-near', 'c-1', 'se-1');

    await user.click(screen.getByTestId('assign-mode-exit'));
    await user.click(await screen.findByTestId('assign-exit-discard'));

    await screen.findByTestId('console-board');
    expect(apiAssignBatch).not.toHaveBeenCalled();
  });
});

describe('Committing — the receipt is per-lane, because the write is', () => {
  it('reports what was actually written and closes the write path behind it', async () => {
    const user = userEvent.setup();
    renderAt('/dispatch/today?zoneId=7&assign=1');
    const region = await stage(user, 'p-near', 'c-1', 'se-1');

    await user.click(within(region).getByTestId('assign-review'));
    await screen.findByTestId('review-commit-screen');
    await user.type(screen.getByTestId('review-reason'), 'zone backlog');
    await user.click(screen.getByRole('button', { name: /Commit 5 assignments/i }));

    const receipt = await screen.findByTestId('commit-receipt');
    expect(receipt).toHaveTextContent(/5 devices are now on 1 engineer's plan/i);
    // The honesty that #272 R8 requires: this was five writes in one transaction for one engineer,
    // and the screen never claims an atomic "commit all" the backend does not offer.
    expect(receipt).toHaveTextContent(/one engineer at a time/i);

    // The commit button is gone — the draft was consumed and the pool has moved underneath it.
    expect(screen.queryByRole('button', { name: /^Commit /i })).not.toBeInTheDocument();
    expect(screen.getByTestId('commit-done')).toBeInTheDocument();
  });

  /**
   * A lane can fail on its own — `assign-batch` is one transaction *per engineer*. The headline must
   * count only what was written, and the failure must be stated rather than averaged away.
   */
  it('does not call a partly-failed commit a success', async () => {
    const user = userEvent.setup();
    vi.mocked(apiAssignBatch).mockResolvedValue({
      reasonCode: 'why',
      lanes: [
        { seId: 'se-1', result: 'OK', assigned: 3, alreadyAssigned: 0, skipped: [] },
        { seId: 'se-2', result: 'FAILED', assigned: 0, alreadyAssigned: 0, skipped: [] },
      ],
    } as never);
    renderAt('/dispatch/today?zoneId=7&assign=1');
    const region = await stage(user, 'p-near', 'c-1', 'se-1');

    await user.click(within(region).getByTestId('assign-review'));
    await screen.findByTestId('review-commit-screen');
    await user.type(screen.getByTestId('review-reason'), 'zone backlog');
    await user.click(screen.getByRole('button', { name: /^Commit /i }));

    const receipt = await screen.findByTestId('commit-receipt');
    expect(receipt).toHaveTextContent(/3 devices are now on 1 engineer's plan/i);
    expect(receipt).toHaveTextContent(/1 lane wrote nothing/i);
  });
});

describe('The escalation strip inside Assign mode — the field-ops P1', () => {
  const withEscalation = () =>
    view({
      escalations: [
        {
          insertionId: 'i-1',
          ticketId: 'tk-escalated',
          slaBucket: 'CRITICAL',
          createdAt: '2026-08-28T06:00:00Z',
          insertionType: 'SYSTEM_CRITICAL',
          assignedSeId: null,
          assignedSeName: null,
        },
      ],
    });

  /**
   * The bug: the row set `?sel=` and nothing happened, because Assign mode does not render the
   * Inspector. A verb that silently does nothing is worse than no verb — it teaches the operator that
   * the strip is decoration.
   */
  it('takes the operator out of Assign mode and onto the ticket, instead of doing nothing', async () => {
    const user = userEvent.setup();
    vi.mocked(apiDispatchToday).mockResolvedValue(withEscalation());
    renderAt('/dispatch/today?zoneId=7&assign=1');
    await screen.findByTestId('console-assign-mode');

    const verb = screen.getByTestId('escalation-resolve-tk-escalated');
    expect(verb).toHaveTextContent(/Leave assigning and resolve/i);

    await user.click(verb);

    // Out of the mode, board back, and the escalated ticket selected with its Inspector open.
    expect(await screen.findByTestId('console-board')).toBeInTheDocument();
    expect(screen.queryByTestId('console-assign-mode')).not.toBeInTheDocument();
    expect(await screen.findByTestId('console-inspector')).toBeInTheDocument();
  });

  /** …and it goes through the same guard, so a staged draft is never dropped without a word. */
  it('asks before discarding a draft on the way out', async () => {
    const user = userEvent.setup();
    vi.mocked(apiDispatchToday).mockResolvedValue(withEscalation());
    renderAt('/dispatch/today?zoneId=7&assign=1');
    await stage(user, 'p-near', 'c-1', 'se-1');

    await user.click(screen.getByTestId('escalation-resolve-tk-escalated'));

    expect(await screen.findByTestId('assign-exit-confirm')).toBeInTheDocument();
    expect(screen.getByTestId('console-assign-mode')).toBeInTheDocument();
  });

  /** Outside Assign mode the verb is unchanged — this fix must not alter the normal-mode wording. */
  it('keeps its original wording on the board', async () => {
    vi.mocked(apiDispatchToday).mockResolvedValue(withEscalation());
    renderAt('/dispatch/today?zoneId=7');
    await screen.findByTestId('console-board');
    expect(screen.getByTestId('escalation-resolve-tk-escalated')).toHaveTextContent(/Assign this work/i);
  });
});

describe('Roles — server-side throughout, and the client says nothing different', () => {
  /**
   * A ZM never names a zone: the backend resolves it from their token and refuses any other. There is
   * therefore no picker to constrain and nothing client-side that could take them out of their zone.
   */
  it('gives a ZM the mode over their own zone, with no zone picker to leave it by', async () => {
    renderAt('/dispatch/today?assign=1', ZM);
    const region = await screen.findByTestId('console-assign-mode');

    expect(within(region).getByTestId('pool-plant-c-1-p-near')).toBeInTheDocument();
    expect(screen.queryByLabelText(/zone/i)).not.toBeInTheDocument();
    // The deck's roster is the lane-target list for a ZM exactly as it is for a CSM.
    expect(within(region).getByTestId('assign-target-se-1')).toBeInTheDocument();
  });

  /**
   * An Operations Head's broader reach is a *scope* difference, not an interface difference: the same
   * regions, the same gestures, and the zone picker they already have on the board. The pan-India pool
   * — the question `/assign` exists to answer — stays on `/assign` (§14 D4), because a pan-India pool
   * beside a one-zone deck is two panes disagreeing about where the operator is standing.
   */
  it('gives an Operations Head the identical surface, still clamped to the deck’s zone', async () => {
    renderAt('/dispatch/today?zoneId=7&assign=1', OH);
    const region = await screen.findByTestId('console-assign-mode');

    expect(within(region).getByTestId('assign-people-rail')).toBeInTheDocument();
    expect(within(region).getByTestId('assign-target-se-1')).toBeInTheDocument();
    expect(within(region).getByTestId('ledger-open')).toHaveTextContent('9');
    expect(screen.getByLabelText(/zone/i)).toBeInTheDocument();
  });
});
