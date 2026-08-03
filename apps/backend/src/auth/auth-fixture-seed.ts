import type { $Enums, PrismaClient } from '../generated/prisma/client';
import { ensureCredential } from './credential-seed';

/**
 * Issue #91 S2 — the dev/test fixture users that used to live only in `InMemoryUserStore`, now real
 * `users` (+ `user_credentials`) rows so DB-backed login can resolve them. Same emails, same UUIDs,
 * same password ('correct-password') as the retired in-memory seed, so `login.e2e-spec.ts`,
 * `refresh.e2e-spec.ts`, `per-zone-zm-logins.e2e-spec.ts` and every other spec that logs in as
 * `zm.north@fsm.test` / `ops.head@fsm.test` / etc. keep passing unmodified through the cutover.
 *
 * Zone ids are resolved by name against the already-seeded `zones` table (`seedOrgReferenceData` runs
 * first) rather than hardcoded, but on a freshly truncated+reseeded database the insertion order
 * (North/South/East/West/UNZONED) still yields North=1 — the value every existing spec asserts.
 *
 * Test/dev fixture only — never wired into the production `src/seed.ts` entrypoint, so a `pnpm seed`
 * run against a real database can never mint `*@fsm.test` credentials there.
 */
const FIXTURE_PASSWORD = 'correct-password';

interface FixtureUser {
  userId: string;
  email: string;
  name: string;
  phone: string;
  role: $Enums.Role;
  zoneName: string | null;
}

const FIXTURE_USERS: FixtureUser[] = [
  {
    userId: '11111111-1111-1111-1111-111111111111',
    email: 'zm.north@fsm.test',
    name: 'ZM North',
    phone: 'fx-zm-north',
    role: 'ZONAL_MANAGER',
    zoneName: 'North',
  },
  {
    userId: '11111111-1111-1111-1111-111111111112',
    email: 'zm.south@fsm.test',
    name: 'ZM South',
    phone: 'fx-zm-south',
    role: 'ZONAL_MANAGER',
    zoneName: 'South',
  },
  {
    userId: '11111111-1111-1111-1111-111111111113',
    email: 'zm.east@fsm.test',
    name: 'ZM East',
    phone: 'fx-zm-east',
    role: 'ZONAL_MANAGER',
    zoneName: 'East',
  },
  {
    userId: '11111111-1111-1111-1111-111111111114',
    email: 'zm.west@fsm.test',
    name: 'ZM West',
    phone: 'fx-zm-west',
    role: 'ZONAL_MANAGER',
    zoneName: 'West',
  },
  {
    userId: '22222222-2222-2222-2222-222222222222',
    email: 'se.north@fsm.test',
    name: 'SE North',
    phone: 'fx-se-north',
    role: 'SERVICE_ENGINEER',
    zoneName: 'North',
  },
  {
    userId: '33333333-3333-3333-3333-333333333333',
    email: 'ops.head@fsm.test',
    name: 'Operations Head',
    phone: 'fx-ops-head',
    role: 'OPERATIONS_HEAD',
    zoneName: null,
  },
  {
    userId: '44444444-4444-4444-4444-444444444444',
    email: 'csm@fsm.test',
    name: 'Central Service Manager',
    phone: 'fx-csm',
    role: 'CENTRAL_SERVICE_MANAGER',
    zoneName: null,
  },
  {
    userId: '55555555-5555-5555-5555-555555555555',
    email: 'wm@fsm.test',
    name: 'Warehouse Manager',
    phone: 'fx-wm',
    role: 'WAREHOUSE_MANAGER',
    zoneName: null,
  },
];

export async function seedAuthFixtureUsers(prisma: PrismaClient): Promise<number> {
  const zoneRows = await prisma.zone.findMany({
    where: { name: { in: FIXTURE_USERS.map((f) => f.zoneName).filter((n): n is string => n !== null) } },
  });
  const zoneIdByName = new Map(zoneRows.map((z) => [z.name, z.zoneId]));

  let count = 0;
  for (const fixture of FIXTURE_USERS) {
    const zoneId = fixture.zoneName === null ? null : (zoneIdByName.get(fixture.zoneName) ?? null);

    await prisma.user.upsert({
      where: { userId: fixture.userId },
      create: {
        userId: fixture.userId,
        name: fixture.name,
        role: fixture.role,
        phone: fixture.phone,
        email: fixture.email,
        zoneId: zoneId ?? undefined,
      },
      update: {},
    });

    await ensureCredential(prisma, fixture.userId, FIXTURE_PASSWORD);
    count++;
  }

  return count;
}
