import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { runDevSeed } from './auth/dev-seed';
import { PrismaClient } from './generated/prisma/client';

/**
 * Dev-login seed entrypoint (#194). Run with:
 *   npm run build && npm run seed:dev
 *
 * Deliberately a SECOND entrypoint rather than a step inside `src/seed.ts`. `npm run seed` is the
 * reference/org seed and is expected to be run against real databases; it must never be able to mint
 * `*@fsm.test` credentials. This one can, which is why it refuses unless `ALLOW_DEV_SEED` is set and
 * always refuses under `NODE_ENV=production` — see `auth/dev-seed.config.ts` for the full reasoning.
 *
 * Sequence: `prisma migrate deploy` → `npm run seed` → `npm run seed:dev` → `npm start`.
 * Idempotent — safe to re-run, and it never rotates an existing password.
 */

/** Host + database only. The connection string carries a password; printing it here would leak it
 *  into shell history and CI logs, and the point of echoing anything is "am I pointed at the right
 *  database", which host/db answers. */
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
    const summary = await runDevSeed(prisma, process.env);
    // eslint-disable-next-line no-console
    console.log(
      [
        `Seeded ${summary.accounts} dev login(s) on ${describeTarget(connectionString)}:`,
        ...summary.emails.map((email) => `  - ${email}`),
        summary.usedDefaultPassword
          ? '  password: correct-password (the well-known default; set DEV_SEED_PASSWORD to replace it)'
          : '  password: from DEV_SEED_PASSWORD',
        'Existing credentials were left untouched — this never rotates a password.',
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
