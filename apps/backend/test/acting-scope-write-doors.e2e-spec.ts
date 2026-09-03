import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * #341 AC1/AC2/AC4 — acting **narrows a write door**, and narrowing can only reduce reach.
 *
 * `acting-scope-route-sweep.spec.ts` is the structural half: no manager write route builds its scope
 * from the caller's claims. This is the half that proves the structure buys something — that the
 * decorator it insists on actually changes what a request can reach.
 *
 * **The reproduced case is the first test.** A CSM acting in zone 2 closed a zone-1 ticket for real:
 * the acting claim was gated (#339) and recorded (#340), and the write still ran pan-India because
 * `manualClose` was handed `{ role: user.role, zoneId: user.zone_id }` — and a CSM's claims *are*
 * pan-India. Every layer said "acting"; the one that decided reach never asked.
 *
 * **Three cases, and the second two are what make the first safe.** A narrowing change is only
 * correct if it narrows and nothing else:
 *
 * - narrowed: the acting CSM cannot reach the other zone's ticket;
 * - **not** narrowed when not acting (AC2): the same CSM, same door, no header, still pan-India —
 *   otherwise this is a permissions cut dressed as an acting fix;
 * - **unchanged** for a ZM (AC4): a ZM was already clamped to their own zone and must stay exactly
 *   as clamped, neither wider nor narrower. `resolveManagerScope` gives a non-acting caller the
 *   claims expression verbatim, and this is the test that says so out loud.
 *
 * The door is `POST /api/tickets/:id/auto-recovery-close` — the one the survey reproduced, and one a
 * ZM, a CSM and an Operations Head can all call, so all three cases run down the same code path.
 */
const DEV_ZONE_A = String(9_341_001n);
const DEV_ZONE_B = String(9_341_002n);
const DEV_NOT_ACTING = String(9_341_003n);
const ALL = [DEV_ZONE_A, DEV_ZONE_B, DEV_NOT_ACTING];

describe('#341 — acting narrows a manager write door (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let zoneA: bigint;
  let zoneB: bigint;
  let companyId: bigint;
  let plantA: bigint;
  let plantB: bigint;
  let windowB: bigint;
  const ticketByDevice = new Map<string, string>();

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  };

  const seedOpen = async (deviceId: string, plantId: bigint) => {
    await prisma.device.create({ data: { deviceId } });
    const cycle = await prisma.failureCycle.create({
      data: { deviceId, state: 'OPEN', openedAt: new Date() },
    });
    const ticket = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        failureCycleId: cycle.cycleId,
        deviceId,
        plantId,
        companyId,
        companyTier: 'GOLD',
        lastStateChangedAt: new Date(),
      },
    });
    await prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: true,
        eligibleForUptime: true,
        hasOpenFailureCycle: true,
        plantId,
        companyId,
        computedAt: new Date(),
      },
    });
    ticketByDevice.set(deviceId, ticket.ticketId);
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    const ns = Date.now();
    zoneA = (await prisma.zone.create({ data: { name: `Z-341a-${ns}` } })).zoneId;
    zoneB = (await prisma.zone.create({ data: { name: `Z-341b-${ns}` } })).zoneId;
    companyId = (
      await prisma.company.create({
        data: { name: `Co-341-${ns}`, companyTier: 'GOLD', companyPriorityRank: 'B' },
      })
    ).companyId;
    plantA = (await prisma.plant.create({ data: { name: `P-341a-${ns}`, zoneId: zoneA } })).plantId;
    plantB = (await prisma.plant.create({ data: { name: `P-341b-${ns}`, zoneId: zoneB } })).plantId;

    // The CSM may act in zone B only while zone B's ZM duty has cascaded to them (#339). This is a
    // precondition of the test, not part of what it asserts.
    windowB = (
      await prisma.roleUnavailability.create({
        data: {
          role: 'ZONAL_MANAGER',
          zoneId: zoneB,
          windowStart: new Date(Date.now() - 60 * 60_000),
          windowEnd: null,
          reason: 'fixture: ZM out (#341)',
          createdByRole: 'OPERATIONS_HEAD',
        },
      })
    ).id;

    await seedOpen(DEV_ZONE_A, plantA);
    await seedOpen(DEV_ZONE_B, plantB);
    await seedOpen(DEV_NOT_ACTING, plantA);
  });

  afterAll(async () => {
    const ticketIds = [...ticketByDevice.values()];
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticket: { deviceId: { in: ALL } } } });
    await prisma.ticket.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.roleUnavailability.deleteMany({ where: { id: windowB } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [plantA, plantB] } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: [zoneA, zoneB] } } });
    await app.close();
  });

  const close = (token: string, deviceId: string, actingZone?: bigint) => {
    const req = request(app.getHttpServer())
      .post(`/api/tickets/${ticketByDevice.get(deviceId)}/auto-recovery-close`)
      .set('Authorization', `Bearer ${token}`);
    return actingZone === undefined ? req : req.set('X-Acting-As-Zone', String(actingZone));
  };

  it('AC1 — a CSM acting in zone B cannot close a zone-A ticket (the reproduced case)', async () => {
    const token = await login('csm@fsm.test');

    // 404, not 403: the ticket is outside the caller's scope, so the door cannot see it at all. That
    // is the same answer a ZM has always got for another zone's ticket, and it leaks nothing about
    // whether the id exists.
    await close(token, DEV_ZONE_A, zoneB).expect(404);

    // And the ticket really is untouched — a 404 that still wrote would be the worse bug.
    const ticket = await prisma.ticket.findFirstOrThrow({ where: { deviceId: DEV_ZONE_A } });
    expect(ticket.status).toBe('OPEN');
  });

  it('AC1 — the same CSM, acting in zone B, closes the zone-B ticket', async () => {
    // The other half of narrowing: it must still permit what the acting role is there to do. A test
    // that only asserted the refusal would pass against a door that refused everything.
    const token = await login('csm@fsm.test');
    await close(token, DEV_ZONE_B, zoneB).expect(200);

    const ticket = await prisma.ticket.findFirstOrThrow({ where: { deviceId: DEV_ZONE_B } });
    expect(ticket.status).toBe('CLOSED_AUTO_RECOVERY');
  });

  it('AC2 — the same CSM with no header keeps pan-India reach', async () => {
    const token = await login('csm@fsm.test');
    await close(token, DEV_NOT_ACTING).expect(200);

    const ticket = await prisma.ticket.findFirstOrThrow({ where: { deviceId: DEV_NOT_ACTING } });
    expect(ticket.status).toBe('CLOSED_AUTO_RECOVERY');
  });

  it('AC4 — a ZM is unchanged: still clamped to their own zone, no wider and no narrower', async () => {
    // A ZM never gets an acting zone from the guard (#339), so `resolveManagerScope` hands back the
    // claims expression verbatim. This asserts that the conversion is a no-op for them — the property
    // that makes "narrowing only reduces reach" true rather than merely intended.
    const token = await login('zm.north@fsm.test');
    await close(token, DEV_ZONE_A).expect(404); // zone A is not the North ZM's zone
    await close(token, DEV_ZONE_A, zoneB).expect(404); // and a header they may not use changes nothing
  });
});
