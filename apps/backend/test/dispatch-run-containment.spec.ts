import { vi } from 'vitest';
import type { AuditService } from '../src/audit/audit.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { RecommenderService } from '../src/recommender/recommender.service';
import type { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';
import { DispatchRunService } from '../src/scheduling/dispatch-run.service';
import { expectRan } from './dispatch-outcome';

/**
 * Issue 113 AC#2 — a single bad zone must not abort the whole run. `runForActiveZones` catches a
 * per-zone failure, records it, and dispatches the remaining zones. Stubbed collaborators let us force
 * exactly one zone to throw (not reproducible against a live DB). The prisma stub also carries the
 * transparency-ledger surface (dispatch_runs / dispatch_run_zones / config-snapshot reads) the run
 * now writes through.
 *
 * #259 — the stub grew the admission surface too: `$transaction` (the run row and its claims are taken
 * together), `$executeRaw` (the claim insert, whose row count IS the admission decision — 1 here, so
 * both zones are admitted) and `$queryRaw` (the holder read, empty because nothing else is running).
 */
describe('Issue 113 — DispatchRunService per-zone error containment', () => {
  it('records the failing zone and still dispatches the healthy one', async () => {
    const prisma = {
      plant: { findMany: vi.fn(async () => [{ zoneId: 1n }, { zoneId: 2n }]) },
      dispatchRun: {
        create: vi.fn(async () => ({ runId: 99n })),
        update: vi.fn(async () => ({})),
        // #261 — the run finalize is now conditional on the row still being RUNNING, and admission
        // reaps before it claims. Nothing is stale in this fake, so the reap finds no rows.
        updateMany: vi.fn(async () => ({ count: 1 })),
        findMany: vi.fn(async () => []),
      },
      dispatchRunZone: {
        create: vi.fn(async () => ({})),
        update: vi.fn(async () => ({})),
        updateMany: vi.fn(async () => ({ count: 0 })),
        // #286 — the reap now looks for stranded claims by predicate (`RUNNING` under a run that is
        // not), rather than by the run-id list it had just aborted. Nothing is stranded in this fake.
        findMany: vi.fn(async () => []),
      },
      priorityRuleConfig: { findMany: vi.fn(async () => []) },
      systemSetting: { findMany: vi.fn(async () => []) },
      engineerMaster: { findMany: vi.fn(async () => []) },
      companyTierOverride: { findMany: vi.fn(async () => []) },
      // Every zone is free: no holder rows come back, and each claim insert affects one row.
      $queryRaw: vi.fn(async () => []),
      $executeRaw: vi.fn(async () => 1),
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
    };
    const recommender = { runForZone: vi.fn(async () => ({})) };
    const dispatch = {
      dispatchForZone: vi
        .fn()
        .mockRejectedValueOnce(new Error('zone 1 exploded'))
        .mockResolvedValueOnce({ schedules: 1, batches: 1, tickets: 2 }),
    };
    const audit = { record: vi.fn(async () => undefined) };

    const svc = new DispatchRunService(
      prisma as unknown as PrismaService,
      recommender as unknown as RecommenderService,
      dispatch as unknown as BatchAssignmentService,
      audit as unknown as AuditService,
    );

    const summary = expectRan(await svc.runForActiveZones(new Date('2026-06-21T05:00:00.000Z')));

    // Zone 2 was still processed after zone 1 threw.
    expect(dispatch.dispatchForZone).toHaveBeenCalledTimes(2);
    expect(summary.zones).toBe(1); // only the healthy zone counts as dispatched
    expect(summary.tickets).toBe(2);
    expect(summary.errors).toEqual([{ zoneId: '1', message: 'zone 1 exploded' }]);
    // Both zones report an outcome — the failure is contained, not hidden.
    expect(summary.zoneOutcomes).toEqual([
      { zoneId: '1', outcome: 'ERROR' },
      { zoneId: '2', outcome: 'DONE' },
    ]);

    // Both zones were claimed at admission, and both claims were closed — the contained failure as an
    // error row — and the run finalized.
    //
    // #261 re-pointed these three counts, not their meaning: both the per-zone finalize and the run
    // finalize became `updateMany` keyed on the row still being RUNNING, so a run reaped mid-flight
    // cannot overwrite the reaper's verdict. The zone count is 3 rather than 2 because the `finally`
    // release runs on the clean path too and matches nothing — which is the property #259 relies on.
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
    expect(prisma.dispatchRunZone.updateMany).toHaveBeenCalledTimes(3);
    expect(prisma.dispatchRunZone.update).not.toHaveBeenCalled();
    expect(prisma.dispatchRunZone.create).not.toHaveBeenCalled(); // no zone was contended
    // Three writes to the run row: one beat per zone finished (#261 — a run's silence is bounded by its
    // slowest single zone, not by its whole length) plus the one conditional finalize.
    expect(prisma.dispatchRun.updateMany).toHaveBeenCalledTimes(3);
    expect(prisma.dispatchRun.update).not.toHaveBeenCalled();
    // Nothing was stale, so the admission reap read the ledger and wrote nothing.
    expect(prisma.dispatchRun.findMany).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledTimes(2);
  });
});
