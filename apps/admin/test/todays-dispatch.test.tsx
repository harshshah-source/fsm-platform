import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchChangesTodayView, DispatchTodayView } from '../src/api/dispatchToday';
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
  ...over,
});

const view = (over: Partial<DispatchTodayView> = {}): DispatchTodayView => ({
  operatingDay: '2026-08-25',
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
  situation: { placed: 1, unassignable: 0, held: 0, criticalNeedsYou: 0, overCapacity: 0, changesToday: 0 },
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

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/dispatch/today']}>
      <TodaysDispatchPage />
    </MemoryRouter>,
  );

describe("#285 — Today's Dispatch cockpit", () => {
  beforeEach(() => {
    vi.mocked(apiDispatchChangesToday).mockResolvedValue(changes());
  });

  it('renders one lane per engineer, with stops in persisted order', async () => {
    vi.mocked(apiDispatchToday).mockResolvedValue(view());
    renderPage();

    expect(await screen.findByTestId('crew-card-se-1')).toBeInTheDocument();
    expect(screen.getByText('Ramesh K.')).toBeInTheDocument();
    expect(screen.getByText('Acme Cement')).toBeInTheDocument();
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

    expect(await screen.findByTestId('crew-card-se-idle')).toBeInTheDocument();
    expect(screen.getByText(/available for work/i)).toBeInTheDocument();
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
        situation: { placed: 1, unassignable: 0, held: 0, criticalNeedsYou: 1, overCapacity: 0, changesToday: 0 },
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
        situation: { placed: 42, unassignable: 3, held: 2, criticalNeedsYou: 1, overCapacity: 1, changesToday: 4 },
      }),
    );
    renderPage();

    await screen.findByTestId('crew-card-se-1');
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

    await screen.findByTestId('crew-card-se-1');
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
   * #285 AC8 / #284 §C — Replay renders the run's own decisions, in the order the engine made them.
   *
   * It shipped as a pair of links to the ledger, which was honest but was not Replay: the question
   * "what did this run decide, and in what order" had no answer on the page. `processing_rank` had
   * persisted that order the whole time.
   */
  it('replay lists the run decisions in processing_rank order', async () => {
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

    render(
      <MemoryRouter initialEntries={['/dispatch/today?mode=replay']}>
        <TodaysDispatchPage />
      </MemoryRouter>,
    );

    const rows = await screen.findAllByTestId(/^decision-row-/);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Acme Cement');
    expect(rows[0]).toHaveTextContent('Ramesh K.');
    // An unassignable decision is a decision — present, with the reason its pool was empty.
    expect(rows[1]).toHaveTextContent('Beta Works');
    expect(rows[1]).toHaveTextContent(/no coverage/i);
  });

  it('replay says so when a past run made no decisions, rather than rendering nothing', async () => {
    vi.mocked(apiDispatchToday).mockResolvedValue(view());
    vi.mocked(apiDispatchRunDecisions).mockResolvedValue({
      runId: '42',
      total: 0,
      limit: 100,
      offset: 0,
      rows: [],
    });

    render(
      <MemoryRouter initialEntries={['/dispatch/today?mode=replay']}>
        <TodaysDispatchPage />
      </MemoryRouter>,
    );

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

  it('says why this row is here and sends the manager to the day plan that owns it', async () => {
    vi.mocked(apiDispatchToday).mockResolvedValue(
      view({
        situation: { placed: 1, unassignable: 0, held: 0, criticalNeedsYou: 1, overCapacity: 0, changesToday: 0 },
        escalations: [stranded],
      }),
    );
    renderPage();

    const strip = within(await screen.findByTestId('critical-interception'));
    expect(strip.getByText(/Ramesh Kumar/)).toBeInTheDocument();
    expect(strip.getByRole('link', { name: /day plan/i })).toHaveAttribute('href', '/schedules/se-7777');
    // The capacity sentence is not asserted over a row it is not true of.
    expect(screen.queryByText(/No capacity-eligible engineer was available/i)).toBeNull();
  });

  it('keeps the capacity explanation when every row really is a capacity escalation', async () => {
    vi.mocked(apiDispatchToday).mockResolvedValue(
      view({
        situation: { placed: 1, unassignable: 0, held: 0, criticalNeedsYou: 1, overCapacity: 0, changesToday: 0 },
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
