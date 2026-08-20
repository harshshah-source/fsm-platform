import { PrismaService } from '../src/prisma/prisma.service';
import { SHARED_AUTH_SE_ID, SHARED_AUTH_SE_ZONE_NAME } from './fixtures/shared-auth-se';

/**
 * #215 / #187 — the shared auth SE's `engineer_master` row is **seeded state**, not spec-created state.
 *
 * `seedAuthFixtureUsers` creates the `users` row for `se.north@fsm.test` and never an `engineer_master`
 * row. Before this pin, whichever of nine specs ran first upserted that row into a **throwaway zone of
 * its own** (create-only upsert — first writer wins), so the SE's zone for the rest of the run was
 * decided by vitest scheduling. `voucher-controller` was the spec that paid: its ZM queue scopes on
 * `engineer.zoneId` (`vouchers.service.ts:217`), so it failed 3/5 alone (no row at all → 400
 * `SE_NOT_FOUND`) and 2/5 in a full sweep (row present, wrong zone → queue miss + approve 403).
 *
 * The row is now seeded once, in `test/global-setup.ts`, in the zone the `users` row already names —
 * so it exists **before any spec runs**, in a zone no spec chose. The nine specs' create-only upserts
 * became structurally unable to win, which is what closes #215's re-zoning leak by construction.
 *
 * This spec is deliberately first-class rather than an incidental assertion inside `voucher-controller`:
 * if the seed is ever removed, THIS fails naming the contract, instead of voucher-controller failing
 * with an `SE_NOT_FOUND` that takes an afternoon to re-diagnose.
 */
describe('shared auth SE — canonical engineer_master seed (#215/#187)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it('exists after global setup, before any spec has created anything', async () => {
    const row = await prisma.engineerMaster.findUnique({ where: { engineerId: SHARED_AUTH_SE_ID } });
    expect(row).not.toBeNull();
  });

  it(`sits in the '${SHARED_AUTH_SE_ZONE_NAME}' zone — the same zone the seeded users row names, and zm.north's`, async () => {
    const zone = await prisma.zone.findFirstOrThrow({ where: { name: SHARED_AUTH_SE_ZONE_NAME } });
    const user = await prisma.user.findUniqueOrThrow({ where: { userId: SHARED_AUTH_SE_ID } });
    const row = await prisma.engineerMaster.findUniqueOrThrow({ where: { engineerId: SHARED_AUTH_SE_ID } });

    expect(row.zoneId).toBe(zone.zoneId);
    // The engineer row and the users row must agree — a split-zone SE is the #215 defect in miniature.
    expect(user.zoneId).toBe(row.zoneId);
  });

  it('is DEDICATED — the classification computeResubmitOwnership() and eleven specs already rely on', async () => {
    const row = await prisma.engineerMaster.findUniqueOrThrow({ where: { engineerId: SHARED_AUTH_SE_ID } });
    expect(row.coverageType).toBe('DEDICATED');
  });
});
