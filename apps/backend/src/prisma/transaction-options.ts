/**
 * #262 item 5 — the interactive-transaction budget, stated as a policy.
 *
 * Prisma's unconfigured defaults are `maxWait` 2 s and `timeout` **5 s**, and no `transactionOptions`
 * were set anywhere in this repo. Nothing ever hit the ceiling because test fixtures are small; a
 * production-sized zone dispatch was a single transaction doing roughly three round-trips per ticket,
 * and it would abort on the timer with an error naming nothing about the work it lost.
 *
 * #262's real fix is shrinking that transaction from the zone to one SE, which makes its duration a
 * function of `daily_capacity` rather than of zone size. This exists because a budget nobody chose is
 * still a cliff: the numbers below are now a decision on the record, in one place, rather than a
 * property of the library version.
 */

/**
 * 15 s. Generous enough that a per-SE transaction bounded by `daily_capacity` cannot approach it, and
 * tight enough that a genuinely stuck transaction surfaces as an error well before the 60 s
 * `idle_in_transaction_session_timeout` reclaims its pooled connection.
 *
 * Deliberately far below `DB_STATEMENT_TIMEOUT_MS` (120 s): that bounds one *stuck statement*, this
 * bounds a whole *interactive transaction*, which holds a connection across round-trips and is the
 * scarcer resource.
 */
export const DEFAULT_TX_TIMEOUT_MS = 15_000;

/**
 * 5 s, matching `DB_POOL_ACQUIRE_TIMEOUT_MS` on purpose. Both answer the same question — how long a
 * caller waits for a connection before being told the server is saturated — and answering it two
 * different ways would make the backpressure signal arrive at two different times depending on which
 * queue the caller happened to be in.
 */
export const DEFAULT_TX_MAX_WAIT_MS = 5_000;

export function transactionOptions(): { maxWait: number; timeout: number } {
  return { maxWait: DEFAULT_TX_MAX_WAIT_MS, timeout: DEFAULT_TX_TIMEOUT_MS };
}
