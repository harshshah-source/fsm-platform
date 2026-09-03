import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * #357 — verification integrity. Four ways the module disagreed with itself, one spec per AC.
 *
 * The rows are seeded directly rather than driven through the sweep: every AC here is about what the
 * READ and TRANSITION surfaces do with a run in a given state, not about how the run reached it, and
 * `verification-run` / `verification-staleness` already own the sweep's own arithmetic. Seeding
 * directly is also the only way to place a fraud-flagged run in a zone the ZM does NOT own, which is
 * the whole of AC1 — the leak cannot be demonstrated with a same-zone row (`dev-fixture-seed.ts:250`
 * makes the same argument for the #336 fixtures).
 *
 * `zm.north`'s zone is read from the fixture user rather than assumed to be zone 1: the auth fixture
 * pins the ZM to the zone *named* "North", and which id that is depends on seed order.
 */
const NS = Date.now();
const JULY = (day: number) => new Date(Date.UTC(2026, 6, day, 6, 0, 0));
const WINDOW = 'from=2026-07-01&to=2026-07-31';
const ZM_NORTH = '11111111-1111-1111-1111-111111111111';

describe('#357 — verification integrity (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let homeZoneId: bigint; // zm.north's own zone
  let foreignZoneId: bigint; // a fresh zone no fixture manager owns
  let companyId: bigint;
  let homePlantId: bigint;
  let foreignPlantId: bigint;

  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  const cycleIds: string[] = [];

  /**
   * A TROUBLESHOOT ticket with its own device + closed failure cycle (the `tickets_troubleshoot_
   * requires_cycle` CHECK wants a cycle; only one LIVE cycle may exist per device, and this spec
   * seeds several, so each is created already VERIFIED unless the ticket is still in flight).
   */
  const seedTicket = async (opts: {
    plantId: bigint;
    status: 'VERIFICATION_PENDING' | 'FAILED_VERIFICATION' | 'ESCALATED' | 'CLOSED';
    cycleLive?: boolean;
  }): Promise<{ ticketId: string; deviceId: string }> => {
    const deviceId = String(11_357_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    const cycle = await prisma.failureCycle.create({
      data: opts.cycleLive
        ? { deviceId, state: 'SUBMITTED', openedAt: JULY(1) }
        : { deviceId, state: 'VERIFIED', openedAt: JULY(1), closedAt: JULY(2) },
    });
    cycleIds.push(cycle.cycleId);
    const ticket = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: opts.status,
        failureCycleId: cycle.cycleId,
        deviceId,
        plantId: opts.plantId,
        companyId,
        companyTier: 'GOLD',
        lastStateChangedAt: JULY(2),
        createdAt: JULY(1),
      },
    });
    ticketIds.push(ticket.ticketId);
    return { ticketId: ticket.ticketId, deviceId };
  };

  const seedRun = (
    t: { ticketId: string; deviceId: string },
    data: { outcome?: 'CLOSED' | 'FAILED_VERIFICATION' | 'CLOSED_AUTO_RECOVERY' | null; fraudFlag?: boolean; startedAt?: Date },
  ) =>
    prisma.verificationRun.create({
      data: {
        ticketId: t.ticketId,
        deviceId: t.deviceId,
        startedAt: data.startedAt ?? JULY(3),
        outcome: data.outcome ?? null,
        outcomeAt: data.outcome ? JULY(3) : null,
        fraudFlag: data.fraudFlag ?? false,
        firstPingDistanceMeters: data.fraudFlag ? 55_000 : null,
        phase: 'PENDING',
      },
    });

  const latestRun = (ticketId: string) =>
    prisma.verificationRun.findFirstOrThrow({ where: { ticketId }, orderBy: { startedAt: 'desc' } });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    const zm = await prisma.user.findUniqueOrThrow({ where: { userId: ZM_NORTH }, select: { zoneId: true } });
    if (zm.zoneId == null) throw new Error('auth fixture: zm.north has no zone');
    homeZoneId = zm.zoneId;
    foreignZoneId = (await prisma.zone.create({ data: { name: 'Z-357-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-357-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    homePlantId = (await prisma.plant.create({ data: { name: 'P-357-home-' + NS, zoneId: homeZoneId } })).plantId;
    foreignPlantId = (await prisma.plant.create({ data: { name: 'P-357-far-' + NS, zoneId: foreignZoneId } })).plantId;
  });

  afterAll(async () => {
    await prisma.verificationRun.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.auditLog.deleteMany({ where: { entityType: 'tickets', entityId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.batchAssignmentTicket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { cycleId: { in: cycleIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [homePlantId, foreignPlantId] } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId: foreignZoneId } });
    await app.close();
  });

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  };

  const fraudFlags = async (token: string): Promise<Array<{ ticketId: string; zoneId: string; escalationReason: string | null }>> => {
    const res = await request(app.getHttpServer())
      .get('/api/verification/fraud-flags')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return res.body;
  };

  // ── AC1 — the fraud list is zone-scoped like its two siblings ────────────────────────────────────
  describe('AC1 — fraud flags are clamped to the caller’s zone', () => {
    let homeFraud: { ticketId: string; deviceId: string };
    let foreignFraud: { ticketId: string; deviceId: string };

    beforeAll(async () => {
      homeFraud = await seedTicket({ plantId: homePlantId, status: 'FAILED_VERIFICATION' });
      foreignFraud = await seedTicket({ plantId: foreignPlantId, status: 'FAILED_VERIFICATION' });
      await seedRun(homeFraud, { outcome: 'FAILED_VERIFICATION', fraudFlag: true });
      await seedRun(foreignFraud, { outcome: 'FAILED_VERIFICATION', fraudFlag: true });
    });

    it('a ZM sees their own zone’s fraud flag and NOT another zone’s', async () => {
      const rows = await fraudFlags(await login('zm.north@fsm.test'));
      const ids = rows.map((r) => r.ticketId);
      expect(ids).toContain(homeFraud.ticketId);
      expect(ids).not.toContain(foreignFraud.ticketId);
      // Every row a ZM is handed is their own zone's — not merely "the one we looked for".
      expect(rows.every((r) => r.zoneId === String(homeZoneId))).toBe(true);
    });

    it('a CSM sees both zones’ fraud flags', async () => {
      const ids = (await fraudFlags(await login('csm@fsm.test'))).map((r) => r.ticketId);
      expect(ids).toContain(homeFraud.ticketId);
      expect(ids).toContain(foreignFraud.ticketId);
    });

    it('an Operations Head sees both zones’ fraud flags', async () => {
      const ids = (await fraudFlags(await login('ops.head@fsm.test'))).map((r) => r.ticketId);
      expect(ids).toContain(homeFraud.ticketId);
      expect(ids).toContain(foreignFraud.ticketId);
    });
  });

  // ── AC5 / AC2 — mark-auto-recovery needs a reason, and leaves ONE verdict behind ─────────────────
  describe('AC5 — mark-auto-recovery requires a reason', () => {
    it('rejects a missing reason with 400 and changes nothing', async () => {
      const t = await seedTicket({ plantId: homePlantId, status: 'VERIFICATION_PENDING', cycleLive: true });
      await seedRun(t, { outcome: null });
      const token = await login('zm.north@fsm.test');

      await request(app.getHttpServer())
        .post(`/api/verification/${t.ticketId}/mark-auto-recovery`)
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(400);

      expect((await prisma.ticket.findUniqueOrThrow({ where: { ticketId: t.ticketId } })).status).toBe(
        'VERIFICATION_PENDING',
      );
    });

    it('rejects a blank reason with 400', async () => {
      const t = await seedTicket({ plantId: homePlantId, status: 'VERIFICATION_PENDING', cycleLive: true });
      await seedRun(t, { outcome: null });
      const token = await login('zm.north@fsm.test');

      await request(app.getHttpServer())
        .post(`/api/verification/${t.ticketId}/mark-auto-recovery`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: '   ' })
        .expect(400);
    });
  });

  describe('AC2 — after mark-auto-recovery the run and the ticket agree', () => {
    it('stamps the run CLOSED_AUTO_RECOVERY even when it had already FAILED', async () => {
      // The contradiction this AC closes: the run says FAILED_VERIFICATION, the ticket says
      // CLOSED_AUTO_RECOVERY, and both are the platform's own record of the same event.
      const t = await seedTicket({ plantId: homePlantId, status: 'FAILED_VERIFICATION' });
      await seedRun(t, { outcome: 'FAILED_VERIFICATION' });
      const token = await login('zm.north@fsm.test');

      await request(app.getHttpServer())
        .post(`/api/verification/${t.ticketId}/mark-auto-recovery`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'device pinged on its own overnight' })
        .expect(201);

      expect((await prisma.ticket.findUniqueOrThrow({ where: { ticketId: t.ticketId } })).status).toBe(
        'CLOSED_AUTO_RECOVERY',
      );
      expect((await latestRun(t.ticketId)).outcome).toBe('CLOSED_AUTO_RECOVERY');
    });

    it('still stamps an in-flight (null-outcome) run, and records the reason in the audit trail', async () => {
      const t = await seedTicket({ plantId: homePlantId, status: 'VERIFICATION_PENDING', cycleLive: true });
      await seedRun(t, { outcome: null });
      const token = await login('zm.north@fsm.test');

      await request(app.getHttpServer())
        .post(`/api/verification/${t.ticketId}/mark-auto-recovery`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'plant confirmed the unit is transmitting' })
        .expect(201);

      expect((await latestRun(t.ticketId)).outcome).toBe('CLOSED_AUTO_RECOVERY');
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { entityId: t.ticketId, action: 'MANUAL_AUTO_RECOVERY' },
      });
      expect((audit.metadata as { reason?: string }).reason).toBe('plant confirmed the unit is transmitting');
    });

    it('never overwrites a CLOSED verdict — auto-recovery does not un-verify a passed run', async () => {
      const t = await seedTicket({ plantId: homePlantId, status: 'VERIFICATION_PENDING', cycleLive: true });
      await seedRun(t, { outcome: 'CLOSED' });
      const token = await login('zm.north@fsm.test');

      await request(app.getHttpServer())
        .post(`/api/verification/${t.ticketId}/mark-auto-recovery`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'manager judgement' })
        .expect(201);

      expect((await latestRun(t.ticketId)).outcome).toBe('CLOSED');
    });

    it('the outcomes report counts the recovered run as auto-recovery, not as a failure', async () => {
      const t = await seedTicket({ plantId: homePlantId, status: 'FAILED_VERIFICATION' });
      await seedRun(t, { outcome: 'FAILED_VERIFICATION', startedAt: JULY(9) });
      const zm = await login('zm.north@fsm.test');

      const before = await request(app.getHttpServer())
        .get(`/api/reports/verification-outcomes?${WINDOW}&companyId=${companyId}`)
        .set('Authorization', `Bearer ${zm}`)
        .expect(200);
      const count = (body: { rows: Array<{ outcome: string; count: number }> }, key: string) =>
        body.rows.find((r) => r.outcome === key)!.count;
      const failedBefore = count(before.body, 'FAILED_VERIFICATION');
      const recoveredBefore = count(before.body, 'CLOSED_AUTO_RECOVERY');

      await request(app.getHttpServer())
        .post(`/api/verification/${t.ticketId}/mark-auto-recovery`)
        .set('Authorization', `Bearer ${zm}`)
        .send({ reason: 'recovered without a site visit' })
        .expect(201);

      const after = await request(app.getHttpServer())
        .get(`/api/reports/verification-outcomes?${WINDOW}&companyId=${companyId}`)
        .set('Authorization', `Bearer ${zm}`)
        .expect(200);
      expect(count(after.body, 'FAILED_VERIFICATION')).toBe(failedBefore - 1);
      expect(count(after.body, 'CLOSED_AUTO_RECOVERY')).toBe(recoveredBefore + 1);
    });
  });

  // ── AC3 / AC4 — escalation is reversible, and its reason is a column ─────────────────────────────
  describe('AC3 — de-escalate', () => {
    const escalate = async (ticketId: string, token: string) =>
      request(app.getHttpServer())
        .post(`/api/verification/${ticketId}/escalate`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'SE GPS 55km from the device' })
        .expect(201);

    it('returns the ticket to the state it was escalated from, and clears the run’s reason', async () => {
      const t = await seedTicket({ plantId: homePlantId, status: 'FAILED_VERIFICATION' });
      await seedRun(t, { outcome: 'FAILED_VERIFICATION', fraudFlag: true });
      const token = await login('zm.north@fsm.test');
      await escalate(t.ticketId, token);
      expect((await prisma.ticket.findUniqueOrThrow({ where: { ticketId: t.ticketId } })).status).toBe('ESCALATED');

      await request(app.getHttpServer())
        .post(`/api/verification/${t.ticketId}/deescalate`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'raised in error — the anchor GPS was wrong, not the device' })
        .expect(201);

      // Back to the pre-escalation review state, not to a hardcoded one.
      expect((await prisma.ticket.findUniqueOrThrow({ where: { ticketId: t.ticketId } })).status).toBe(
        'FAILED_VERIFICATION',
      );
      expect((await latestRun(t.ticketId)).escalationReason).toBeNull();
    });

    it('is audited with its reason and stamps a ticket event', async () => {
      const t = await seedTicket({ plantId: homePlantId, status: 'VERIFICATION_PENDING', cycleLive: true });
      await seedRun(t, { outcome: null, fraudFlag: true });
      const token = await login('csm@fsm.test');
      await escalate(t.ticketId, token);

      await request(app.getHttpServer())
        .post(`/api/verification/${t.ticketId}/deescalate`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'duplicate of an earlier escalation' })
        .expect(201);

      expect((await prisma.ticket.findUniqueOrThrow({ where: { ticketId: t.ticketId } })).status).toBe(
        'VERIFICATION_PENDING',
      );
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { entityId: t.ticketId, action: 'VERIFICATION_DEESCALATED' },
      });
      expect((audit.metadata as { reason?: string }).reason).toBe('duplicate of an earlier escalation');
      const event = await prisma.ticketEvent.findFirstOrThrow({
        where: { ticketId: t.ticketId, reasonCode: 'VERIFICATION_DEESCALATED' },
      });
      expect(event.fromState).toBe('ESCALATED');
      expect(event.toState).toBe('VERIFICATION_PENDING');
    });

    it('requires a reason (400)', async () => {
      const t = await seedTicket({ plantId: homePlantId, status: 'VERIFICATION_PENDING', cycleLive: true });
      await seedRun(t, { outcome: null, fraudFlag: true });
      const token = await login('zm.north@fsm.test');
      await escalate(t.ticketId, token);

      await request(app.getHttpServer())
        .post(`/api/verification/${t.ticketId}/deescalate`)
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(400);
      expect((await prisma.ticket.findUniqueOrThrow({ where: { ticketId: t.ticketId } })).status).toBe('ESCALATED');
    });

    it('is refused on a closed ticket (409)', async () => {
      const t = await seedTicket({ plantId: homePlantId, status: 'CLOSED' });
      await seedRun(t, { outcome: 'CLOSED' });
      const token = await login('zm.north@fsm.test');

      await request(app.getHttpServer())
        .post(`/api/verification/${t.ticketId}/deescalate`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'nope' })
        .expect(409);
      expect((await prisma.ticket.findUniqueOrThrow({ where: { ticketId: t.ticketId } })).status).toBe('CLOSED');
    });

    it('is 404 for a ZM outside the ticket’s zone, and 403 for a Service Engineer', async () => {
      const t = await seedTicket({ plantId: foreignPlantId, status: 'VERIFICATION_PENDING', cycleLive: true });
      await seedRun(t, { outcome: null, fraudFlag: true });
      await escalate(t.ticketId, await login('ops.head@fsm.test'));

      await request(app.getHttpServer())
        .post(`/api/verification/${t.ticketId}/deescalate`)
        .set('Authorization', `Bearer ${await login('zm.north@fsm.test')}`)
        .send({ reason: 'not mine to reverse' })
        .expect(404);
      await request(app.getHttpServer())
        .post(`/api/verification/${t.ticketId}/deescalate`)
        .set('Authorization', `Bearer ${await login('se.north@fsm.test')}`)
        .send({ reason: 'not my door' })
        .expect(403);

      expect((await prisma.ticket.findUniqueOrThrow({ where: { ticketId: t.ticketId } })).status).toBe('ESCALATED');
    });
  });

  describe('AC4 — the escalation reason is a column, and the report can read it', () => {
    it('persists the reason on the run and returns it from the outcomes report', async () => {
      const t = await seedTicket({ plantId: homePlantId, status: 'FAILED_VERIFICATION' });
      await seedRun(t, { outcome: 'FAILED_VERIFICATION', fraudFlag: true, startedAt: JULY(14) });
      const token = await login('zm.north@fsm.test');

      await request(app.getHttpServer())
        .post(`/api/verification/${t.ticketId}/escalate`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'first ping 55km from the SE anchor' })
        .expect(201);

      expect((await latestRun(t.ticketId)).escalationReason).toBe('first ping 55km from the SE anchor');

      const res = await request(app.getHttpServer())
        .get(`/api/reports/verification-outcomes?${WINDOW}&companyId=${companyId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const row = (res.body.escalations as Array<{ ticketId: string; escalationReason: string; outcome: string }>).find(
        (e) => e.ticketId === t.ticketId,
      );
      expect(row).toBeDefined();
      expect(row!.escalationReason).toBe('first ping 55km from the SE anchor');
      expect(row!.outcome).toBe('FAILED_VERIFICATION');
    });

    it('the reason is on the fraud-flag row too, so the review queue never has to join the audit log', async () => {
      const t = await seedTicket({ plantId: homePlantId, status: 'FAILED_VERIFICATION' });
      await seedRun(t, { outcome: 'FAILED_VERIFICATION', fraudFlag: true, startedAt: JULY(15) });
      const token = await login('zm.north@fsm.test');

      await request(app.getHttpServer())
        .post(`/api/verification/${t.ticketId}/escalate`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'anchor mismatch, escalated for review' })
        .expect(201);

      const row = (await fraudFlags(token)).find((f) => f.ticketId === t.ticketId);
      expect(row?.escalationReason).toBe('anchor mismatch, escalated for review');
    });

    it('a ZM’s escalation list is clamped too — another zone’s reason never leaks into the report', async () => {
      const far = await seedTicket({ plantId: foreignPlantId, status: 'FAILED_VERIFICATION' });
      await seedRun(far, { outcome: 'FAILED_VERIFICATION', fraudFlag: true, startedAt: JULY(16) });
      await request(app.getHttpServer())
        .post(`/api/verification/${far.ticketId}/escalate`)
        .set('Authorization', `Bearer ${await login('ops.head@fsm.test')}`)
        .send({ reason: 'foreign-zone escalation' })
        .expect(201);

      const zmRes = await request(app.getHttpServer())
        .get(`/api/reports/verification-outcomes?${WINDOW}&companyId=${companyId}`)
        .set('Authorization', `Bearer ${await login('zm.north@fsm.test')}`)
        .expect(200);
      const ohRes = await request(app.getHttpServer())
        .get(`/api/reports/verification-outcomes?${WINDOW}&companyId=${companyId}`)
        .set('Authorization', `Bearer ${await login('ops.head@fsm.test')}`)
        .expect(200);

      const ids = (body: { escalations: Array<{ ticketId: string }> }) => body.escalations.map((e) => e.ticketId);
      expect(ids(zmRes.body)).not.toContain(far.ticketId);
      expect(ids(ohRes.body)).toContain(far.ticketId);
    });
  });
});
