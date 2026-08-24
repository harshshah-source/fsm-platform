import type { SessionView } from '@fsm/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { SidebarProvider } from '../src/components/shell/SidebarContext';
import { ThemeProvider } from '../src/components/shell/ThemeContext';
import { TopBar } from '../src/components/shell/TopBar';
import { AssignConsolePage } from '../src/pages/assign/AssignConsolePage';

/**
 * #273 — the Assign Work Console, slice 1: the work pool, the running ledger, and a commit.
 *
 * **What was wrong.** Seven surfaces in this codebase could move work to an engineer and **not one
 * showed a count** — the volume arrived afterwards, in a toast. Every one of them is shaped N→1 (many
 * tickets, one engineer, written immediately, no preview and no residual) while a dispatcher's job is
 * M→N. The console is the M→N surface, and the ledger across its top is the answer to the question
 * none of the seven could answer: *how much is left?*
 *
 * **Nothing is written until commit (#272 R2)** — which is exactly what makes the residual live rather
 * than retrospective, and what lets these tests assert the arithmetic without touching a write.
 *
 * **Selection is plant-shaped in S1, deliberately.** The only write available here is `assignPlants`,
 * which takes plant ids and moves *all* of a plant's assignable work; ticket-level chips arrive with
 * #275's `assign-batch`. The consequence is load-bearing and is asserted below: at a site serving more
 * than one company, drafting one company's row draws in the whole plant, because that is what the
 * commit will do. A ledger that counted only the row the operator ticked would under-report the write
 * — the precise failure #272 R3 exists to prevent, reappearing one layer up.
 */
const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };

const engineers = [
  { engineerId: 'se-a', name: 'Amit Yadav', coverageType: 'DEDICATED', zoneId: '1', committed: 5, dailyCapacity: 12, isActive: true },
  { engineerId: 'se-b', name: 'Karan Singh', coverageType: 'FLOATING', zoneId: '1', committed: 6, dailyCapacity: 8, isActive: true },
];

/**
 * Two companies. `Shared Works` (plant 30) is on **both** — the multi-company site that makes the
 * plant-shaped commit observable.
 */
const pool = {
  date: '2026-06-22',
  totals: { openUnassigned: 34, criticalCount: 9, heldCount: 2, plants: 4 },
  companies: [
    {
      companyId: '10',
      companyName: 'UltraTech Rajasthan',
      plants: [
        { plantId: '20', plantName: 'Kotputli Works', zoneId: '1', openUnassigned: 12, totalDevices: 38, criticalCount: 3, oldestInactivityHours: 61, heldCount: 0 },
        { plantId: '21', plantName: 'Chittorgarh Works', zoneId: '1', openUnassigned: 0, totalDevices: 31, criticalCount: 0, oldestInactivityHours: null, heldCount: 2 },
        { plantId: '30', plantName: 'Shared Works', zoneId: '1', openUnassigned: 4, totalDevices: 12, criticalCount: 1, oldestInactivityHours: 20, heldCount: 0 },
      ],
    },
    {
      companyId: '11',
      companyName: 'Acme Cement',
      plants: [
        { plantId: '22', plantName: 'Pali Works', zoneId: '1', openUnassigned: 12, totalDevices: 44, criticalCount: 4, oldestInactivityHours: 88, heldCount: 0 },
        { plantId: '30', plantName: 'Shared Works', zoneId: '1', openUnassigned: 6, totalDevices: 15, criticalCount: 1, oldestInactivityHours: 33, heldCount: 0 },
      ],
    },
  ],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const fetchMock = vi.fn();

function stubReads() {
  fetchMock.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes('/schedules/assignable-work')) return json(pool);
    if (u.includes('/schedules/engineers')) return json(engineers);
    // #274 added a third read to this page. The pool tests do not exercise candidates, but the page
    // legitimately asks for them, so the stub answers in the real shape rather than with a bare array.
    if (u.includes('/schedules/candidates')) return json({ date: pool.date, plants: [] });
    return json([]);
  });
  vi.stubGlobal('fetch', fetchMock);
}

function renderConsole() {
  return render(
    <AuthProvider initialSession={zm}>
      <MemoryRouter>
        <AssignConsolePage />
      </MemoryRouter>
    </AuthProvider>,
  );
}

/** Tick a plant row's checkbox in the work pool. */
async function pick(user: ReturnType<typeof userEvent.setup>, testId: string) {
  await user.click(within(screen.getByTestId(testId)).getByRole('checkbox'));
}

beforeEach(() => {
  stubReads();
  sessionStorage.setItem('fsm.accessToken', 't');
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

describe('#273 — the work pool', () => {
  it('groups plants under their company and shows the counts a dispatcher needs before choosing', async () => {
    renderConsole();

    const row = within(await screen.findByTestId('pool-plant-10-20'));
    expect(row.getByText('Kotputli Works')).toBeInTheDocument();
    // `12 / 38` — the work against the fleet at that site, the reference point a bare 12 never gave.
    expect(row.getByText('12')).toBeInTheDocument();
    expect(row.getByText('/ 38')).toBeInTheDocument();
    expect(row.getByText(/3 crit/i)).toBeInTheDocument();
    expect(row.getByText(/61 h silent/i)).toBeInTheDocument();

    expect(screen.getByText('UltraTech Rajasthan')).toBeInTheDocument();
    expect(screen.getByText('Acme Cement')).toBeInTheDocument();
  });

  /**
   * A plant whose only outstanding work is held still appears, and says so. Left out, the console
   * would show a site as empty when it has work the operator deliberately parked — and the natural
   * next move is to go looking for work that is not missing.
   */
  it('lists a plant with nothing assignable but work held, and names the hold', async () => {
    renderConsole();

    const row = within(await screen.findByTestId('pool-plant-10-21'));
    expect(row.getByText(/2 held/i)).toBeInTheDocument();
    expect(row.getByRole('checkbox')).toBeDisabled(); // nothing to draft
  });

  /**
   * #277 — absorbs the orphaned `CriticalQueue` grouping as a pool preset instead of a second surface.
   * `criticalCount` is the same cluster-size signal that component uniquely carried; the chip just
   * narrows the pool to it rather than duplicating a badge that already renders on every row.
   */
  it('the Critical+ chip narrows the pool to plants carrying CRITICAL+ work', async () => {
    const user = userEvent.setup();
    renderConsole();

    await screen.findByTestId('pool-plant-10-20');
    expect(screen.getByTestId('pool-plant-10-21')).toBeInTheDocument(); // 0 crit — visible by default

    await user.click(screen.getByTestId('filter-critical-plus'));

    expect(screen.getByTestId('pool-plant-10-20')).toBeInTheDocument(); // 3 crit
    expect(screen.queryByTestId('pool-plant-10-21')).toBeNull(); // 0 crit — filtered out
    expect(screen.getByTestId('filter-critical-plus')).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByTestId('filter-critical-plus'));
    expect(screen.getByTestId('pool-plant-10-21')).toBeInTheDocument(); // toggled back off
  });
});

describe('#273 — the ledger', () => {
  it('opens with the zone total and nothing drafted', async () => {
    renderConsole();

    await screen.findByTestId('pool-plant-10-20');
    expect(within(screen.getByTestId('ledger-open')).getByText('34')).toBeInTheDocument();
    expect(within(screen.getByTestId('ledger-draft')).getByText('0')).toBeInTheDocument();
    expect(within(screen.getByTestId('ledger-left')).getByText('34')).toBeInTheDocument();
  });

  it('recomputes left-after-commit as work moves into the draft, before anything is written', async () => {
    const user = userEvent.setup();
    renderConsole();
    await screen.findByTestId('pool-plant-10-20');

    await pick(user, 'pool-plant-10-20'); // Kotputli, 12
    await user.click(screen.getByRole('button', { name: /add to draft/i }));

    await waitFor(() => {
      expect(within(screen.getByTestId('ledger-draft')).getByText('12')).toBeInTheDocument();
    });
    expect(within(screen.getByTestId('ledger-left')).getByText('22')).toBeInTheDocument(); // 34 − 12
    expect(within(screen.getByTestId('ledger-critical')).getByText('3')).toBeInTheDocument();

    // Nothing written — R2. The only calls so far are the two opening reads.
    expect(fetchMock.mock.calls.every(([, o]) => ((o as RequestInit | undefined)?.method ?? 'GET') === 'GET')).toBe(true);
  });

  /**
   * The multi-company site. `assignPlants` is plant-shaped, so drafting UltraTech's 4 devices at Shared
   * Works commits Acme's 6 as well. The ledger must say 10, because 10 is what the button will move.
   */
  it('counts a shared plant’s whole assignable set, because that is what the commit moves', async () => {
    const user = userEvent.setup();
    renderConsole();
    await screen.findByTestId('pool-plant-10-30');

    await pick(user, 'pool-plant-10-30'); // UltraTech's row at Shared Works: 4 of the plant's 10
    await user.click(screen.getByRole('button', { name: /add to draft/i }));

    await waitFor(() => {
      expect(within(screen.getByTestId('ledger-draft')).getByText('10')).toBeInTheDocument();
    });
    expect(within(screen.getByTestId('ledger-left')).getByText('24')).toBeInTheDocument(); // 34 − 10
    // And the operator is told why the number is bigger than the row they ticked.
    expect(screen.getByTestId('pool-plant-10-30')).toHaveTextContent(/serves 2 companies/i);
  });
});

/**
 * #275 — the review-and-commit screen. `Commit` no longer writes directly: it resolves each lane's
 * drafted plants into ticket ids, shows the diff, and only `assign-batch` (fired from that screen,
 * with a mandatory reason) writes anything.
 */
async function draftTwoLanes(user: ReturnType<typeof userEvent.setup>) {
  renderConsole();
  await screen.findByTestId('pool-plant-10-20');

  // Lane 1 → Amit, Kotputli.
  await user.selectOptions(screen.getByLabelText(/engineer for lane 1/i), 'se-a');
  await pick(user, 'pool-plant-10-20');
  await user.click(within(screen.getByTestId('lane-1')).getByRole('button', { name: /add to draft/i }));

  // Lane 2 → Karan, Pali.
  await user.click(screen.getByRole('button', { name: /add engineer lane/i }));
  await user.selectOptions(screen.getByLabelText(/engineer for lane 2/i), 'se-b');
  await pick(user, 'pool-plant-11-22');
  await user.click(within(screen.getByTestId('lane-2')).getByRole('button', { name: /add to draft/i }));
}

function stubAssignBatchReads(overCapacityKaran = false) {
  fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
    const u = String(url);
    if (u.includes('/schedules/assignable-tickets')) {
      const plantIds = new URL(u, 'http://x').searchParams.get('plantIds')?.split(',') ?? [];
      const rows = plantIds.map((plantId) => {
        if (plantId === '20') return { plantId, ticketIds: ['t-20-1', 't-20-2'] };
        if (plantId === '22') {
          // Karan is committed at 6/8 — five more tickets pushes him to 11/8, over capacity.
          return { plantId, ticketIds: overCapacityKaran ? ['t-22-1', 't-22-2', 't-22-3', 't-22-4', 't-22-5'] : ['t-22-1'] };
        }
        return { plantId, ticketIds: [] };
      });
      return json(rows);
    }
    if (u.includes('/schedules/assign-batch')) {
      const body = JSON.parse(String(opts?.body)) as { reasonCode: string; lanes: { seId: string; ticketIds: string[] }[] };
      const lanes = body.lanes.map((l) =>
        l.seId === 'se-b'
          ? { seId: l.seId, result: 'LANE_FAILED', assigned: 0, alreadyAssigned: 0, skipped: [], batchIds: [] }
          : { seId: l.seId, result: 'OK', assigned: l.ticketIds.length, alreadyAssigned: 0, skipped: [], batchIds: ['1'] },
      );
      return json({ lanes });
    }
    if (u.includes('/schedules/assignable-work')) return json(pool);
    if (u.includes('/schedules/engineers')) return json(engineers);
    if (u.includes('/schedules/candidates')) return json({ date: pool.date, plants: [] });
    return json([]);
  });
}

describe('#275 — review and commit', () => {
  it('shows the diff before writing anything, and requires a reason before it will commit', async () => {
    stubAssignBatchReads();
    const user = userEvent.setup();
    await draftTwoLanes(user);

    await user.click(screen.getByRole('button', { name: /review.*commit/i }));

    const screenEl = await screen.findByTestId('review-commit-screen');
    expect(within(screenEl).getByTestId('review-lane-se-a')).toBeInTheDocument();
    expect(within(screenEl).getByTestId('review-lane-se-b')).toBeInTheDocument();
    // 2 (Kotputli) + 1 (Pali) resolved ticket ids — the diff, not the plant-level draft count.
    expect(within(screenEl).getByTestId('review-committing')).toHaveTextContent('3');

    // Nothing written by opening the review — only reads so far (pool, engineers, candidates,
    // assignable-tickets); no assign-batch POST yet.
    expect(
      fetchMock.mock.calls.some(([u, o]) => String(u).includes('/schedules/assign-batch') && (o as RequestInit | undefined)?.method === 'POST'),
    ).toBe(false);

    const commitButton = screen.getByRole('button', { name: /^commit 3 assignments$/i });
    expect(commitButton).toBeDisabled();

    await user.type(screen.getByTestId('review-reason'), 'Pali backlog cleared ahead of the monsoon shutdown');
    expect(commitButton).toBeEnabled();
  });

  it('reports each lane separately after commit, and one failing lane does not condemn the other', async () => {
    stubAssignBatchReads();
    const user = userEvent.setup();
    await draftTwoLanes(user);
    await user.click(screen.getByRole('button', { name: /review.*commit/i }));
    await screen.findByTestId('review-commit-screen');

    await user.type(screen.getByTestId('review-reason'), 'audit-pinned reason');
    await user.click(screen.getByRole('button', { name: /^commit 3 assignments$/i }));

    await waitFor(() => expect(screen.getByTestId('assign-batch-results')).toBeInTheDocument());
    expect(screen.getByTestId('batch-result-se-a')).toHaveTextContent(/assigned 2/i);
    expect(screen.getByTestId('batch-result-se-b')).toHaveTextContent(/lane failed/i);

    const post = fetchMock.mock.calls.find(
      ([u, o]) => String(u).includes('/schedules/assign-batch') && (o as RequestInit | undefined)?.method === 'POST',
    )!;
    const body = JSON.parse(String((post[1] as RequestInit).body));
    expect(body).toEqual({
      reasonCode: 'audit-pinned reason',
      lanes: [
        { seId: 'se-a', ticketIds: ['t-20-1', 't-20-2'] },
        { seId: 'se-b', ticketIds: ['t-22-1'] },
      ],
    });
  });

  /** Q2 (#258) — over capacity is stated in words at the point of decision, never blocked. */
  it('states an over-capacity lane in words on the review screen, and still allows the commit', async () => {
    stubAssignBatchReads(true);
    const user = userEvent.setup();
    await draftTwoLanes(user);
    await user.click(screen.getByRole('button', { name: /review.*commit/i }));
    const screenEl = await screen.findByTestId('review-commit-screen');

    expect(within(screenEl).getByTestId('review-overcapacity-copy')).toHaveTextContent(
      /is being taken to.*capacity.*allowed and will be recorded.*not blocked/i,
    );
    expect(within(screenEl).getByTestId('review-lane-se-b')).toHaveTextContent(/capacity/i);

    await user.type(screen.getByTestId('review-reason'), 'overload accepted for this plan');
    expect(screen.getByRole('button', { name: /^commit 7 assignments$/i })).toBeEnabled();
  });

  it('going back to the draft loses no state and does not write anything', async () => {
    stubAssignBatchReads();
    const user = userEvent.setup();
    await draftTwoLanes(user);
    await user.click(screen.getByRole('button', { name: /review.*commit/i }));
    await screen.findByTestId('review-commit-screen');

    await user.click(screen.getByRole('button', { name: /back to draft/i }));
    expect(screen.queryByTestId('review-commit-screen')).toBeNull();
    expect(screen.getByTestId('lane-1')).toBeInTheDocument();
    expect(screen.getByTestId('lane-2')).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([u, o]) => String(u).includes('/schedules/assign-batch') && (o as RequestInit | undefined)?.method === 'POST'),
    ).toBe(false);
  });

  /**
   * #249/#275 — a held ticket a lane skipped is not a dead end. `assign-batch` never carries a
   * per-ticket confirm (the mandatory reason is for the plan, not a hold override), so resolving one
   * goes through the exact single-ticket confirm flow every other manual-assign surface already uses.
   */
  it('offers the existing confirm flow to resolve a deferred ticket the batch skipped', async () => {
    fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      const u = String(url);
      if (u.includes('/schedules/assignable-tickets')) {
        const plantIds = new URL(u, 'http://x').searchParams.get('plantIds')?.split(',') ?? [];
        return json(plantIds.map((plantId) => ({ plantId, ticketIds: plantId === '20' ? ['t-20-1'] : [] })));
      }
      if (u.includes('/schedules/assign-batch')) {
        return json({
          lanes: [
            {
              seId: 'se-a',
              result: 'OK',
              assigned: 0,
              alreadyAssigned: 0,
              skipped: [{ ticketId: 't-20-1', reason: 'CONFLICT_DEFERRED' }],
              batchIds: [],
            },
          ],
        });
      }
      if (u.includes('/schedules/assign') && opts?.method === 'POST') {
        const body = JSON.parse(String(opts?.body)) as { confirm?: boolean };
        if (!body.confirm) {
          return json(
            {
              code: 'CONFLICT_DEFERRED',
              message: 'Ticket is held to a future vehicle-return date.',
              ticketId: 't-20-1',
              deferredUntil: '2026-06-30T00:00:00.000Z',
              vuReport: null,
            },
            409,
          );
        }
        return json({ result: 'OK', scheduleId: '1', batchId: '1', ticketId: 't-20-1', seId: 'se-a' });
      }
      if (u.includes('/schedules/assignable-work')) return json(pool);
      if (u.includes('/schedules/engineers')) return json(engineers);
      if (u.includes('/schedules/candidates')) return json({ date: pool.date, plants: [] });
      return json([]);
    });

    const user = userEvent.setup();
    renderConsole();
    await screen.findByTestId('pool-plant-10-20');

    await user.selectOptions(screen.getByLabelText(/engineer for lane 1/i), 'se-a');
    await pick(user, 'pool-plant-10-20');
    await user.click(within(screen.getByTestId('lane-1')).getByRole('button', { name: /add to draft/i }));
    await user.click(screen.getByRole('button', { name: /review.*commit/i }));
    await screen.findByTestId('review-commit-screen');

    await user.type(screen.getByTestId('review-reason'), 'clearing what can move today');
    await user.click(screen.getByRole('button', { name: /^commit 1 assignment$/i }));

    await waitFor(() => expect(screen.getByTestId('assign-batch-results')).toBeInTheDocument());
    expect(screen.getByTestId('batch-result-se-a')).toHaveTextContent(/conflict deferred/i);

    await user.click(screen.getByRole('button', { name: /resolve hold/i }));
    expect(await screen.findByTestId('deferral-conflict-banner')).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText(/why is this being assigned/i), 'vehicle back early');
    await user.click(screen.getByRole('button', { name: /confirm override/i }));

    await waitFor(() => expect(screen.getByText('resolved')).toBeInTheDocument());
  });
});

/**
 * #276 — Distribute: several plants across several engineers, projected before anything enters the
 * draft. The projection lands in the draft, editable — the operator can still add, remove, or move a
 * chip afterwards, same as any manually-built lane.
 */
function stubDistributeReads(opts: { partial?: boolean; unplaced?: boolean } = {}) {
  fetchMock.mockImplementation(async (url: string, requestOpts?: RequestInit) => {
    const u = String(url);
    if (u.includes('/schedules/assignable-tickets')) {
      const plantIds = new URL(u, 'http://x').searchParams.get('plantIds')?.split(',') ?? [];
      return json(
        plantIds.map((plantId) => ({
          plantId,
          ticketIds: plantId === '20' ? ['t-20-1', 't-20-2', 't-20-3'] : plantId === '22' ? ['t-22-1'] : [],
        })),
      );
    }
    if (u.includes('/schedules/distribute-preview')) {
      const body = JSON.parse(String(requestOpts?.body)) as { ticketIds: string[]; engineerIds: string[] };
      const lanes = [
        {
          seId: 'se-a',
          // Partial: only 2 of Kotputli's 3 selected ticket ids, so the draft chip must say so.
          plants: [{ plantId: '20', ticketIds: opts.partial ? ['t-20-1', 't-20-2'] : ['t-20-1', 't-20-2', 't-20-3'] }],
        },
      ];
      if (body.engineerIds.includes('se-b') && body.ticketIds.includes('t-22-1')) {
        lanes.push({ seId: 'se-b', plants: [{ plantId: '22', ticketIds: ['t-22-1'] }] });
      }
      return json({
        strategy: 'COVERAGE_TIER',
        targetDate: pool.date,
        lanes,
        // Mirrors the approved design's own rail: one plant that is *partly* placed and partly
        // uncoverable (Kotputli here, Pali Works there) plus a second plant nobody can take at all,
        // so grouping, both reasons, and the partly-placed case are all exercised.
        unplaced: opts.unplaced
          ? [
              { ticketId: 't-20-9', plantId: '20', reason: 'NO_COVERAGE' },
              { ticketId: 't-22-7', plantId: '22', reason: 'ALL_DROPPED' },
              { ticketId: 't-22-8', plantId: '22', reason: 'ALL_DROPPED' },
            ]
          : [],
        overCapacitySeIds: [],
      });
    }
    if (u.includes('/schedules/assignable-work')) return json(pool);
    if (u.includes('/schedules/engineers')) return json(engineers);
    if (u.includes('/schedules/candidates')) return json({ date: pool.date, plants: [] });
    return json([]);
  });
}

describe('#276 — Distribute', () => {
  it('projects a selection across chosen engineers and lands it in the editable draft, recomputing the ledger', async () => {
    stubDistributeReads();
    const user = userEvent.setup();
    renderConsole();
    await screen.findByTestId('pool-plant-10-20');

    await pick(user, 'pool-plant-10-20');
    await user.click(screen.getByRole('button', { name: /distribute across selected engineers/i }));

    const panel = await screen.findByTestId('distribute-panel');
    await user.click(within(panel).getByRole('checkbox', { name: /amit yadav/i }));
    await user.click(within(panel).getByRole('button', { name: /preview distribution/i }));

    await screen.findByTestId('distribute-result');
    expect(screen.getByTestId('distribute-lane-se-a')).toHaveTextContent(/3 devices/i);

    await user.click(within(panel).getByRole('button', { name: /^add to draft$/i }));

    // The panel closes and the projection is now an ordinary, editable lane.
    expect(screen.queryByTestId('distribute-panel')).toBeNull();
    await waitFor(() => {
      expect(within(screen.getByTestId('ledger-draft')).getByText('3')).toBeInTheDocument();
    });
    expect(screen.getByTestId('chip-1-20')).toBeInTheDocument();

    // Editable: the operator can still remove the chip Distribute added, same as any manual one.
    await user.click(screen.getByRole('button', { name: /remove kotputli works from lane 1/i }));
    await waitFor(() => {
      expect(within(screen.getByTestId('ledger-draft')).getByText('0')).toBeInTheDocument();
    });
  });

  it('marks a partial placement on its chip rather than widening it back out to the whole plant', async () => {
    stubDistributeReads({ partial: true });
    const user = userEvent.setup();
    renderConsole();
    await screen.findByTestId('pool-plant-10-20');

    await pick(user, 'pool-plant-10-20');
    await user.click(screen.getByRole('button', { name: /distribute across selected engineers/i }));
    const panel = await screen.findByTestId('distribute-panel');
    await user.click(within(panel).getByRole('checkbox', { name: /amit yadav/i }));
    await user.click(within(panel).getByRole('button', { name: /preview distribution/i }));
    await screen.findByTestId('distribute-result');
    await user.click(within(panel).getByRole('button', { name: /^add to draft$/i }));

    expect(screen.getByTestId('chip-1-20')).toHaveTextContent(/2 of 12/);
  });

  /**
   * #276 AC — "work with no eligible engineer lands in the no-coverage rail with `NO_COVERAGE` or
   * `ALL_DROPPED`".
   *
   * These assert the **rail in the draft column**, which is what the AC and the approved design
   * actually ask for. The Distribute panel's own banner is a transient echo: it disappears with the
   * panel, so a test that only looked there would pass over a console that drops every unplaceable
   * ticket the moment the operator clicks Add to draft — which is exactly what it used to do.
   */
  async function distributeWithUnplaced(user: ReturnType<typeof userEvent.setup>) {
    stubDistributeReads({ unplaced: true });
    renderConsole();
    await screen.findByTestId('pool-plant-10-20');

    await pick(user, 'pool-plant-10-20');
    await user.click(screen.getByRole('button', { name: /distribute across selected engineers/i }));
    const panel = await screen.findByTestId('distribute-panel');
    await user.click(within(panel).getByRole('checkbox', { name: /amit yadav/i }));
    await user.click(within(panel).getByRole('button', { name: /preview distribution/i }));
    await screen.findByTestId('distribute-result');
    // The panel reports it too, but the panel is about to close — that is the whole point.
    expect(screen.getByTestId('distribute-unplaced')).toHaveTextContent(/no coverage/i);
    await user.click(within(panel).getByRole('button', { name: /^add to draft$/i }));
    return panel;
  }

  it('keeps work with no eligible engineer in the draft rail, grouped by plant and reason, after the panel closes', async () => {
    const user = userEvent.setup();
    await distributeWithUnplaced(user);

    // The panel that reported it is gone; the rail is not.
    expect(screen.queryByTestId('distribute-panel')).toBeNull();
    const rail = await screen.findByTestId('unplaced-rail');

    expect(screen.getByTestId('unplaced-rail-total')).toHaveTextContent(/no eligible engineer.*3 devices/i);
    // Two reasons at two plants stay two chips — a coverage gap must not hide behind a readiness one.
    expect(within(rail).getByTestId('unplaced-22-ALL_DROPPED')).toHaveTextContent(/pali works.*×2.*all dropped/i);
    expect(within(rail).getByTestId('unplaced-20-NO_COVERAGE')).toHaveTextContent(/kotputli works.*×1.*no coverage/i);
  });

  it('rails a plant that is only partly placeable while its placed half sits in a lane', async () => {
    const user = userEvent.setup();
    await distributeWithUnplaced(user);
    await screen.findByTestId('unplaced-rail');

    // The approved design draws exactly this: Kotputli is in Amit's lane AND on the rail, because
    // some of its work is coverable and some is not. Filtering the rail per-plant would erase it.
    expect(screen.getByTestId('chip-1-20')).toBeInTheDocument();
    expect(screen.getByTestId('unplaced-20-NO_COVERAGE')).toBeInTheDocument();
  });

  it('carries the unplaceable count into the review screen instead of hardcoding zero', async () => {
    const user = userEvent.setup();
    await distributeWithUnplaced(user);
    await screen.findByTestId('unplaced-rail');

    await user.click(screen.getByRole('button', { name: /review.*commit/i }));
    await screen.findByTestId('review-commit-screen');

    expect(screen.getByTestId('review-still-unassigned').parentElement).toHaveTextContent(
      /including 3 with no eligible engineer/i,
    );
  });

  it('drops rail entries the operator places by hand, and restores them when the placement is undone', async () => {
    const user = userEvent.setup();
    await distributeWithUnplaced(user);
    await screen.findByTestId('unplaced-rail');

    // Taking Pali Works by hand takes it whole — R2, the operator may always overrule the projection.
    await pick(user, 'pool-plant-11-22');
    await user.click(within(screen.getByTestId('lane-1')).getByRole('button', { name: /add to draft/i }));

    await waitFor(() => expect(screen.queryByTestId('unplaced-22-ALL_DROPPED')).toBeNull());
    expect(screen.getByTestId('unplaced-rail-total')).toHaveTextContent(/1 device/i);

    // Derived, not stored: undoing the placement puts it back without re-running Distribute.
    await user.click(screen.getByRole('button', { name: /remove pali works from lane 1/i }));
    await waitFor(() => expect(screen.getByTestId('unplaced-22-ALL_DROPPED')).toBeInTheDocument());
    expect(screen.getByTestId('unplaced-rail-total')).toHaveTextContent(/3 devices/i);
  });

  it('still hands the remainder over when a projection places nothing at all', async () => {
    // The case the rail exists for, and the one that used to be unreachable: nobody in the selection
    // covers the work, so there are no lanes — and gating "Add to draft" on lanes left the operator
    // reading a count in a panel they could only close. Seen live at 90 unplaced / 0 placed.
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('/schedules/assignable-tickets')) return json([{ plantId: '20', ticketIds: ['t-20-1'] }]);
      if (u.includes('/schedules/distribute-preview')) {
        return json({
          strategy: 'COVERAGE_TIER',
          targetDate: pool.date,
          lanes: [],
          unplaced: [{ ticketId: 't-20-1', plantId: '20', reason: 'NO_COVERAGE' }],
          overCapacitySeIds: [],
        });
      }
      if (u.includes('/schedules/assignable-work')) return json(pool);
      if (u.includes('/schedules/engineers')) return json(engineers);
      if (u.includes('/schedules/candidates')) return json({ date: pool.date, plants: [] });
      return json([]);
    });

    const user = userEvent.setup();
    renderConsole();
    await screen.findByTestId('pool-plant-10-20');

    await pick(user, 'pool-plant-10-20');
    await user.click(screen.getByRole('button', { name: /distribute across selected engineers/i }));
    const panel = await screen.findByTestId('distribute-panel');
    await user.click(within(panel).getByRole('checkbox', { name: /amit yadav/i }));
    await user.click(within(panel).getByRole('button', { name: /preview distribution/i }));
    await screen.findByTestId('distribute-result');

    const carry = within(panel).getByRole('button', { name: /add unplaceable work to draft/i });
    expect(carry).toBeEnabled();
    await user.click(carry);

    expect(await screen.findByTestId('unplaced-rail')).toBeInTheDocument();
    expect(screen.getByTestId('unplaced-20-NO_COVERAGE')).toHaveTextContent(/kotputli works.*×1.*no coverage/i);
  });

  it('clears the rail with the draft it describes', async () => {
    const user = userEvent.setup();
    await distributeWithUnplaced(user);
    await screen.findByTestId('unplaced-rail');

    await user.click(screen.getByRole('button', { name: /clear draft/i }));
    await waitFor(() => expect(screen.queryByTestId('unplaced-rail')).toBeNull());
  });
});

/**
 * AC-5 — the regression pin. `Assign SE` in the top bar called `navigate('/')`: a prominent button,
 * on every manager screen, that reloaded the dashboard and opened nothing. It is the entry point to
 * this console, and this test exists so it can never quietly resolve to `/` again.
 */
describe('#273 — the top-bar entry point', () => {
  it('takes Assign SE to the console instead of the dashboard', async () => {
    const user = userEvent.setup();
    render(
      <AuthProvider initialSession={zm}>
        <MemoryRouter initialEntries={['/tickets']}>
          <ThemeProvider>
            <SidebarProvider>
              <TopBar />
              <Routes>
                <Route path="/tickets" element={<p>tickets</p>} />
                <Route path="/" element={<p>dashboard</p>} />
                <Route path="/assign" element={<p>assign console</p>} />
              </Routes>
            </SidebarProvider>
          </ThemeProvider>
        </MemoryRouter>
      </AuthProvider>,
    );

    await user.click(screen.getByRole('button', { name: /assign se/i }));
    expect(await screen.findByText('assign console')).toBeInTheDocument();
    expect(screen.queryByText('dashboard')).toBeNull();
  });
});
