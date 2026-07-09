/**
 * Guarded state transition (Issue 101 / audit CRITICAL #3).
 *
 * The repo's racy state machines use the `read → check-status-in-JS → update-by-id` idiom under READ
 * COMMITTED: two writers both pass the JS check and the second silently clobbers the first (a timed-out
 * SE's reroute overwrites an Accept, a second submit double-decrements stock, a stale write erases a
 * confirmation leg). The fix is to put the state guard in the WHERE clause and let the database decide
 * the single winner: a guarded `updateMany(where: { id, status: { in: fromStates } })` updates exactly
 * one row for the winner and **zero** for every loser — who then gets a clean CONFLICT outcome instead
 * of corrupting state. This is the same pattern the safe machines already use (soft-states, failure-cycle
 * I1, snapshot-run in-flight guard); this generalizes it into one testable primitive.
 *
 * `where` MUST carry the guard (the `status: { in: fromStates }` predicate, plus any other columns the
 * caller read and requires to be unchanged — e.g. `offeredSeId`, `retryCount`). Pass the SAME
 * transaction client the surrounding work uses so the guard and the dependent writes commit atomically.
 *
 * Returns `{ won, count }`: `won` is true iff this caller updated the row (count === 1). A `count` > 1
 * means the `where` was under-specified (missing the unique id) — treated as won but a caller bug.
 */
export interface UpdateManyDelegate<W, D> {
  updateMany(args: { where: W; data: D }): Promise<{ count: number }>;
}

export async function transitionOrConflict<W, D>(
  delegate: UpdateManyDelegate<W, D>,
  where: W,
  data: D,
): Promise<{ won: boolean; count: number }> {
  const { count } = await delegate.updateMany({ where, data });
  return { won: count > 0, count };
}
