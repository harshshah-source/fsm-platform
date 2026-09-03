import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { seedDevWalkFixtures } from './auth/dev-fixture-seed';
import { PrismaClient } from './generated/prisma/client';

/**
 * Walkable dev fixtures entrypoint (#336). Run with:
 *   npm run build && npm run seed:dev-fixtures
 *
 * A THIRD entrypoint, deliberately, after `seed` (reference/org data) and `seed:dev` (the
 * `*@fsm.test` logins). `seed:dev` gives you accounts; this gives the Service-Engineer account
 * something to be. Without it the SE authenticates and every SE-facing route 404s, which is the state
 * that left 17 findings in the 2026-09-02 module-gap survey unresolvable for want of data.
 *
 * It is separate rather than folded into `seed:dev` because the rows it writes are operational, not
 * credential: an engineer and their coverage, verification runs, van stock, a scoped tier override, a
 * pending leave request. The dev database is an ingested mirror of production, and an operator
 * reading its engineer directory or its verification queue must not find invented rows unless they
 * asked for them. So it has its own opt-in, `SEED_DEV_WALK_FIXTURES` — see
 * `auth/dev-fixture-seed.config.ts`.
 *
 * Sequence: `prisma migrate deploy` → `npm run seed` → `npm run seed:dev` → `npm run seed:dev-fixtures`.
 * Idempotent — safe to re-run; every block guards itself and a second run reports zeroes.
 */

/** Host + database only — the connection string carries a password, and the question this answers is
 *  "am I pointed at the right database". Same reasoning as `seed-dev.ts`. */
function describeTarget(connectionString: string | undefined): string {
  if (!connectionString) return '(DATABASE_URL is not set)';
  try {
    const url = new URL(connectionString);
    return `${url.host}${url.pathname}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  try {
    await prisma.$connect();
    const summary = await seedDevWalkFixtures(prisma, process.env);
    const created = Object.values(summary).reduce((a, b) => a + b, 0);

    // eslint-disable-next-line no-console
    console.log(
      [
        `Walkable dev fixtures on ${describeTarget(connectionString)} — ${created} row(s) created:`,
        `  engineer_master:         ${summary.engineer}`,
        `  se_coverage:             ${summary.coverage}`,
        `  se_van_stock:            ${summary.vanStock}  (common kit minus one item, on purpose)`,
        `  leave_requests:          ${summary.leaveRequest}`,
        `  company_tier_overrides:  ${summary.tierOverride}  (scoped + expiring; the company's own tier is untouched)`,
        `  verification_runs:       ${summary.verificationRuns}`,
        created === 0
          ? 'Nothing to do — the fixtures are already in place. This never rewrites what it finds.'
          : 'The tier override expires on its own; cancel it to revert early.',
      ].join('\n'),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  // A refusal is an expected outcome with an actionable message, not a crash: print the message
  // alone, without a stack trace that buries it.
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
