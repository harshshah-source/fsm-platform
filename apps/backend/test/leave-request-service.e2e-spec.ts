import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { LeaveRequestService } from '../src/engineers/leave-request.service';
import { SeAvailabilityService } from '../src/engineers/se-availability.service';

/**
 * Issue 26 slice 2 — Leave Request workflow. An SE files ON_LEAVE / WEEKLY_OFF for a range (PENDING);
 * the ZM approves (writing an se_availability window so the Recommender excludes the SE) or rejects
 * with a reason (SE can revise + resubmit as a new request). Zone-scoped: only the own-zone ZM (or the
 * SE themselves for submit) may act.
 */
const NS = Date.now();
const NOW = new Date('2026-06-25T12:00:00Z');
const WIN = { windowStart: new Date('2026-06-28T00:00:00Z'), windowEnd: new Date('2026-06-30T00:00:00Z') };

describe('Issue 26 slice 2 — Leave Request service', () => {
  let prisma: PrismaService;
  let svc: LeaveRequestService;
  let availability: SeAvailabilityService;

  let zoneA: bigint;
  let zoneB: bigint;
  let se: string;
  const userIds: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    svc = new LeaveRequestService(prisma);
    availability = new SeAvailabilityService(prisma);

    zoneA = (await prisma.zone.create({ data: { name: 'Z-lrA-' + NS } })).zoneId;
    zoneB = (await prisma.zone.create({ data: { name: 'Z-lrB-' + NS } })).zoneId;
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'Leave SE ' + NS, role: 'SERVICE_ENGINEER', phone: 'lr-' + tag, email: `${tag}-${NS}@lr.test`, zoneId: zoneA },
    });
    se = u.userId;
    userIds.push(se);
    await prisma.engineerMaster.create({
      data: { engineerId: se, coverageType: 'DEDICATED', zoneId: zoneA, dailyCapacity: 10 },
    });
  });

  afterAll(async () => {
    await prisma.leaveRequest.deleteMany({ where: { seId: { in: userIds } } });
    await prisma.seAvailability.deleteMany({ where: { seId: { in: userIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: [zoneA, zoneB] } } });
    await prisma.onModuleDestroy();
  });

  // Built lazily — zoneA/zoneB are only assigned in beforeAll.
  const zmA = () => ({ userId: 'zmA', role: 'ZONAL_MANAGER', zoneId: Number(zoneA) });
  const zmB = () => ({ userId: 'zmB', role: 'ZONAL_MANAGER', zoneId: Number(zoneB) });

  it('an SE files leave (PENDING)', async () => {
    const out = await svc.submit(
      { seId: se, type: 'ON_LEAVE', windowStart: WIN.windowStart, windowEnd: WIN.windowEnd, reason: 'family' },
      { userId: se, role: 'SERVICE_ENGINEER', zoneId: Number(zoneA) },
    );
    expect(out.result).toBe('OK');
    const row = await prisma.leaveRequest.findUniqueOrThrow({ where: { id: BigInt(out.id!) } });
    expect(row.status).toBe('PENDING');
    expect(row.type).toBe('ON_LEAVE');
  });

  it('forbids a ZM from another zone approving', async () => {
    const sub = await svc.submit({ seId: se, type: 'ON_LEAVE', ...WIN }, { userId: se, role: 'SERVICE_ENGINEER', zoneId: Number(zoneA) });
    const out = await svc.approve(sub.id!, zmB());
    expect(out.result).toBe('FORBIDDEN');
  });

  it('ZM approve marks APPROVED and writes an availability window the Recommender will exclude', async () => {
    const sub = await svc.submit({ seId: se, type: 'ON_LEAVE', ...WIN }, { userId: se, role: 'SERVICE_ENGINEER', zoneId: Number(zoneA) });
    const out = await svc.approve(sub.id!, zmA());
    expect(out.result).toBe('OK');

    const row = await prisma.leaveRequest.findUniqueOrThrow({ where: { id: BigInt(sub.id!) } });
    expect(row.status).toBe('APPROVED');
    expect(row.availabilityId).not.toBeNull();
    // The availability window is active mid-range → currentStatus reflects the leave.
    expect(await availability.currentStatus(se, new Date('2026-06-29T00:00:00Z'))).toBe('ON_LEAVE');
    // Auto-reverts after the window end.
    expect(await availability.currentStatus(se, new Date('2026-07-01T00:00:00Z'))).toBe('AVAILABLE');
  });

  it('ZM reject records the reason; a fresh submit (resubmit) is allowed', async () => {
    const sub = await svc.submit({ seId: se, type: 'WEEKLY_OFF', ...WIN }, { userId: se, role: 'SERVICE_ENGINEER', zoneId: Number(zoneA) });
    const rej = await svc.reject(sub.id!, 'insufficient coverage', zmA());
    expect(rej.result).toBe('OK');
    const row = await prisma.leaveRequest.findUniqueOrThrow({ where: { id: BigInt(sub.id!) } });
    expect(row.status).toBe('REJECTED');
    expect(row.decisionReason).toBe('insufficient coverage');

    const resub = await svc.submit({ seId: se, type: 'WEEKLY_OFF', ...WIN }, { userId: se, role: 'SERVICE_ENGINEER', zoneId: Number(zoneA) });
    expect(resub.result).toBe('OK');
  });

  it('cannot approve a non-PENDING request', async () => {
    const sub = await svc.submit({ seId: se, type: 'ON_LEAVE', ...WIN }, { userId: se, role: 'SERVICE_ENGINEER', zoneId: Number(zoneA) });
    await svc.approve(sub.id!, zmA());
    const again = await svc.approve(sub.id!, zmA());
    expect(again.result).toBe('INVALID_STATE');
  });

  it('lists own-zone requests for a ZM and excludes other zones', async () => {
    const rows = await svc.listForZone({ role: 'ZONAL_MANAGER', zoneId: Number(zoneA) });
    expect(rows.every((r) => r.seId === se)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);

    const other = await svc.listForZone({ role: 'ZONAL_MANAGER', zoneId: Number(zoneB) });
    expect(other.find((r) => r.seId === se)).toBeUndefined();
  });
});
