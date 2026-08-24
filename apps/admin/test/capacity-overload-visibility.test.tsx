import type { SessionView } from '@fsm/shared';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { engineerOptionLabel } from '../src/lib/capacity';
import { SeManagementPage } from '../src/pages/engineers/SeManagementPage';
import { PlannerPage } from '../src/pages/planner/PlannerPage';
import { SchedulesPage } from '../src/pages/schedules/SchedulesPage';

/**
 * #269 — capacity overload **visibility** on the admin surfaces a manager assigns and reviews work on.
 *
 * `dailyCapacity` has been on `ZoneEngineer` and `EngineerListRow` since Issue 13b and was rendered in
 * **zero** places, because it had no numerator: the only way to learn an SE's load was to count batch
 * rows by hand. #269 supplies `committed` from the one shared definition the recommender enforces
 * against, and these surfaces show `committed / dailyCapacity` in the same `n / cap` vocabulary the
 * dispatch-transparency decision trace already uses for its snapshot ("SE load at decision: 4 / 6").
 *
 * **Marked at `committed >= dailyCapacity`, not `>`.** The issue's prose says `n > cap`, but its own
 * AC — "the committed figure equals the recommender's own count" — settles it the other way: the
 * engine drops a candidate at `used >= dailyCapacity` (`hard-filters.ts`, `recommender.service.ts:443`),
 * so an SE sitting at exactly `6/6` is one the engine will not add to. Rendering them as having room
 * would put the badge back in disagreement with the enforcement it exists to mirror. Recorded in the
 * issue file rather than left as a silent reading.
 *
 * **Never a gate.** #258 Q2 makes overload an administrative right, so every marked option here stays
 * selectable and every assign button stays enabled — asserted, not assumed, because "helpfully"
 * disabling an over-capacity option is the natural next change somebody makes.
 */
const zm: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1, acted_as_role: null };

/** Two engineers either side of the line: one with room, one the engine considers full. */
const engineers = [
  { engineerId: 'se-roomy', name: 'Karan Singh', coverageType: 'MULTI_PLANT', zoneId: '1', committed: 4, dailyCapacity: 6, isActive: true },
  { engineerId: 'se-full', name: 'Amit Yadav', coverageType: 'DEDICATED', zoneId: '1', committed: 8, dailyCapacity: 6, isActive: true },
];

const plants = [{ plantId: '7', name: 'Yard-1', zoneId: '1' }];

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

const fetchMock = vi.fn();

function stubReads() {
  fetchMock.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes('/schedules/engineers')) return json(engineers);
    if (u.includes('/schedules')) return json([]);
    if (u.includes('/planner/plants')) return json(plants);
    if (u.includes('/planner')) return json([]);
    return json([]);
  });
  vi.stubGlobal('fetch', fetchMock);
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-06-22T08:00:00'));
  stubReads();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

/**
 * The SE Planner grid — the one surface the v2 reference already draws this on (reference 16): a
 * rightmost `LOAD / CAP` column reading `13/6` in the critical tone, over an `OVER SOFT CAP` KPI tile
 * counting the engineers above it. Built to the image; not redesigned.
 */
describe('#269 — SE Planner grid load / cap column', () => {
  it('shows each SE\'s committed load over their capacity for the day', async () => {
    render(
      <AuthProvider initialSession={zm}>
        <MemoryRouter>
          <PlannerPage />
        </MemoryRouter>
      </AuthProvider>,
    );

    await screen.findByRole('table', { name: /planner/i });
    expect(within(screen.getByTestId('load-se-roomy')).getByText('4/6')).toBeInTheDocument();
    expect(within(screen.getByTestId('load-se-full')).getByText('8/6')).toBeInTheDocument();
  });

  it('marks the over-capacity SE distinctly and leaves the one with room unmarked', async () => {
    render(
      <AuthProvider initialSession={zm}>
        <MemoryRouter>
          <PlannerPage />
        </MemoryRouter>
      </AuthProvider>,
    );

    await screen.findByRole('table', { name: /planner/i });
    // The distinction is announced, not only coloured — a colour-only treatment says nothing to a
    // screen reader and nothing to a test that should be about meaning rather than a class name.
    expect(screen.getByTestId('load-se-full')).toHaveAttribute('data-over-capacity', 'true');
    expect(screen.getByTestId('load-se-roomy')).toHaveAttribute('data-over-capacity', 'false');
    expect(within(screen.getByTestId('load-se-full')).getByTitle(/over capacity/i)).toBeInTheDocument();
  });

  it('counts the engineers above capacity in the header KPI strip', async () => {
    render(
      <AuthProvider initialSession={zm}>
        <MemoryRouter>
          <PlannerPage />
        </MemoryRouter>
      </AuthProvider>,
    );

    await screen.findByRole('table', { name: /planner/i });
    const tile = within(screen.getByTestId('planner-over-capacity'));
    expect(tile.getByText(/over capacity/i)).toBeInTheDocument();
    expect(tile.getByText('1')).toBeInTheDocument(); // se-full only — se-roomy at 4/6 has room
  });
});

/**
 * The `engineerOptionLabel` text format — the one helper every `<option>`-based picker in the app
 * shares (the Swap/Reassign/Split targets on the schedule detail, the commissioning-cohort per-device
 * assign, the Assign Work Console's lane picker). An `<option>` can carry neither a badge nor a colour,
 * so the over-capacity treatment is words, entirely in this string. Pinned directly against the pure
 * helper (#277) rather than through a specific host — `CriticalQueue`, the one host this block used to
 * render through, is retired (absorbed into the console per #277); the option must stay selectable,
 * never gated, which the console's own commit path proves independently (`assign-console.test.tsx`,
 * "states an over-capacity lane in words on the review screen, and still allows the commit").
 */
describe('#269 — engineerOptionLabel names the over-capacity case in words', () => {
  it('labels a roomy engineer with just their load', () => {
    expect(engineerOptionLabel({ engineerId: 'se-roomy', name: 'Karan Singh', committed: 4, dailyCapacity: 6 })).toBe(
      'Karan Singh — 4/6',
    );
  });

  it('names the over-capacity case in words, on the same option — never disabled, never hidden', () => {
    expect(engineerOptionLabel({ engineerId: 'se-full', name: 'Amit Yadav', committed: 8, dailyCapacity: 6 })).toBe(
      'Amit Yadav — 8/6 · over capacity',
    );
  });

  it('falls back to the id when no name is available, and to the bare name with no load data', () => {
    expect(engineerOptionLabel({ engineerId: 'se-x', committed: 4, dailyCapacity: 6 })).toBe('se-x — 4/6');
    expect(engineerOptionLabel({ engineerId: 'se-y', name: 'No Load Data' })).toBe('No Load Data');
  });
});

/**
 * The SE Management directory — the third named surface. Its "Active Tickets" column has always shown
 * a bare count with no reference point ("4" means nothing until you know the cap is 6 or 3), and
 * `dailyCapacity` sat unused on the very same row. #269 gives the count its denominator; the backend
 * change beneath it is what makes the number honest for *today* rather than for every live plan.
 */
const DIRECTORY = [
  { seId: 'se-roomy', name: 'Karan Singh', zoneId: '1', coverageType: 'DEDICATED', activityStatus: 'BUSY', availabilityStatus: 'AVAILABLE', activeTicketCount: 4, kitComplete: true, missingKit: [], dailyCapacity: 6, isActive: true },
  { seId: 'se-full', name: 'Amit Yadav', zoneId: '1', coverageType: 'FLOATING', activityStatus: 'BUSY', availabilityStatus: 'AVAILABLE', activeTicketCount: 8, kitComplete: true, missingKit: [], dailyCapacity: 6, isActive: true },
];

describe('#269 — SE directory load column', () => {
  it('shows the day load against capacity and marks the SE the engine considers full', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('/engineers/') ) return json(DIRECTORY[0]);
      if (u.includes('/engineers')) return json(DIRECTORY);
      return json([]);
    });

    render(
      <AuthProvider initialSession={zm}>
        <MemoryRouter>
          <SeManagementPage />
        </MemoryRouter>
      </AuthProvider>,
    );

    await screen.findByText('Karan Singh');
    expect(within(screen.getByTestId('load-se-roomy')).getByText('4/6')).toBeInTheDocument();
    expect(within(screen.getByTestId('load-se-full')).getByText('8/6')).toBeInTheDocument();
    expect(screen.getByTestId('load-se-full')).toHaveAttribute('data-over-capacity', 'true');
    expect(screen.getByTestId('load-se-roomy')).toHaveAttribute('data-over-capacity', 'false');
  });
});

/**
 * The ZM Batch Schedule list — the last surface #269 names. Reference 12 draws no load column here,
 * and this deliberately adds nothing else: one `Load / Cap` column joined onto the existing rows.
 *
 * **It does not reuse `ScheduleRow.ticketCount`,** which is the trap this issue exists to close.
 * `ticketCount` counts one *schedule*; a floating SE working two zones has two, and the column would
 * then show a fraction of the load beside a whole-day cap. The page therefore joins the same
 * `/schedules/engineers` payload every picker reads, so the number here is the number there.
 */
const SCHEDULE_ROWS = [
  { scheduleId: '1', seId: 'se-roomy', seName: 'Karan Singh', zoneId: '1', zoneName: 'West', dateFrom: '2026-06-22', dateTo: '2026-06-22', status: 'ACTIVE', batchCount: 2, ticketCount: 3 },
  { scheduleId: '2', seId: 'se-full', seName: 'Amit Yadav', zoneId: '1', zoneName: 'West', dateFrom: '2026-06-22', dateTo: '2026-06-22', status: 'ACTIVE', batchCount: 3, ticketCount: 5 },
];

describe('#269 — ZM batch-schedule list load column', () => {
  it('shows whole-day load against capacity, not the single schedule ticket count', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('/schedules/engineers')) return json(engineers);
      if (u.includes('/schedules')) return json(SCHEDULE_ROWS);
      return json([]);
    });

    render(
      <AuthProvider initialSession={zm}>
        <MemoryRouter>
          <SchedulesPage />
        </MemoryRouter>
      </AuthProvider>,
    );

    await screen.findByText('Karan Singh');
    // 4/6 and 8/6 — the committed day load. NOT this schedule's 3 and 5.
    expect(within(screen.getByTestId('load-se-roomy')).getByText('4/6')).toBeInTheDocument();
    expect(within(screen.getByTestId('load-se-full')).getByText('8/6')).toBeInTheDocument();
    expect(screen.getByTestId('load-se-full')).toHaveAttribute('data-over-capacity', 'true');
  });
});
