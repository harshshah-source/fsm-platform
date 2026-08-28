import type { SessionView } from '@fsm/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchChangesTodayView, DispatchTodayView } from '../src/api/dispatchToday';
import { AuthProvider } from '../src/auth/AuthProvider';
import TodaysDispatchPage from '../src/pages/dispatch/TodaysDispatchPage';

vi.mock('../src/api/dispatch-runs', async () => {
  const actual = await vi.importActual('../src/api/dispatch-runs');
  return { ...actual, apiDispatchRunDecisions: vi.fn(), apiDispatchTicketTrace: vi.fn() };
});

vi.mock('../src/api/dispatchToday', async () => {
  const actual = await vi.importActual('../src/api/dispatchToday');
  return { ...actual, apiDispatchToday: vi.fn(), apiDispatchChangesToday: vi.fn() };
});

const { apiDispatchToday, apiDispatchChangesToday } = await import('../src/api/dispatchToday');
const { apiDispatchRunDecisions } = await import('../src/api/dispatch-runs');

const ticket = (over: Partial<DispatchTodayView['engineers'][0]['stops'][0]['tickets'][0]> = {}) => ({
  ticketId: '11111111-2222-3333-4444-555555555555',
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
  operatingDay: '2026-08-25',
  chronicThreshold: 3,
  zone: { zoneId: '7', name: 'North Zone' },
  run: { runId: '42', status: 'SUCCESS', trigger: 'CRON', startedAt: '2026-08-25T05:00:00Z', finishedAt: null },
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
          tickets: [ticket()],
        },
      ],
    },
  ],
  situation: { placed: 1, unassignable: 0, held: 0, criticalNeedsYou: 0, overCapacity: 0, changesToday: 0, componentBlockedWithheld: null, bucketlessDropped: null },
  rails: { unassignable: [], held: [], policyWithheld: { count: 5, itemised: false } },
  escalations: [],
  recovery: null,
  ...over,
});

const changes = (over: Partial<DispatchChangesTodayView> = {}): DispatchChangesTodayView => ({
  operatingDay: '2026-08-25',
  zoneId: '7',
  counts: { adds: 0, removes: 0, swaps: 0, total: 0 },
  changes: [],
  ...over,
});

const ZM: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 7, acted_as_role: null };

const renderAt = (entry: string, session: SessionView = ZM) =>
  render(
    <AuthProvider initialSession={session}>
      <MemoryRouter initialEntries={[entry]}>
        <TodaysDispatchPage />
      </MemoryRouter>
    </AuthProvider>,
  );

const renderPage = (session: SessionView = ZM) => renderAt('/dispatch/today', session);

describe("#285 — Today's Dispatch cockpit", () => {
  beforeEach(() => {
    vi.mocked(apiDispatchChangesToday).mockResolvedValue(changes());
  });

  it('renders one lane per engineer, with stops in persisted order', async () => {
    vi.mocked(apiDispatchToday).mockResolvedValue(view());
    renderPage();

    // Scoped to the board lane on purpose. Under the Console's approved four-region layout an
    // engineer is legitimately named twice — once in the People rail, once on their board lane — so an
    // unscoped query matches both. The assertion that matters is that the *lane* carries the name and
    // the stop, which is what a plain `getByText` was only incidentally checking before.
    const lane = await screen.findByTestId('cell-se-1-2026-08-25');
    expect(within(lane).getByText('Acme Cement')).toBeInTheDocument();
    expect(within(screen.getByTestId('console-board')).getByTestId('lane-se-1')).toHaveTextContent('Ramesh K.');
    expect(within(screen.getByTestId('console-people-rail')).getByText('Ramesh K.')).toBeInTheDocument();
  });

  it('shows an engineer with no stops rather than omitting them — an empty lane is a fact', async () => {
    vi.mocked(apiDispatchToday).mockResolvedValue(
      view({
        engineers: [
          {
            seId: 'se-idle',
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
      }),
    );
    renderPage();

    expect(await screen.findByTestId('cell-se-idle-2026-08-25')).toBeInTheDocument();
    expect(screen.getByText(/no stops — available/i)).toBeInTheDocument();
  });

  it('draws a human override differently from a system decision', async () => {
    vi.mocked(apiDispatchToday).mockResolvedValue(
      view({
        engineers: [
          {
            ...view().engineers[0],
            stops: [
              {
                ...view().engineers[0].stops[0],
                tickets: [
                  ticket({ ticketId: 'aaaaaaaa-0000-0000-0000-000000000000' }),
                  ticket({
                    ticketId: 'bbbbbbbb-0000-0000-0000-000000000000',
                    addSource: 'MANUAL_ASSIGN',
                    addedBy: 'zm-1',
                    systemPlaced: false,
                    coverageTypeAtAssign: 'DEDICATED',
                  }),
                ],
              },
            ],
          },
        ],
      }),
    );
    renderPage();

    const system = await screen.findByTestId('chip-aaaaaaaa-0000-0000-0000-000000000000');
    const human = screen.getByTestId('chip-bbbbbbbb-0000-0000-0000-000000000000');

    expect(system).toHaveAttribute('data-provenance', 'AUTO_DISPATCH');
    expect(human).toHaveAttribute('data-provenance', 'MANUAL_ASSIGN');
    // Grayscale-survivable: the border style differs, not merely the colour.
    expect(system.className).not.toContain('border-dashed');
    expect(human.className).toContain('border-dashed');
  });

  it('renders unknown provenance as unknown — never as a system decision', async () => {
    // The one direction the grammar must not fail in (#282 R2). A pre-#283 row records nothing, and
    // drawing it solid would assert the engine made a choice nobody can show it made.
    vi.mocked(apiDispatchToday).mockResolvedValue(
      view({
        engineers: [
          {
            ...view().engineers[0],
            stops: [
              {
                ...view().engineers[0].stops[0],
                tickets: [
                  ticket({
                    ticketId: 'cccccccc-0000-0000-0000-000000000000',
                    addSource: null,
                    systemPlaced: false,
                    coverageTypeAtAssign: null,
                  }),
                ],
              },
            ],
          },
        ],
      }),
    );
    renderPage();

    const chip = await screen.findByTestId('chip-cccccccc-0000-0000-0000-000000000000');
    expect(chip).toHaveAttribute('data-provenance', 'UNKNOWN');
    expect(chip.className).toContain('border-dotted');
    expect(chip.title).toMatch(/predates provenance/i);
  });

  it('surfaces critical escalations as an interception strip', async () => {
    vi.mocked(apiDispatchToday).mockResolvedValue(
      view({
        situation: { placed: 1, unassignable: 0, held: 0, criticalNeedsYou: 1, overCapacity: 0, changesToday: 0, componentBlockedWithheld: null, bucketlessDropped: null },
        escalations: [
          {
            insertionId: 'i1',
            ticketId: 'dddddddd-0000-0000-0000-000000000000',
            slaBucket: 'CRITICAL',
            createdAt: '2026-08-25T11:42:00Z',
            // #268's cause, and nobody holds the ticket — the row Assign is the right door for.
            insertionType: 'SYSTEM_CRITICAL',
            assignedSeId: null,
            assignedSeName: null,
          },
        ],
      }),
    );
    renderPage();

    const strip = await screen.findByTestId('critical-interception');
    expect(strip).toHaveTextContent(/needs manual assignment/i);
    expect(strip).toHaveTextContent(/escalated/i);
  });

  it('states that policy-withheld work is a count, not a truncated list', async () => {
    vi.mocked(apiDispatchToday).mockResolvedValue(view());
    renderPage();

    expect(await screen.findByText(/Counted by the run, not itemised/i)).toBeInTheDocument();
  });

  it('takes every counter from the payload — none are hard-coded', async () => {
    vi.mocked(apiDispatchToday).mockResolvedValue(
      view({
        situation: { placed: 42, unassignable: 3, held: 2, criticalNeedsYou: 1, overCapacity: 1, changesToday: 4, componentBlockedWithheld: null, bucketlessDropped: null },
      }),
    );
    renderPage();

    await screen.findByTestId('lane-se-1');
    for (const n of ['42', '3', '2', '1', '4']) {
      expect(screen.getAllByText(n).length).toBeGreaterThan(0);
    }
  });

  /**
   * #286 AC5 — the bound on automatic re-dispatch is only acceptable while somebody is told about it.
   * A zone that spent its budget must not look like a zone that had a quiet morning.
   */
  it('says nothing about recovery on a zone that never crashed', async () => {
    vi.mocked(apiDispatchToday).mockResolvedValue(view());
    renderPage();

    await screen.findByTestId('lane-se-1');
    expect(screen.queryByTestId('recovery-notice')).not.toBeInTheDocument();
  });

  it('surfaces an exhausted same-day recovery, with its attempt count and reason', async () => {
    vi.mocked(apiDispatchToday).mockResolvedValue(
      view({
        recovery: {
          state: 'EXHAUSTED',
          attempts: 3,
          markedAt: '2026-08-25T05:02:00Z',
          lastAttemptAt: '2026-08-25T05:20:00Z',
          lastError: 'zone lock never cleared',
        },
      }),
    );
    renderPage();

    const notice = await screen.findByTestId('recovery-notice');
    expect(notice).toHaveTextContent('3');
    expect(notice).toHaveTextContent('zone lock never cleared');
  });

  it('reports a recovered zone as recovered, not as a failure', async () => {
    vi.mocked(apiDispatchToday).mockResolvedValue(
      view({
        recovery: {
          state: 'RECOVERED',
          attempts: 1,
          markedAt: '2026-08-25T05:02:00Z',
          lastAttemptAt: '2026-08-25T05:05:00Z',
          lastError: null,
        },
      }),
    );
    renderPage();

    const notice = await screen.findByTestId('recovery-notice');
    expect(notice).toHaveTextContent(/re-dispatched/i);
  });

  /**
   * #285 AC8 / #284 §C — the run's own decisions, in the order the engine made them.
   *
   * The Plan/Live/Replay mode nav dissolved into the day axis (composition correction §4), so the
   * run is now an *inspectable object*: `?sel=run:<id>`, reached from the today column's
   * "Run decisions →" header link, opening the same single Inspector everything else opens.
   * `processing_rank` is still the spine — any other order describes decisions the run never made.
   */
  it('the run inspector lists the decisions in processing_rank order', async () => {
    vi.mocked(apiDispatchToday).mockResolvedValue(view());
    vi.mocked(apiDispatchRunDecisions).mockResolvedValue({
      runId: '42',
      total: 2,
      limit: 100,
      offset: 0,
      rows: [
        {
          ticketId: 'aaaaaaaa-0000-0000-0000-000000000001',
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
        {
          ticketId: 'bbbbbbbb-0000-0000-0000-000000000002',
          zoneId: '7',
          processingRank: 2,
          status: 'UNASSIGNABLE',
          seId: null,
          seName: null,
          plantId: '5',
          plantName: 'Beta Works',
          deviceId: 'DEV-2',
          companyTier: 'SILVER',
          deviceBucket: 'WARNING',
          poolEmptyReason: 'NO_COVERAGE',
          candidatesTotal: 0,
          passedCount: 0,
        },
      ],
    });

    renderAt('/dispatch/today?sel=run:42');

    const rows = await screen.findAllByTestId(/^decision-row-/);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Acme Cement');
    expect(rows[0]).toHaveTextContent('Ramesh K.');
    // An unassignable decision is a decision — present, with the reason its pool was empty.
    expect(rows[1]).toHaveTextContent('Beta Works');
    expect(rows[1]).toHaveTextContent(/no coverage/i);
  });

  it('the run inspector says so when a run made no decisions, rather than rendering nothing', async () => {
    vi.mocked(apiDispatchToday).mockResolvedValue(view());
    vi.mocked(apiDispatchRunDecisions).mockResolvedValue({
      runId: '42',
      total: 0,
      limit: 100,
      offset: 0,
      rows: [],
    });

    renderAt('/dispatch/today?sel=run:42');

    expect(await screen.findByTestId('replay-empty')).toBeInTheDocument();
  });

  it('shows an error state with a retry rather than a blank page', async () => {
    vi.mocked(apiDispatchToday).mockRejectedValue(new Error('ZONE_REQUIRED'));
    renderPage();

    await waitFor(() => expect(screen.getByText(/Could not load/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});

/**
 * #288 — two causes now write `ESCALATION_REQUIRED`, and the strip asserts one of them in words ("no
 * capacity-eligible engineer was available"). Over a mixed list that sentence is wrong about half the
 * rows, and the action each needs is different: a capacity escalation is assigned from the queue, work
 * stranded by an unavailable engineer is reassigned on that engineer's day plan.
 */
describe('#288 — stranded work in the interception strip', () => {
  const stranded = {
    insertionId: 'i2',
    ticketId: 'eeeeeeee-0000-0000-0000-000000000000',
    slaBucket: 'CRITICAL',
    createdAt: '2026-08-25T11:50:00Z',
    insertionType: 'SE_UNAVAILABLE',
    assignedSeId: 'se-7777',
    assignedSeName: 'Ramesh Kumar',
  };

  /**
   * **Updated by Console Phase 2.4.** #288's substance is unchanged and still asserted: the row says
   * *this* engineer is unavailable, and the capacity sentence is withheld over a row it is not true of.
   * What changed is only the door. The link to `/schedules/se-7777` existed because reassigning was two
   * pages away — `assignTicket` refuses an assigned ticket, so a reassign on the holder's day plan was
   * the only path that worked. The Inspector now offers that reassign in place, and `placementOf` makes
   * the same distinction the link encoded: stranded work is formally assigned, so it resolves to PLACED
   * and is offered Reassign rather than Assign.
   */
  it('says why this row is here and offers the reassign that resolves it', async () => {
    vi.mocked(apiDispatchToday).mockResolvedValue(
      view({
        situation: { placed: 1, unassignable: 0, held: 0, criticalNeedsYou: 1, overCapacity: 0, changesToday: 0, componentBlockedWithheld: null, bucketlessDropped: null },
        escalations: [stranded],
      }),
    );
    renderPage();

    const strip = within(await screen.findByTestId('critical-interception'));
    expect(strip.getByText(/Ramesh Kumar/)).toBeInTheDocument();
    // Work somebody already holds is reassigned, never assigned — the distinction the old link carried.
    expect(strip.getByTestId(`escalation-resolve-${stranded.ticketId}`)).toHaveTextContent(/reassign/i);
    // The capacity sentence is not asserted over a row it is not true of.
    expect(screen.queryByText(/No capacity-eligible engineer was available/i)).toBeNull();
  });

  it('keeps the capacity explanation when every row really is a capacity escalation', async () => {
    vi.mocked(apiDispatchToday).mockResolvedValue(
      view({
        situation: { placed: 1, unassignable: 0, held: 0, criticalNeedsYou: 1, overCapacity: 0, changesToday: 0, componentBlockedWithheld: null, bucketlessDropped: null },
        escalations: [
          {
            insertionId: 'i1',
            ticketId: 'dddddddd-0000-0000-0000-000000000000',
            slaBucket: 'CRITICAL',
            createdAt: '2026-08-25T11:42:00Z',
            insertionType: 'SYSTEM_CRITICAL',
            assignedSeId: null,
            assignedSeName: null,
          },
        ],
      }),
    );
    renderPage();

    expect(await screen.findByText(/No capacity-eligible engineer was available/i)).toBeInTheDocument();
  });
});
