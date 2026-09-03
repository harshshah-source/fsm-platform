import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { LeaveRequestService } from '../src/engineers/leave-request.service';
import { SeAvailabilityService } from '../src/engineers/se-availability.service';

/**
 * Issue 26 slice 2 — Leave Request workflow. An SE files ON_LEAVE / WEEKLY_OFF for a range (PENDING);
 * the ZM approves (writing an se_availability window so the Recommender excludes the SE) or rejects
 * with a reason (SE can revise + resubmit as a new request). Zone-scoped: only the own-zone ZM (or the
 * SE themselves for submit) may act.
 *
 * #363 — every case now files **its own week**. Until this slice the whole spec shared one window,
 * which is exactly the state the overlap guard refuses: the same absence filed twice over, so the same
 * day could be approved twice and the request history stopped being a sequence.
 */
const NS = Date.now();

/** `[day, day+2)` in July 2026 — one case's window. End-exclusive, so `win(n)` and `win(n + 2)` touch but never overlap. */
const win = (day: number) => ({
  windowStart: new Date(Date.UTC(2026, 6, day)),
  windowEnd: new Date(Date.UTC(2026, 6, day + 2)),
});
/** An instant inside `win(day)`. */
const inside = (day: number) => new Date(Date.UTC(2026, 6, day, 12));

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
    // The audit rows #343 (approve/reject) and #363 (revoke) write are keyed on the request id, so they
    // have to be cleared before the requests they point at.
    const requests = await prisma.leaveRequest.findMany({ where: { seId: { in: userIds } }, select: { id: true } });
    await prisma.auditLog.deleteMany({
      where: { entityType: 'leave_requests', entityId: { in: requests.map((r) => String(r.id)) } },
    });
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
  const seActor = () => ({ userId: se, role: 'SERVICE_ENGINEER', zoneId: Number(zoneA) });

  it('an SE files leave (PENDING)', async () => {
    const out = await svc.submit({ seId: se, type: 'ON_LEAVE', ...win(1), reason: 'family' }, seActor());
    expect(out.result).toBe('OK');
    const row = await prisma.leaveRequest.findUniqueOrThrow({ where: { id: BigInt(out.id!) } });
    expect(row.status).toBe('PENDING');
    expect(row.type).toBe('ON_LEAVE');
  });

  it('forbids a ZM from another zone approving', async () => {
    const sub = await svc.submit({ seId: se, type: 'ON_LEAVE', ...win(4) }, seActor());
    const out = await svc.approve(sub.id!, zmB());
    expect(out.result).toBe('FORBIDDEN');
  });

  it('ZM approve marks APPROVED and writes an availability window the Recommender will exclude', async () => {
    const sub = await svc.submit({ seId: se, type: 'ON_LEAVE', ...win(7) }, seActor());
    const out = await svc.approve(sub.id!, zmA());
    expect(out.result).toBe('OK');

    const row = await prisma.leaveRequest.findUniqueOrThrow({ where: { id: BigInt(sub.id!) } });
    expect(row.status).toBe('APPROVED');
    expect(row.availabilityId).not.toBeNull();
    // The availability window is active mid-range → currentStatus reflects the leave.
    expect(await availability.currentStatus(se, inside(8))).toBe('ON_LEAVE');
    // Auto-reverts after the window end.
    expect(await availability.currentStatus(se, inside(9))).toBe('AVAILABLE');
  });

  it('ZM reject records the reason; a fresh submit (resubmit) is allowed', async () => {
    const sub = await svc.submit({ seId: se, type: 'WEEKLY_OFF', ...win(10) }, seActor());
    const rej = await svc.reject(sub.id!, 'insufficient coverage', zmA());
    expect(rej.result).toBe('OK');
    const row = await prisma.leaveRequest.findUniqueOrThrow({ where: { id: BigInt(sub.id!) } });
    expect(row.status).toBe('REJECTED');
    expect(row.decisionReason).toBe('insufficient coverage');

    // #363 — the resubmit is over the *same* window, which is what makes it the guard's boundary case:
    // a rejected request holds no day, so it must never block the revision the SE was asked for.
    const resub = await svc.submit({ seId: se, type: 'WEEKLY_OFF', ...win(10) }, seActor());
    expect(resub.result).toBe('OK');
  });

  it('cannot approve a non-PENDING request', async () => {
    const sub = await svc.submit({ seId: se, type: 'ON_LEAVE', ...win(13) }, seActor());
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

  /**
   * #363 AC3 — the same absence filed twice is not two absences.
   *
   * Duplicate and overlapping windows were accepted, so the same day could be approved twice (two
   * availability windows, two audit trails, one absence) and a manager reading the queue could not tell
   * which row the SE meant. The guard is on **live** rows only — PENDING and APPROVED hold the day;
   * REJECTED and revoked rows do not (see the resubmit case above and the revoke case below).
   */
  it('#363 AC3 — an overlapping submit is refused and names the request it collides with; an adjacent window is fine', async () => {
    const first = await svc.submit({ seId: se, type: 'ON_LEAVE', ...win(16) }, seActor());
    expect(first.result).toBe('OK');

    const overlapping = await svc.submit({ seId: se, type: 'ON_LEAVE', ...win(17) }, seActor());
    expect(overlapping.result).toBe('OVERLAP');
    expect(overlapping.result === 'OVERLAP' && overlapping.conflictId).toBe(first.id);

    // Identical window, different type — still the same day, still refused.
    const duplicate = await svc.submit({ seId: se, type: 'WEEKLY_OFF', ...win(16) }, seActor());
    expect(duplicate.result).toBe('OVERLAP');

    // `[16,18)` and `[18,20)` touch at an end-exclusive boundary and share no instant.
    const adjacent = await svc.submit({ seId: se, type: 'ON_LEAVE', ...win(18) }, seActor());
    expect(adjacent.result).toBe('OK');
  });

  /**
   * #363 AC2/AC4 — revoke gives the day back.
   *
   * Leave approved by mistake could not be undone: the request was terminal at APPROVED and the
   * availability window it wrote stayed on the board, so an engineer who was standing in the depot was
   * invisible to the Recommender for the rest of the window. Revoke writes an `AVAILABLE` window over
   * exactly the same range — it does not delete the leave window — so the day comes back through the
   * same tie-break the manager's own screen uses (AC1), and both writes stay in the ledger.
   */
  it('#363 AC2/AC4 — revoking an approved leave returns the day, audits LEAVE_REVOKED, and frees the window to be filed again', async () => {
    const sub = await svc.submit({ seId: se, type: 'ON_LEAVE', ...win(21), reason: 'wedding' }, seActor());
    expect((await svc.approve(sub.id!, zmA())).result).toBe('OK');
    expect(await availability.currentStatus(se, inside(22))).toBe('ON_LEAVE');

    const revoked = await svc.revoke(sub.id!, 'wedding postponed, SE is working', zmA());
    expect(revoked.result).toBe('OK');
    expect(await availability.currentStatus(se, inside(22))).toBe('AVAILABLE');

    // The row reads as revoked — not as approved leave nobody is taking, and not as a rejection the SE
    // never received. The stored status stays APPROVED (`leave_request_status` has no REVOKED member).
    const row = await svc.listForZone({ role: 'ZONAL_MANAGER', zoneId: Number(zoneA) });
    expect(row.find((r) => r.id === sub.id)).toMatchObject({
      status: 'REVOKED',
      decisionReason: 'wedding postponed, SE is working',
    });

    const audit = await prisma.auditLog.findMany({ where: { entityType: 'leave_requests', entityId: sub.id!, action: 'LEAVE_REVOKED' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actorRole).toBe('ZONAL_MANAGER');
    expect(audit[0]!.metadata).toMatchObject({ seId: se, type: 'ON_LEAVE', reason: 'wedding postponed, SE is working' });

    // Revoking twice is not a second decision, and the freed day can be filed again.
    expect((await svc.revoke(sub.id!, 'again', zmA())).result).toBe('INVALID_STATE');
    expect((await svc.submit({ seId: se, type: 'ON_LEAVE', ...win(21) }, seActor())).result).toBe('OK');
  });

  it('#363 — revoke refuses a PENDING request and a manager from another zone', async () => {
    const pending = await svc.submit({ seId: se, type: 'ON_LEAVE', ...win(25) }, seActor());
    expect((await svc.revoke(pending.id!, 'not approved yet', zmA())).result).toBe('INVALID_STATE');

    const approved = await svc.submit({ seId: se, type: 'ON_LEAVE', ...win(28) }, seActor());
    await svc.approve(approved.id!, zmA());
    expect((await svc.revoke(approved.id!, 'not my zone', zmB())).result).toBe('FORBIDDEN');
    expect((await svc.revoke('999999999', 'nothing there', zmA())).result).toBe('NOT_FOUND');
  });
});
