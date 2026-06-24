import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { SeAvailabilityService } from '../src/engineers/se-availability.service';

/**
 * Issue 26 AC#4/#5 — SOFT_UNAVAILABLE. An SE sets a from/to window from mobile; during it the SE is
 * non-AVAILABLE (so the Recommender excludes them — same Hard-Filter path proven in
 * recommender-availability) and at `window_end` availability auto-reverts to AVAILABLE with no cron:
 * the time-windowed model returns the active window's status, else AVAILABLE.
 */
const NS = Date.now();

describe('Issue 26 — SOFT_UNAVAILABLE window + auto-revert', () => {
  let prisma: PrismaService;
  let svc: SeAvailabilityService;
  let zoneId: bigint;
  let se: string;
  const userIds: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    svc = new SeAvailabilityService(prisma);
    zoneId = (await prisma.zone.create({ data: { name: 'Z-su-' + NS } })).zoneId;
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SU SE ' + NS, role: 'SERVICE_ENGINEER', phone: 'su-' + tag, email: `${tag}-${NS}@su.test`, zoneId },
    });
    se = u.userId;
    userIds.push(se);
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
  });

  afterAll(async () => {
    await prisma.seAvailability.deleteMany({ where: { seId: { in: userIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('an SE sets a SOFT_UNAVAILABLE window; it is active mid-range and auto-reverts after to_ts', async () => {
    const out = await svc.setAvailability(
      {
        seId: se,
        status: 'SOFT_UNAVAILABLE',
        windowStart: new Date('2026-06-26T09:00:00Z'),
        windowEnd: new Date('2026-06-26T17:00:00Z'),
      },
      { userId: se, role: 'SERVICE_ENGINEER', zoneId: Number(zoneId) },
    );
    expect(out.result).toBe('OK');

    expect(await svc.currentStatus(se, new Date('2026-06-26T12:00:00Z'))).toBe('SOFT_UNAVAILABLE');
    // Auto-revert — no record write needed; the window simply lapses.
    expect(await svc.currentStatus(se, new Date('2026-06-26T18:00:00Z'))).toBe('AVAILABLE');
    expect(await svc.currentStatus(se, new Date('2026-06-26T08:00:00Z'))).toBe('AVAILABLE');
  });
});
