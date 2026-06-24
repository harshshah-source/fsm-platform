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
});
