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
