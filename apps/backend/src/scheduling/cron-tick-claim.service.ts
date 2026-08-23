import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CRON_TICK_CLAIM_RETENTION_DAYS, type TickClaim, claimantId, tickWindowStart } from './cron-tick-claim';

/** Milliseconds in a day — the retention horizon is expressed in days, applied on the epoch. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * #263 — the one place a scheduled tick asks "is this window mine?".
 *
 * Every `@Cron` in this app is gated by an env flag (`BUSINESS_SWEEPS_ENABLED` /
 * `INGESTION_SCHEDULER_ENABLED`) and guarded against overlapping *itself* by a process-local
 * single-flight (`runGuarded`'s `Set`, or a boolean field). Neither of those is visible to a second
 * instance, so correctness rested entirely on the flag being set on exactly one machine — an
 * operational convention, enforced nowhere, whose violation is silent: doubled report-cube rebuilds
 * racing delete-then-insert, doubled notification sends, duplicate dispatch runs degraded to
 * LOCK_CONTENDED noise, and the recommender's `P2002 → continue` quietly dropping recommendations.
 *
 * The replacement is a row. `INSERT … ON CONFLICT DO NOTHING` against a composite primary key is the
 * admission test itself — not a check followed by an act — so exactly one instance can win a
 * `(job, minute)` window no matter how many are running.
 *
 * **This service is deliberately not a guard.** It answers a question; the caller decides what to do
 * with the answer. That keeps it wireable into seven different single-flight wrappers whose shapes,
 * outcome types and dormancy rules all differ, without any of them having to adopt the others'.
 */
@Injectable()
export class CronTickClaimService {
  private readonly logger = new Logger(CronTickClaimService.name);
  /** Resolved once: hostname, pid and build fingerprint cannot change inside a process. */
  private readonly claimant = claimantId();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Claim `jobName`'s window for the fire at `firedAt`. `{ claimed: true }` means run the sweep;
   * `{ claimed: false, heldBy }` means another instance already has it — **a no-op, not a failure**
   * (G7). The caller must not report ERROR on a refusal.
   *
   * One round trip on both paths. The CTE runs the insert and, only if it inserted nothing, reads back
   * the holder for the log line — so the winning path costs a single indexed insert and the losing
   * path does not pay for a second statement.
   *
   * A caveat worth stating rather than hiding: in READ COMMITTED the trailing `SELECT` uses the
   * statement's snapshot, so when the conflicting insert commits *after* this statement began the
   * read finds nothing and the query returns zero rows. That is still an unambiguous refusal — our
   * insert did not land — so it is reported as one, with an unknown holder. Treating a zero-row result
   * as a win is the one mistake here that would reintroduce the double-run.
   */
  async claimTick(jobName: string, firedAt: Date): Promise<TickClaim> {
    const windowStart = tickWindowStart(firedAt);
    const rows = await this.prisma.$queryRaw<{ inserted: boolean; claimed_by: string }[]>(Prisma.sql`
      WITH ins AS (
        INSERT INTO "cron_tick_claims" ("job_name", "window_start", "claimed_by")
        VALUES (${jobName}, ${windowStart}, ${this.claimant})
        ON CONFLICT ("job_name", "window_start") DO NOTHING
        RETURNING "claimed_by"
      )
      SELECT TRUE AS inserted, ins."claimed_by" FROM ins
      UNION ALL
      SELECT FALSE AS inserted, c."claimed_by"
        FROM "cron_tick_claims" c
       WHERE c."job_name" = ${jobName}
         AND c."window_start" = ${windowStart}
         AND NOT EXISTS (SELECT 1 FROM ins)
    `);

    if (rows[0]?.inserted === true) return { claimed: true };
    return { claimed: false, heldBy: rows[0]?.claimed_by ?? 'another instance' };
  }

  /**
   * Claim the window and log the refusal in one call — the shape all seven single-flight wrappers
   * want, so none of them has to write the log line (and none can forget to).
   *
   * Logged at `log`, not `warn`: with two instances deliberately enabled, a refusal every minute is
   * the system working, and a warning per minute would train an operator to ignore the channel.
   */
  async claimTickOrLog(jobName: string, firedAt: Date): Promise<boolean> {
    const claim = await this.claimTick(jobName, firedAt);
    if (claim.claimed) return true;
    this.logger.log(`${jobName} tick skipped — this window is already claimed by ${claim.heldBy}`);
    return false;
  }

  /**
   * Drop claims whose window is past the retention horizon. Piggybacked on the daily
   * partition-maintenance tick rather than given a cron of its own — a table this small does not
   * justify a nineteenth job, and #229's wiring spec exists to make adding one a deliberate act.
   *
   * Re-claimability after a prune is intended: nothing reads a claim once its tick is over, and seven
   * days is far outside any window two instances could still be racing for.
   */
  async pruneExpiredClaims(now: Date = new Date()): Promise<number> {
    const horizon = new Date(now.getTime() - CRON_TICK_CLAIM_RETENTION_DAYS * DAY_MS);
    const { count } = await this.prisma.cronTickClaim.deleteMany({ where: { windowStart: { lt: horizon } } });
    if (count > 0) this.logger.log(`pruned ${count} cron tick claim(s) older than ${horizon.toISOString()}`);
    return count;
  }
}
