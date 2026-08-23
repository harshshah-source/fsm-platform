/** The narrow slice of a Prisma client this module needs — so a `tx` satisfies it as readily as the root. */
export interface PrismaRawClient {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

/**
 * Is a dispatch run holding this zone right now (#259), and which one (#262).
 *
 * #259 made zone ownership a row: `dispatch_run_zones` is RUNNING from the moment a run is admitted
 * until the moment that zone finishes, behind `ux_dispatch_run_zones_one_running_per_zone`. That span
 * is the thing #262 needs, and it is strictly wider than the advisory lock's.
 *
 * **Why the advisory lock is no longer sufficient on its own.** It is `pg_advisory_xact_lock`, so it
 * lives exactly as long as the transaction that took it. While dispatch was ONE transaction per zone
 * that was the whole dispatch; #262 splits it per SE, and the lock is now released at every SE's
 * commit. The gaps between SE transactions are unguarded, and a bulk-unassign landing in one leaves a
 * half-rebalanced zone — SE1 dispatched, then unassigned, then SE2 dispatched fresh. The claim spans
 * the gaps; the lock stays as the in-transaction backstop.
 *
 * **Read, not taken.** #262's issue text says closure and bulk-unassign should *acquire* the claim "as
 * non-run holders". They cannot: a claim IS a `dispatch_run_zones` row and that row cannot exist
 * without a `dispatch_runs` parent, so acquiring one would mean either inventing fake run rows in the
 * transparency ledger or adding a second claim table — a bigger change than the problem. Respecting
 * the claim closes the interleaving window that #262 actually opened, and the advisory lock already
 * covers the other direction (a dispatch starting while a rebalance holds the zone waits, bounded by
 * `ZONE_LOCK_TIMEOUT_MS`, and skips that SE).
 */
export async function liveZoneClaimRunId(client: PrismaRawClient, zoneId: bigint): Promise<bigint | null> {
  const rows = await client.$queryRaw<Array<{ run_id: bigint }>>`
    SELECT z."run_id"
      FROM "dispatch_run_zones" z
     WHERE z."zone_id" = ${zoneId}
       AND z."status" = 'RUNNING'::"dispatch_zone_claim_status"
     LIMIT 1`;
  return rows[0]?.run_id ?? null;
}
