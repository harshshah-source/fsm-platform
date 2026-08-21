/**
 * Which model's unique constraint a Prisma error violated, or null if it is not one (#265).
 *
 * **Why this is not the usual `meta.target` check.** Under this repo's driver adapter, a P2002 arrives
 * with **no `meta.target` at all** — the field every Prisma example keys on. The constraint identity is
 * instead at `meta.driverAdapterError.cause.constraint.fields` (column names) with the index name only
 * in the raw message text. Measured, not assumed:
 *
 * ```
 * code=P2002 meta={"modelName":"BatchAssignmentTicket","driverAdapterError":{...,"cause":{
 *   "originalMessage":"duplicate key value violates unique constraint
 *     \"batch_assignment_tickets_one_active_per_ticket\"",
 *   "constraint":{"fields":["ticket_id"]}}}}
 * ```
 *
 * So `modelName` is the discriminator, and here it is an **exact** one: the two tables this guards —
 * `batch_assignment_tickets` and `work_schedules` — each carry exactly one unique constraint, a raw
 * partial index invisible to `schema.prisma`. Should either ever gain a second, this must start reading
 * `constraint.fields`; the assertion is called out here rather than left implicit.
 *
 * **A caller cannot recover in place.** A P2002 raised inside an interactive transaction aborts it —
 * Postgres answers everything after it with *"current transaction is aborted, commands ignored until
 * end of transaction block"* — so the only correct recovery is to let the whole transaction roll back
 * and decide outside it. That rollback is also what keeps `withAudit` honest: the audit row is written
 * inside the same transaction, so a rolled-back attempt leaves no trail claiming an action that never
 * happened.
 */
export function uniqueViolationModel(e: unknown): string | null {
  if (typeof e !== 'object' || e === null) return null;
  const err = e as { code?: unknown; meta?: { modelName?: unknown } };
  if (err.code !== 'P2002') return null;
  const model = err.meta?.modelName;
  return typeof model === 'string' ? model : '';
}

/** True when `e` is a unique violation on `model` — the form the call sites actually want. */
export function isUniqueViolationOn(e: unknown, model: string): boolean {
  return uniqueViolationModel(e) === model;
}

/**
 * Run `work`, and if it loses a unique race on `model`, run it **exactly once more** (#265).
 *
 * The case this exists for: two managers assign to the same engineer, who has no schedule for the day
 * yet. `ensureSchedule` is a find-then-create, so both find nothing and both create; the loser lands
 * on `work_schedules_one_active_per_se_zone_day`. That caller has done nothing wrong — a different
 * ticket, possibly a different plant — and their intent, "get me this engineer's live schedule for the
 * day", is now satisfied by the winner's row. Failing them is a pure artefact of the implementation.
 *
 * `work` must be the **whole** transaction, not a fragment of one: a P2002 aborts the surrounding
 * Postgres transaction, so there is nothing to resume, only something to redo. Redoing it is safe
 * precisely because it rolled back whole.
 *
 * **Once, not until it works.** By the second attempt the winner's row is committed, so the retry's
 * own re-find sees it; a further identical failure is a different problem, and looping on it would
 * turn a persistent constraint error into a hang under load.
 */
export async function retryOnceOnUniqueViolation<T>(model: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e: unknown) {
    if (!isUniqueViolationOn(e, model)) throw e;
    return work();
  }
}
