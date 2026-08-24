import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * `POST /api/schedules/assign-batch` under `X-Acting-As-Zone`.
 *
 * The Assign Work Console's **reads** (`assignable-work`, `candidates`, `assignable-tickets`,
 * `distribute-preview`) have always collapsed an acting CSM / Operations Head into the zone's ZM;
 * every **write** on this controller built its scope straight from the claims and hardcoded
 * `actedAsRole: null`. So an Operations Head acting in a zone was shown that zone's pool and then
 * committed against a pan-India scope, and the audit row could not say they were acting. The read and
 * the write are two halves of one operator action and cannot disagree about which zone they are in.
 *
 * Exercised over HTTP on purpose: the fix lives in the `@CurrentActor()` param decorator and the
 * header it reads, neither of which exists when a test calls `OverrideService` directly — which is
 * why `assign-batch.e2e-spec.ts` (a service-seam spec) cannot cover this and does not try.
 *
 * The three legs that matter are the three ways this could have gone wrong: it must **narrow** when
 * acting, change **nothing** when not acting, and must not hand a ZM a way to **widen**.
 */
const NS = Date.now();

describe('#275/#239 — assign-batch honours the acting zone', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let zoneA: bigint;
  let zoneB: bigint;
  let companyId: bigint;
  let plantA: bigint;
  let plantB: bigint;
  let seId: string;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  };

  /** `assign-batch` as `email`, optionally acting in `actingZone`. */
  const commit = async (
    token: string,
    lanes: { seId: string; ticketIds: string[] }[],
    actingZone?: bigint,
  ) => {
    const req = request(app.getHttpServer())
      .post('/api/schedules/assign-batch')
      .set('Authorization', `Bearer ${token}`);
    if (actingZone !== undefined) req.set('X-Acting-As-Zone', String(actingZone));
    return req.send({ reasonCode: 'acting-scope spec', lanes }).expect(200);
  };

  const makeTicket = async (plantId: bigint): Promise<string> => {
    const deviceId = String(10_900_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: new Date() } });
    const t = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        failureCycleId: cycle.cycleId,
        deviceId,
        plantId,
        companyId,
        companyTier: 'GOLD',
        assignmentState: 'UNASSIGNED',
        lastStateChangedAt: new Date(),
      },
    });
    ticketIds.push(t.ticketId);
    return t.ticketId;
  };

  const laneFor = (out: request.Response, se: string) =>
    (out.body.lanes as { seId: string; assigned: number; skipped: { ticketId: string; reason: string }[] }[]).find(
      (l) => l.seId === se,
    )!;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    zoneA = (await prisma.zone.create({ data: { name: 'Z-acting-A-' + NS } })).zoneId;
    zoneB = (await prisma.zone.create({ data: { name: 'Z-acting-B-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-acting-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantA = (await prisma.plant.create({ data: { name: 'P-acting-A-' + NS, zoneId: zoneA } })).plantId;
    plantB = (await prisma.plant.create({ data: { name: 'P-acting-B-' + NS, zoneId: zoneB } })).plantId;

    // One engineer, deliberately NOT clamped to either zone by the lane write itself — scope is
    // enforced per *ticket* (`OUT_OF_ZONE`), which is exactly what this spec is measuring.
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@acting.test`, zoneId: zoneA },
    });
    userIds.push(u.userId);
    seId = u.userId;
    await prisma.engineerMaster.create({
      data: { engineerId: seId, coverageType: 'MULTI_PLANT', zoneId: zoneA, dailyCapacity: 50 },
    });
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: ticketIds } }, { entityId: seId }] } });
    await prisma.batchAssignmentTicket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { seId } });
    await prisma.workSchedule.deleteMany({ where: { seId } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: seId } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [plantA, plantB] } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: [zoneA, zoneB] } } });
    await app.close();
  });

  it('clamps an acting Operations Head to the zone they are acting in', async () => {
    const inZone = await makeTicket(plantA);
    const outOfZone = await makeTicket(plantB);
    const token = await login('ops.head@fsm.test');

    const out = await commit(token, [{ seId, ticketIds: [inZone, outOfZone] }], zoneA);

    const lane = laneFor(out, seId);
    expect(lane.assigned).toBe(1);
    // Before the fix this was assigned too: the pool said "zone A", the write said "everywhere".
    expect(lane.skipped).toEqual([{ ticketId: outOfZone, reason: 'OUT_OF_ZONE' }]);

    const after = await prisma.ticket.findMany({
      where: { ticketId: { in: [inZone, outOfZone] } },
      select: { ticketId: true, assignmentState: true },
    });
    expect(after.find((t) => t.ticketId === inZone)!.assignmentState).toBe('FORMALLY_ASSIGNED');
    expect(after.find((t) => t.ticketId === outOfZone)!.assignmentState).toBe('UNASSIGNED');
  });

  it('records that the commit was made while acting, instead of a structural null', async () => {
    const ticketId = await makeTicket(plantA);
    const token = await login('ops.head@fsm.test');

    await commit(token, [{ seId, ticketIds: [ticketId] }], zoneA);

    const perTicket = await prisma.auditLog.findFirst({
      where: { entityType: 'ticket', entityId: ticketId, action: 'MANUAL_BATCH_ASSIGN' },
    });
    expect(perTicket?.actorRole).toBe('OPERATIONS_HEAD');
    expect(perTicket?.actedAsRole).toBe('OPERATIONS_HEAD');

    // The mandatory-reason row carries the attribution too — it is the row that answers "why".
    const laneRow = await prisma.auditLog.findFirst({
      where: { entityType: 'assign_batch_lane', entityId: seId, action: 'ASSIGN_BATCH_COMMIT' },
      orderBy: { createdAt: 'desc' },
    });
    expect(laneRow?.actedAsRole).toBe('OPERATIONS_HEAD');
  });

  it('changes nothing when the caller is not acting — a pan-India role still writes pan-India', async () => {
    const inZoneA = await makeTicket(plantA);
    const inZoneB = await makeTicket(plantB);
    const token = await login('ops.head@fsm.test');

    // No `X-Acting-As-Zone`: byte-identical to the pre-fix expression, both zones writable.
    const out = await commit(token, [{ seId, ticketIds: [inZoneA, inZoneB] }]);

    const lane = laneFor(out, seId);
    expect(lane.assigned).toBe(2);
    expect(lane.skipped).toEqual([]);

    const rows = await prisma.auditLog.findMany({
      where: { entityType: 'ticket', entityId: { in: [inZoneA, inZoneB] }, action: 'MANUAL_BATCH_ASSIGN' },
    });
    expect(rows).toHaveLength(2);
    // Not acting means no proxy attribution — the field stays null rather than echoing the role.
    expect(rows.every((r) => r.actedAsRole === null)).toBe(true);
  });

  it('gives a Zonal Manager no way to widen their own scope with the header', async () => {
    const foreign = await makeTicket(plantA);
    const token = await login('zm.north@fsm.test');

    // The header names a zone that is not theirs. `resolveActingContext` only honours it for the two
    // acting-capable roles, so this must not become a licence to write into zone A.
    const out = await commit(token, [{ seId, ticketIds: [foreign] }], zoneA);

    expect(laneFor(out, seId).skipped).toEqual([{ ticketId: foreign, reason: 'OUT_OF_ZONE' }]);
    const after = await prisma.ticket.findUnique({ where: { ticketId: foreign }, select: { assignmentState: true } });
    expect(after?.assignmentState).toBe('UNASSIGNED');
  });
});
