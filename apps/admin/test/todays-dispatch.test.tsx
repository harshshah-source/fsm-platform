import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchChangesTodayView, DispatchTodayView } from '../src/api/dispatchToday';
import TodaysDispatchPage from '../src/pages/dispatch/TodaysDispatchPage';

vi.mock('../src/api/dispatchToday', async () => {
  const actual = await vi.importActual('../src/api/dispatchToday');
  return { ...actual, apiDispatchToday: vi.fn(), apiDispatchChangesToday: vi.fn() };
});

const { apiDispatchToday, apiDispatchChangesToday } = await import('../src/api/dispatchToday');

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

  it('shows an error state with a retry rather than a blank page', async () => {
    vi.mocked(apiDispatchToday).mockRejectedValue(new Error('ZONE_REQUIRED'));
    renderPage();

    await waitFor(() => expect(screen.getByText(/Could not load/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});
