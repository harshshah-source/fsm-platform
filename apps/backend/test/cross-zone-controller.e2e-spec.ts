import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 32 — the `/api/cross-zone/*` HTTP surface (RBAC + routing + input validation). The escalation
 * behaviours themselves are covered by the CrossZoneEscalationService e2e spec.
 */
describe('/api/cross-zone (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  /**
   * #355 — a PENDING escalation of this spec's own making, so the approve door can be driven past its
   * escalation lookup and reach the SE/zone check AC3 is about. Self-contained rather than borrowed
   * from the seed: run alone, this database holds no tickets at all, and a fixture that depends on
   * another spec having created one is a fixture that passes only in a full run.
   */
  const NS = Date.now();
  let escalationId: bigint;
  let seId: string;
  const fixture: {
    zoneId?: bigint;
    companyId?: bigint;
    plantId?: bigint;
    deviceId?: string;
    cycleId?: string;
    ticketId?: string;
    userId?: string;
  } = {};

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    fixture.zoneId = (await prisma.zone.create({ data: { name: `Z-czc-${NS}` } })).zoneId;
    fixture.companyId = (
      await prisma.company.create({ data: { name: `C-czc-${NS}`, companyTier: 'PLATINUM', companyPriorityRank: 'A' } })
    ).companyId;
    fixture.plantId = (await prisma.plant.create({ data: { name: `P-czc-${NS}`, zoneId: fixture.zoneId } })).plantId;
    fixture.deviceId = String(12_900_000_000 + (NS % 100_000));
    await prisma.device.create({ data: { deviceId: fixture.deviceId } });
    const se = await prisma.user.create({
      data: { name: `SE czc ${NS}`, role: 'SERVICE_ENGINEER', phone: `ph-czc-${NS}`, email: `czc-${NS}@cz.test`, zoneId: fixture.zoneId },
    });
    fixture.userId = se.userId;
    seId = se.userId;
    await prisma.engineerMaster.create({
      data: { engineerId: seId, coverageType: 'FLOATING', zoneId: fixture.zoneId, dailyCapacity: 10 },
    });
    // A TROUBLESHOOT ticket must carry a failure cycle (`tickets_troubleshoot_requires_cycle`).
    const cycle = await prisma.failureCycle.create({
      data: { deviceId: fixture.deviceId, state: 'OPEN', openedAt: new Date() },
    });
    fixture.cycleId = cycle.cycleId;
    const ticket = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        failureCycleId: cycle.cycleId,
        deviceId: fixture.deviceId,
        plantId: fixture.plantId,
        companyId: fixture.companyId,
        companyTier: 'PLATINUM',
        lastStateChangedAt: new Date(),
      },
    });
    fixture.ticketId = ticket.ticketId;
    escalationId = (
      await prisma.crossZoneEscalation.create({
        data: {
          ticketId: ticket.ticketId,
          homeZoneId: fixture.zoneId,
          companyTier: 'PLATINUM',
          escalationType: 'AUTO_PLATINUM',
          status: 'PENDING',
          raisedByRole: 'SYSTEM',
        },
      })
    ).escalationId;
  }, 30_000);

  afterAll(async () => {
    await prisma.auditLog.deleteMany({
      where: { entityType: 'cross_zone_escalation', entityId: String(escalationId) },
    });
    await prisma.crossZoneEscalation.deleteMany({ where: { escalationId } });
    if (fixture.ticketId) await prisma.ticket.deleteMany({ where: { ticketId: fixture.ticketId } });
    if (fixture.cycleId) await prisma.failureCycle.deleteMany({ where: { cycleId: fixture.cycleId } });
    if (fixture.deviceId) await prisma.device.deleteMany({ where: { deviceId: fixture.deviceId } });
    if (seId) await prisma.engineerMaster.deleteMany({ where: { engineerId: seId } });
    if (fixture.userId) await prisma.user.deleteMany({ where: { userId: fixture.userId } });
    if (fixture.plantId) await prisma.plant.deleteMany({ where: { plantId: fixture.plantId } });
    if (fixture.companyId) await prisma.company.deleteMany({ where: { companyId: fixture.companyId } });
    if (fixture.zoneId) await prisma.zone.deleteMany({ where: { zoneId: fixture.zoneId } });
    await app.close();
  }, 30_000);

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  }

  it('lets a CSM read the cross-zone queue', async () => {
    const token = await login('csm@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/cross-zone')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('forbids an SE from the cross-zone queue', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer())
      .get('/api/cross-zone')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('forbids a ZM from approving (decider-only action)', async () => {
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .post('/api/cross-zone/999999999/approve')
      .set('Authorization', `Bearer ${token}`)
      .send({ targetZoneId: 1, seId: '00000000-0000-0000-0000-0000000000aa' })
      .expect(403);
  });

  it('400s a flag with a missing reason', async () => {
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .post('/api/cross-zone/flag')
      .set('Authorization', `Bearer ${token}`)
      .send({ ticketId: '00000000-0000-0000-0000-0000000000aa' })
      .expect(400);
  });

  it('404s a deny on an unknown escalation', async () => {
    const token = await login('csm@fsm.test');
    await request(app.getHttpServer())
      .post('/api/cross-zone/999999999/deny')
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'nope' })
      .expect(404);
  });

  /**
   * #354 (CZ-13) — the decision doors' non-OK results reach the caller as their own codes. The one
   * that was actively misleading is `NOT_FOUND`: an approve whose *SE* is unknown, and an approve of a
   * ticket held to a return date, both answered "escalation or SE not found".
   */
  it('404s an approve on an unknown escalation with the escalation code', async () => {
    const token = await login('csm@fsm.test');
    const res = await request(app.getHttpServer())
      .post('/api/cross-zone/999999999/approve')
      .set('Authorization', `Bearer ${token}`)
      .send({ targetZoneId: 1, seId: '00000000-0000-0000-0000-0000000000aa' })
      .expect(404);
    expect(res.body.code ?? res.body.message?.code).toBe('ESCALATION_NOT_FOUND');
  });

  /**
   * #355 — the target zone stopped being a required field: it is derivable from the SE, and an
   * operator who names an engineer has already named the zone. The SE is the field that cannot be
   * derived from anything, so it is the one this door still insists on.
   */
  it('400s an approve with no SE', async () => {
    const token = await login('csm@fsm.test');
    const res = await request(app.getHttpServer())
      .post('/api/cross-zone/999999999/approve')
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(400);
    expect(res.body.code ?? res.body.message?.code).toBe('SE_REQUIRED');
  });

  it('gives a ZM a direction on every queue row', async () => {
    const token = await login('zm.north@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/cross-zone')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const rows = res.body as { direction?: string }[];
    expect(rows.every((r) => r.direction === 'incoming' || r.direction === 'outgoing')).toBe(true);
  });

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer()).get('/api/cross-zone').expect(401);
  });

  /**
   * #355 — the two doors this slice adds to the surface: the decision history read, and the approve
   * door's refusal to assign an engineer who does not work in the zone the approver picked.
   */
  describe('#355 — history read and SE/zone agreement', () => {
    it('lets a CSM read the decision history', async () => {
      const token = await login('csm@fsm.test');
      const res = await request(app.getHttpServer())
        .get('/api/cross-zone/history')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('lets a ZM read their own zone’s decision history', async () => {
      const token = await login('zm.north@fsm.test');
      await request(app.getHttpServer())
        .get('/api/cross-zone/history')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    });

    it('forbids an SE from the decision history', async () => {
      const token = await login('se.north@fsm.test');
      await request(app.getHttpServer())
        .get('/api/cross-zone/history')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });

    it('400s a history range whose bounds are not dates', async () => {
      const token = await login('csm@fsm.test');
      await request(app.getHttpServer())
        .get('/api/cross-zone/history?from=junk')
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
    });

    it('400s an approve whose SE does not work in the chosen target zone', async () => {
      const token = await login('csm@fsm.test');
      const res = await request(app.getHttpServer())
        .post(`/api/cross-zone/${escalationId}/approve`)
        .set('Authorization', `Bearer ${token}`)
        // A zone id this engineer is certainly not in, so the mismatch is the only reason this can fail.
        .send({ targetZoneId: 999_999, seId })
        .expect(400);
      expect(res.body.code ?? res.body.message?.code).toBe('SE_NOT_IN_TARGET_ZONE');
      expect(res.body.seZoneId ?? res.body.message?.seZoneId).toBe(Number(fixture.zoneId));
    });

    it('400s an approve with no SE, even when a target zone is given', async () => {
      const token = await login('csm@fsm.test');
      const res = await request(app.getHttpServer())
        .post('/api/cross-zone/999999999/approve')
        .set('Authorization', `Bearer ${token}`)
        .send({ targetZoneId: 1 })
        .expect(400);
      expect(res.body.code ?? res.body.message?.code).toBe('SE_REQUIRED');
    });
  });
});
