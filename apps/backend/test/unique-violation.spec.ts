import { isUniqueViolationOn, retryOnceOnUniqueViolation, uniqueViolationModel } from '../src/common/unique-violation';

/**
 * #265 — the P2002 recognition and the single retry, at their own seam.
 *
 * These live as a unit spec rather than an e2e for a reason worth stating. The `ensureSchedule` race
 * in `swapSe` / `moveTickets` needs a writer to commit **between** a `findFirst` and a `create` that
 * sit inside one interactive transaction. No injected collaborator sits in that gap — the
 * `withAudit` gate the e2e specs use opens *before* the transaction body runs, so a schedule created
 * there is simply found. Rather than assert an untested fix, or write a `Promise.all` race that
 * `test/support/concurrency.ts` explicitly warns "passes without ever having tried the case it claims
 * to cover", the retry is a small function and is tested as one.
 *
 * The error fixture below is not invented. It is the shape a real P2002 has in this repo, copied from
 * a probe run against Postgres — which matters because the field every Prisma example keys on,
 * `meta.target`, is **absent** here.
 */

/** A real P2002 from this repo's driver adapter, trimmed to the fields under test. */
const p2002 = (modelName: string, constraint: string) => ({
  code: 'P2002',
  meta: {
    modelName,
    driverAdapterError: {
      name: 'DriverAdapterError',
      cause: {
        originalCode: '23505',
        originalMessage: `duplicate key value violates unique constraint "${constraint}"`,
        kind: 'UniqueConstraintViolation',
      },
    },
  },
});

const scheduleClash = () => p2002('WorkSchedule', 'work_schedules_one_active_per_se_zone_day');
const ticketClash = () => p2002('BatchAssignmentTicket', 'batch_assignment_tickets_one_active_per_ticket');

describe('#265 — recognising a unique violation', () => {
  it('names the model a P2002 came from', () => {
    expect(uniqueViolationModel(scheduleClash())).toBe('WorkSchedule');
    expect(isUniqueViolationOn(ticketClash(), 'BatchAssignmentTicket')).toBe(true);
  });

  /**
   * The discrimination has to be *narrow*. Treating any P2002 as "the schedule race" would silently
   * retry a genuine duplicate — turning one clean failure into two attempts and a confusing error.
   */
  it('does not confuse one constraint for another, or a non-P2002 for either', () => {
    expect(isUniqueViolationOn(scheduleClash(), 'BatchAssignmentTicket')).toBe(false);
    expect(uniqueViolationModel({ code: 'P2025' })).toBeNull();
    expect(uniqueViolationModel(new Error('boom'))).toBeNull();
    expect(uniqueViolationModel(null)).toBeNull();
    expect(uniqueViolationModel(undefined)).toBeNull();
  });
});

describe('#265 — the single retry', () => {
  it('retries once when the named constraint loses, and returns the second attempt', async () => {
    let attempts = 0;
    const out = await retryOnceOnUniqueViolation('WorkSchedule', async () => {
      attempts += 1;
      if (attempts === 1) throw scheduleClash();
      return 'second';
    });
    expect(out).toBe('second');
    expect(attempts).toBe(2);
  });

  it('does not retry a call that succeeds', async () => {
    let attempts = 0;
    await retryOnceOnUniqueViolation('WorkSchedule', async () => {
      attempts += 1;
      return 'first';
    });
    expect(attempts).toBe(1);
  });

  /**
   * **Once, not until it works.** A second identical failure is no longer the race this recovers from
   * — the winner's row is committed by then, so the retry's own re-find would have seen it. Looping
   * would turn a real, persistent constraint problem into a hang under load.
   */
  it('gives up after one retry rather than looping', async () => {
    let attempts = 0;
    await expect(
      retryOnceOnUniqueViolation('WorkSchedule', async () => {
        attempts += 1;
        throw scheduleClash();
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(attempts).toBe(2);
  });

  it('rethrows anything that is not the named violation, untouched and unretried', async () => {
    let attempts = 0;
    await expect(
      retryOnceOnUniqueViolation('WorkSchedule', async () => {
        attempts += 1;
        throw ticketClash();
      }),
    ).rejects.toMatchObject({ meta: { modelName: 'BatchAssignmentTicket' } });
    expect(attempts).toBe(1);
  });
});
