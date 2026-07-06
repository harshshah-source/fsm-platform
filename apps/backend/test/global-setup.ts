import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { seedOrgReferenceData } from '../src/org/org-seed';
import { testDatabaseUrl } from './test-db-url';

/**
 * Vitest globalSetup — runs ONCE before any worker. Brings the isolated test database (see
 * `test-db-url.ts`) to the exact baseline the suite is written against: committed migrations applied
 * + idempotent org/reference seed. The sibling DB itself (and its PostGIS extension) is a one-time
 * superuser bootstrap documented in `.env.example`; if it is missing, `migrate deploy` fails here
 * with a clear connection error pointing at the bootstrap step.
 */
export default async function setup(): Promise<void> {
  const url = testDatabaseUrl();
  const env = { ...process.env, DATABASE_URL: url };

  // 1) apply committed migrations to the isolated test DB (idempotent — no-op when up to date)
  execFileSync('npx', ['--no-install', 'prisma', 'migrate', 'deploy'], {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
    shell: true,
  });

  // 2) idempotent org/reference seed — the same entrypoint as `npm run seed` (src/seed.ts)
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    await prisma.$connect();
    await seedOrgReferenceData(prisma);
  } finally {
    await prisma.$disconnect();
  }
}
