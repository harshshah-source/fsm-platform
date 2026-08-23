import { describeSeSkip } from '../src/scheduling/se-skip';

/**
 * #262 AC-5 — a skip's label has to be earned.
 *
 * Before this, ANY rollback of the zone transaction was reported as `SCHEDULE_CONFLICT`, including
 * deadlocks, statement timeouts and lock contention. The ledger therefore asserted a specific,
 * checkable thing — "an SE already holds an ACTIVE schedule for this zone/day" — that was frequently
 * untrue, and an operator who went to look found no such schedule and no other explanation.
 *
 * The discriminator is **not** `e.meta.target`, which is what #262's issue text specifies and what
 * every Prisma example uses: that field does not exist under this repo's driver adapter, as #265
 * measured. `uniqueViolationModel` reads `meta.modelName`, which is what actually arrives. The error
 * literals below are the shape from #265's recorded capture, not an invention.
 */
const p2002 = (modelName: string, constraintName: string, fields: string[]): unknown =>
  Object.assign(new Error('Unique constraint failed'), {
    code: 'P2002',
    meta: {
      modelName,
      driverAdapterError: {
        cause: {
          originalMessage: `duplicate key value violates unique constraint "${constraintName}"`,
          constraint: { fields },
        },
      },
    },
  });

const SE = '11111111-1111-1111-1111-111111111111';

describe('#262 — per-SE skip labels', () => {
  it('SCHEDULE_CONFLICT only for the schedule unique', () => {
    const skip = describeSeSkip(SE, p2002('WorkSchedule', 'work_schedules_one_active_per_se_zone_day', ['se_id']));
    expect(skip.seId).toBe(SE);
    expect(skip.constraint).toBe('WorkSchedule');
    expect(skip.reason).toMatch(/^SCHEDULE_CONFLICT: /);
  });

  it('a ticket collision says so, and is never labelled SCHEDULE_CONFLICT', () => {
    const skip = describeSeSkip(
      SE,
      p2002('BatchAssignmentTicket', 'batch_assignment_tickets_one_active_per_ticket', ['ticket_id']),
    );
    expect(skip.constraint).toBe('BatchAssignmentTicket');
    expect(skip.reason).toMatch(/^TICKET_CONFLICT: /);
    expect(skip.reason).not.toContain('SCHEDULE_CONFLICT');
  });

  /**
   * The failure #262 actually expects in production: closure or bulk-unassign held the zone longer
   * than `ZONE_LOCK_TIMEOUT_MS`. "Could not get the zone lock in time" and "the database threw" call
   * for very different responses from whoever reads the ledger, so they are different sentences.
   */
  it('a lock timeout is named as one, not reported as a raw driver message', () => {
    const skip = describeSeSkip(SE, new Error('canceling statement due to lock timeout'));
    expect(skip.constraint).toBeNull();
    expect(skip.reason).toMatch(/^ZONE_LOCK_TIMEOUT: /);
  });

  it('anything else reports itself rather than borrowing a label it did not earn', () => {
    const skip = describeSeSkip(SE, new Error('deadlock detected'));
    expect(skip.constraint).toBeNull();
    expect(skip.reason).toBe('deadlock detected');
    expect(skip.reason).not.toContain('SCHEDULE_CONFLICT');
  });

  /** A non-Error rejection must not become the string "[object Object]" on an operator's screen. */
  it('survives a non-Error rejection', () => {
    expect(describeSeSkip(SE, 'something odd').reason).toBe('something odd');
  });
});
