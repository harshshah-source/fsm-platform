import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client';
import { seedOrgReferenceData } from './org/org-seed';

/**
 * Standalone reference/org seed entrypoint (Issue 02 AC#7). Run with:
 *   node -r dotenv/config dist/seed.js   (after build)
 * or via the `seed` package script. Idempotent — safe to re-run.
 */
async function main(): Promise<void> {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  try {
    await prisma.$connect();
    const summary = await seedOrgReferenceData(prisma);
    // eslint-disable-next-line no-console
    console.log('Seeded org reference data:', summary);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Seed failed:', err);
  process.exitCode = 1;
});
