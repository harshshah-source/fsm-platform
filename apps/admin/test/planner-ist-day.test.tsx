import { render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { addIsoDays, istIsoDate } from '../src/lib/datetime';

vi.mock('../src/api/planner', () => ({
  apiListPlannerEntries: vi.fn(() => Promise.resolve([])),
  apiListPlannerPlants: vi.fn(() => Promise.resolve([])),
  apiCreatePlannerEntry: vi.fn(() => Promise.resolve({ id: '1' })),
  apiDeletePlannerEntry: vi.fn(() => Promise.resolve()),
}));
vi.mock('../src/api/schedules', () => ({
  apiListSchedules: vi.fn(() => Promise.resolve([])),
  apiZoneEngineers: vi.fn(() => Promise.resolve([])),
}));

import { apiListPlannerEntries } from '../src/api/planner';
import { PlannerPage } from '../src/pages/planner/PlannerPage';

/** 2026-08-09T18:45:00Z is 00:15 IST on 10 Aug — inside the 5h30m band where a UTC/device-local
 *  derivation still says "9 Aug" while the backend's operating day has already rolled to the 10th. */
const AT_0015_IST = new Date('2026-08-09T18:45:00Z');

describe('#204 — IST day helpers (lib/datetime)', () => {
  it('istIsoDate returns the IST calendar date, not the UTC one, at 00:15 IST', () => {
    expect(istIsoDate(AT_0015_IST)).toBe('2026-08-10');
  });

  it('istIsoDate keeps 23:45 IST on the outgoing day', () => {
    expect(istIsoDate(new Date('2026-08-10T18:15:00Z'))).toBe('2026-08-10');
  });

  it('istIsoDate rolls at IST midnight exactly, and not a moment before', () => {
    expect(istIsoDate(new Date('2026-08-09T18:29:59Z'))).toBe('2026-08-09');
    expect(istIsoDate(new Date('2026-08-09T18:30:00Z'))).toBe('2026-08-10');
  });

  it('istIsoDate crosses a UTC month boundary that IST has already crossed', () => {
    expect(istIsoDate(new Date('2026-07-31T19:00:00Z'))).toBe('2026-08-01');
  });

  it('addIsoDays walks whole calendar days without a timezone round-trip', () => {
    expect(addIsoDays('2026-08-10', 0)).toBe('2026-08-10');
    expect(addIsoDays('2026-08-10', 6)).toBe('2026-08-16');
    expect(addIsoDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(addIsoDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('#204 — the planner window agrees with the backend at 00:15 IST', () => {
  // The device-local zone is forced to something that is NOT IST for these two tests: on an IST
  // workstation the old device-local derivation gives the right answer by coincidence, and the
  // assertions would prove nothing. Restored afterwards — `process.env.TZ` is process-wide, and vitest
  // runs sibling test files in the same worker.
  const originalTz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'UTC';
  });
  afterAll(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  beforeEach(() => {
    // Fake `Date` only — `setTimeout` must stay real or `waitFor` never resolves.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(AT_0015_IST);
    vi.mocked(apiListPlannerEntries).mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches the 7-day window starting on the IST date, not the device-local one', async () => {
    // Sanity: the environment really is not IST, so a device-local derivation would say 9 Aug.
    expect(new Date().getDate()).toBe(9);

    render(<PlannerPage />);

    await waitFor(() => expect(apiListPlannerEntries).toHaveBeenCalled());
    expect(vi.mocked(apiListPlannerEntries).mock.calls[0]).toEqual(['2026-08-10', '2026-08-16']);
  });

  it('opens the grid on the IST date and spans seven IST days', async () => {
    render(<PlannerPage />);
    await waitFor(() => expect(screen.getByLabelText('SE Planner grid')).toBeInTheDocument());
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers.slice(3)).toEqual([
      '2026-08-10',
      '2026-08-11',
      '2026-08-12',
      '2026-08-13',
      '2026-08-14',
      '2026-08-15',
      '2026-08-16',
    ]);
  });
});
