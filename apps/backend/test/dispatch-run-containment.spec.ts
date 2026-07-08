import { vi } from 'vitest';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { RecommenderService } from '../src/recommender/recommender.service';
import type { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';
import { DispatchRunService } from '../src/scheduling/dispatch-run.service';

/**
 * Issue 113 AC#2 — a single bad zone must not abort the whole run. `runForActiveZones` catches a
 * per-zone failure, records it, and dispatches the remaining zones. Stubbed collaborators let us force
 * exactly one zone to throw (not reproducible against a live DB).
 */
describe('Issue 113 — DispatchRunService per-zone error containment', () => {
  it('records the failing zone and still dispatches the healthy one', async () => {
    const prisma = { plant: { findMany: vi.fn(async () => [{ zoneId: 1n }, { zoneId: 2n }]) } };
    const recommender = { runForZone: vi.fn(async () => ({})) };
    const dispatch = {
      dispatchForZone: vi
        .fn()
        .mockRejectedValueOnce(new Error('zone 1 exploded'))
        .mockResolvedValueOnce({ schedules: 1, batches: 1, tickets: 2 }),
    };

    const svc = new DispatchRunService(
      prisma as unknown as PrismaService,
      recommender as unknown as RecommenderService,
      dispatch as unknown as BatchAssignmentService,
    );

    const summary = await svc.runForActiveZones(new Date('2026-06-21T05:00:00.000Z'));

    // Zone 2 was still processed after zone 1 threw.
    expect(dispatch.dispatchForZone).toHaveBeenCalledTimes(2);
    expect(summary.zones).toBe(1); // only the healthy zone counts as dispatched
    expect(summary.tickets).toBe(2);
    expect(summary.errors).toEqual([{ zoneId: '1', message: 'zone 1 exploded' }]);
  });
});
