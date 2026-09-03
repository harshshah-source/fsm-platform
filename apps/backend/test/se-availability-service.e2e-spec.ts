import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { SeAvailabilityService } from '../src/engineers/se-availability.service';

/**
 * Issue 25, slice 2 — SE availability writes + the current-status derivation (CONTEXT §SE Availability).
 * `currentStatus` returns the active window's status (else AVAILABLE). `setAvailability` is writable
 * only by the Zonal Manager for an own-zone SE or by the SE for themselves — never Operations Head.
 */
const NS = Date.now();
const NOW = new Date('2026-06-25T12:00:00Z');

describe('Issue 25 slice 2 — SE availability service', () => {
  let prisma: PrismaService;
  let svc: SeAvailabilityService;

  let zoneA: bigint;
  let zoneB: bigint;
  let se: string; // in zone A
  const engineers: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    svc = new SeAvailabilityService(prisma);
    zoneA = (await prisma.zone.create({ data: { name: 'Z-saA-' + NS } })).zoneId;
    zoneB = (await prisma.zone.create({ data: { name: 'Z-saB-' + NS } })).zoneId;
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({ data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'se-' + tag, email: `se-${tag}@sas.test`, zoneId: zoneA } });
    se = u.userId;
    engineers.push(se);
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId: zoneA, dailyCapacity: 10 } });
  });

  afterAll(async () => {
    await prisma.seAvailability.deleteMany({ where: { seId: { in: engineers } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: engineers } } });
    await prisma.user.deleteMany({ where: { userId: { in: engineers } } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: [zoneA, zoneB] } } });
    await prisma.onModuleDestroy();
  });

  it('currentStatus defaults to AVAILABLE with no records', async () => {
    expect(await svc.currentStatus(se, NOW)).toBe('AVAILABLE');
  });

  it('the Zonal Manager sets own-zone availability and currentStatus reflects the active window', async () => {
    const out = await svc.setAvailability(
      { seId: se, status: 'ON_LEAVE', windowStart: new Date('2026-06-25T00:00:00Z'), windowEnd: new Date('2026-06-26T00:00:00Z'), reason: 'leave' },
      { userId: 'zm-A', role: 'ZONAL_MANAGER', zoneId: Number(zoneA) },
    );
    expect(out.result).toBe('OK');
    expect(await svc.currentStatus(se, NOW)).toBe('ON_LEAVE');
    // Outside the window it is AVAILABLE again.
    expect(await svc.currentStatus(se, new Date('2026-06-27T00:00:00Z'))).toBe('AVAILABLE');
  });

  it('forbids a ZM from another zone and Operations Head; allows the SE for themselves', async () => {
    const otherZm = await svc.setAvailability(
      { seId: se, status: 'OFF_SHIFT', windowStart: NOW },
      { userId: 'zm-B', role: 'ZONAL_MANAGER', zoneId: Number(zoneB) },
    );
    expect(otherZm.result).toBe('FORBIDDEN');

    const opsHead = await svc.setAvailability(
      { seId: se, status: 'OFF_SHIFT', windowStart: NOW },
      { userId: 'ops', role: 'OPERATIONS_HEAD', zoneId: null },
    );
    expect(opsHead.result).toBe('FORBIDDEN');

    const self = await svc.setAvailability(
      { seId: se, status: 'SOFT_UNAVAILABLE', windowStart: NOW },
      { userId: se, role: 'SERVICE_ENGINEER', zoneId: Number(zoneA) },
    );
    expect(self.result).toBe('OK');
  });

  it('forbids an SE from setting another SE', async () => {
    const out = await svc.setAvailability(
      { seId: se, status: 'OFF_SHIFT', windowStart: NOW },
      { userId: 'someone-else', role: 'SERVICE_ENGINEER', zoneId: Number(zoneA) },
    );
    expect(out.result).toBe('FORBIDDEN');
  });

  /**
   * #363 AC1 — the correction has to win.
   *
   * Availability is append-only: a manager who got a day wrong does not edit the window, they write a
   * new one over the same day. Ordered on `windowStart` alone those two rows are tied, and which of
   * them the database hands back first is unspecified — so `currentStatus` (and with it the Recommender
   * hard filter) could keep reading the row the manager had just corrected, while `listWindows` — the
   * same query behind the manager's own screen — showed the correction on top. The screen and the
   * dispatch decision disagreed, and the dispatch decision won.
   *
   * All three reads take the same secondary key (`id desc` = last written), so "latest write for the
   * day" means one thing across the service.
   */
  it('#363 AC1 — with two windows on the same day the latest write wins in currentStatus, currentStatusMany and listWindows', async () => {
    const seTie = await makeSe('tie');
    const windowStart = new Date('2026-07-01T00:00:00Z');
    const windowEnd = new Date('2026-07-02T00:00:00Z');
    const zm = { userId: 'zm-A', role: 'ZONAL_MANAGER', zoneId: Number(zoneA) };

    const filed = await svc.setAvailability({ seId: seTie, status: 'ON_LEAVE', windowStart, windowEnd, reason: 'filed in error' }, zm);
    const correction = await svc.setAvailability({ seId: seTie, status: 'AVAILABLE', windowStart, windowEnd, reason: 'correction' }, zm);
    expect(filed.result).toBe('OK');
    expect(correction.result).toBe('OK');
    expect(Number(correction.id)).toBeGreaterThan(Number(filed.id));

    const midDay = new Date('2026-07-01T12:00:00Z');
    expect(await svc.currentStatus(seTie, midDay)).toBe('AVAILABLE');
    expect((await svc.currentStatusMany([seTie], midDay)).get(seTie)).toBe('AVAILABLE');
    // The manager's own list — the read that was already right — still leads with the correction.
    expect((await svc.listWindows(seTie))[0]).toMatchObject({ status: 'AVAILABLE', reason: 'correction' });
  });

  /** A second engineer for a test that must not inherit the rows the earlier cases wrote for `se`. */
  async function makeSe(label: string): Promise<string> {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: `SE ${label} ${tag}`, role: 'SERVICE_ENGINEER', phone: `se-${label}-${tag}`, email: `se-${label}-${tag}@sas.test`, zoneId: zoneA },
    });
    engineers.push(u.userId);
    await prisma.engineerMaster.create({ data: { engineerId: u.userId, coverageType: 'DEDICATED', zoneId: zoneA, dailyCapacity: 10 } });
    return u.userId;
  }
});
