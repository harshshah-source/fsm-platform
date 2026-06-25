import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/audit/audit.service';
import { NonOperationalService } from '../src/ticketing/non-operational.service';
import type { RequestActor } from '../src/common/request-actor';

/**
 * Issue 35, slice 2 — dual-confirmation state machine + Operations-Head 7-day override (AC#2).
 * CONFIRMED is reachable only after BOTH the manager and the customer confirm (in either order),
 * or via an Operations-Head override-confirm after 7 days of no response, with a mandatory reason.
 */
const DEV_DUAL = 9_351_001n;
const DEV_REVERSE = 9_351_002n;
const DEV_OVERRIDE = 9_351_003n;
const ALL = [DEV_DUAL, DEV_REVERSE, DEV_OVERRIDE];

const zm: RequestActor = { userId: '11111111-1111-1111-1111-111111111111', role: 'ZONAL_MANAGER', actedAsRole: null, actingZone: null };
const se: RequestActor = { userId: '22222222-2222-2222-2222-222222222222', role: 'SERVICE_ENGINEER', actedAsRole: null, actingZone: null };
const oh: RequestActor = { userId: '33333333-3333-3333-3333-333333333333', role: 'OPERATIONS_HEAD', actedAsRole: null, actingZone: null };

describe('Issue 35 slice 2 — dual confirmation + override', () => {
  let prisma: PrismaService;
  let service: NonOperationalService;
  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;

  const NOW = new Date(Date.UTC(2026, 5, 25, 12, 0, 0));
  const later = (ms: number) => new Date(NOW.getTime() + ms);

  const request = async (deviceId: bigint) => {
    const out = await service.requestMarking({ deviceId, reasonCode: 'COMPANY_PAUSED' }, zm, NOW);
    if (out.result !== 'OK') throw new Error(out.result);
    return out.marking.markingId;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new NonOperationalService(prisma, new AuditService(prisma));
    zoneId = (await prisma.zone.create({ data: { name: 'Z-nopc-' + Date.now() } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-nopc-' + Date.now(), companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-nopc', zoneId } })).plantId;
    for (const d of ALL) await prisma.device.create({ data: { deviceId: d, dealType: 'ONE_TIME' } });
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { entityType: 'non_operational_markings' } });
    await prisma.nonOperationalMarking.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('manager → customer reaches CONFIRMED; manager-confirm resets the await badge', async () => {
    const id = await request(DEV_DUAL);

    const mc = await service.confirmByManager(id, zm, later(1000));
    expect(mc.result).toBe('OK');
    let row = await prisma.nonOperationalMarking.findUniqueOrThrow({ where: { markingId: id } });
    expect(row.state).toBe('AWAITING_CUSTOMER_CONFIRMATION');
    expect(row.managerConfirmedAt).not.toBeNull();
    expect(row.awaitingSince?.getTime()).toBe(later(1000).getTime()); // badge now counts customer-wait

    const cc = await service.confirmByCustomer(id, later(2000));
    expect(cc.result).toBe('OK');
    row = await prisma.nonOperationalMarking.findUniqueOrThrow({ where: { markingId: id } });
    expect(row.state).toBe('CONFIRMED');
    expect(row.confirmedAt).not.toBeNull();
  });

  it('customer → manager also reaches CONFIRMED (order independent)', async () => {
    const id = await request(DEV_REVERSE);
    expect((await service.confirmByCustomer(id, later(1000))).result).toBe('OK');
    expect((await prisma.nonOperationalMarking.findUniqueOrThrow({ where: { markingId: id } })).state).toBe('AWAITING_ZM_CONFIRMATION');
    expect((await service.confirmByManager(id, zm, later(2000))).result).toBe('OK');
    expect((await prisma.nonOperationalMarking.findUniqueOrThrow({ where: { markingId: id } })).state).toBe('CONFIRMED');
  });

  it('a non-manager role cannot manager-confirm', async () => {
    const id = await request(DEV_OVERRIDE);
    expect((await service.confirmByManager(id, se, later(1000))).result).toBe('FORBIDDEN');
  });

  it('override-confirm: OH only, 7-day gate, mandatory reason', async () => {
    const id = (await prisma.nonOperationalMarking.findFirstOrThrow({ where: { deviceId: DEV_OVERRIDE } })).markingId;

    // too early (< 7 days awaiting)
    expect((await service.overrideConfirm(id, oh, 'no response', later(1000))).result).toBe('TOO_EARLY');
    // a ZM may not override
    expect((await service.overrideConfirm(id, zm, 'x', later(8 * 86_400_000))).result).toBe('FORBIDDEN');
    // reason mandatory
    expect((await service.overrideConfirm(id, oh, '   ', later(8 * 86_400_000))).result).toBe('REASON_REQUIRED');
    // valid after 7 days with reason
    const ok = await service.overrideConfirm(id, oh, 'customer unreachable 7d', later(8 * 86_400_000));
    expect(ok.result).toBe('OK');
    const row = await prisma.nonOperationalMarking.findUniqueOrThrow({ where: { markingId: id } });
    expect(row.state).toBe('CONFIRMED');
    expect(row.overrideReason).toBe('customer unreachable 7d');
    expect(row.overrideConfirmedBy).toBe(oh.userId);
  });

  it('confirming an unknown marking is NOT_FOUND', async () => {
    expect((await service.confirmByManager('00000000-0000-0000-0000-0000000000aa', zm, NOW)).result).toBe('NOT_FOUND');
  });
});
