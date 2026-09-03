/**
 * Thrown inside an audited transaction when a guarded write matched **zero** rows — the caller lost a
 * race and the work they asked for is already done, by somebody else, differently (#265).
 *
 * **Why a throw and not a return.** These writes live inside `AuditService.withAudit`, which inserts
 * the audit row *in the same transaction* as the mutation. Returning a "nothing happened" value would
 * let that insert commit, leaving a permanent record of a withdrawal, deferral or move that never took
 * place — and #244 reads `removal_reason` as a *predicate*, so a phantom entry is an operational
 * reclassification rather than a visible mistake. Throwing rolls the whole transaction back, which is
 * exactly the required outcome: no write, no audit row, no notification.
 *
 * The catch belongs immediately outside the `withAudit` call, where it becomes the caller-facing
 * outcome — normally `NOT_FOUND`, since "the row you asked me to act on is no longer live" is the same
 * answer the caller's own pre-read would have produced a moment later. It is deliberately **not** a
 * new member of the outcome unions: #265 changes no contract, only which 500s become honest 4xxs.
 */
export class LostRaceError extends Error {
  constructor(what: string) {
    super(`lost race: ${what}`);
    this.name = 'LostRaceError';
  }
}

/**
 * True when `e` is a Postgres **deadlock** (SQLSTATE 40P01) — the loser of a lock-order cycle (#327).
 *
 * A deadlock belongs in this file rather than beside the unique-violation helpers: like
 * {@link LostRaceError} it means *this transaction lost a race and rolled back whole*, and the caller's
 * only correct move is to answer with the conflict its door already has. The difference is who picked
 * the loser — a guard we wrote, or Postgres.
 *
 * **The shape is measured, not assumed** (the same trap `uniqueViolationModel` documents). Under this
 * repo's driver adapter a 40P01 arrives with **no Prisma `code`** and no `meta`; the SQLSTATE is on
 * `cause` alone:
 *
 * ```
 * DriverAdapterError: deadlock detected
 *   cause = { originalCode: '40P01', originalMessage: 'deadlock detected', kind: 'postgres',
 *             code: '40P01', severity: 'ERROR', detail: 'Process N waits for ShareLock …' }
 * ```
 *
 * `P2034` is checked too — Prisma's own "write conflict or deadlock" code, which is what a deadlock
 * raised through a different query path would surface as — so a future driver change degrades to a
 * recognised conflict rather than to a 500.
 */
export function isDeadlock(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const err = e as { code?: unknown; cause?: { code?: unknown; originalCode?: unknown } };
  if (err.code === 'P2034') return true;
  const cause = err.cause;
  if (typeof cause !== 'object' || cause === null) return false;
  return cause.code === '40P01' || cause.originalCode === '40P01';
}

/**
 * Guard a terminal stamp: apply it only while the row is still live, and lose cleanly if it is not.
 *
 * The repo's racy idiom is `read → check in JS → update by primary key`, which under READ COMMITTED
 * lets a second writer silently overwrite the first. Putting `removedAt: null` back in the `where`
 * lets the database pick the single winner — the same guard the 04:00 closure recycle already applies
 * to its own writes (`schedule-closure-scheduler.service.ts:255-265`), now applied by the paths that
 * were racing it.
 */
export async function stampOnceOrLose(
  delegate: { updateMany(args: { where: never; data: never }): Promise<{ count: number }> },
  where: unknown,
  data: unknown,
  what: string,
): Promise<void> {
  const { count } = await delegate.updateMany({ where: where as never, data: data as never });
  if (count === 0) throw new LostRaceError(what);
}
