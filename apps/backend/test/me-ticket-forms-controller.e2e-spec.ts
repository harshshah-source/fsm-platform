import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/auth/token.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * #161 item 3 — `GET /api/me/tickets/:id/forms`, the SE-readable variant of the manager-only
 * `GET /api/tickets/:id/forms` (`ticket-forms-read.e2e-spec.ts`). Scoped to the caller's OWN
 * submissions on the ticket — never another SE's, even when both submitted on the same ticket.
 *
 * Access to the ticket itself reuses #161 item 1's rule (assigned/covered — `se-ticket-access.ts`),
 * OR'd with "the caller has at least one submission of their own on this ticket" so an SE keeps
 * read access to their own submission history even if the ticket's coverage moves on afterward
 * (a zone/plant reassignment, #158, must not erase an SE's own past work from their view).
 */
const NS = Date.now();

describe('#161 item 3 — GET /api/me/tickets/:id/forms (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: TokenService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint; // covered by both seA and seB
  let otherPlantId: bigint; // uncovered by either SE
  let tempPlantId: bigint; // covered by seA only, revoked mid-test
  let seA: string;
  let seB: string;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  const NOW = new Date('2026-08-03T06:00:00Z');

  const makePoolTicket = async (plant: bigint): Promise<string> => {
    const deviceId = String(9_800_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: NOW } });
    const ticket = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT', status: 'OPEN', assignmentState: 'UNASSIGNED', failureCycleId: cycle.cycleId,
        deviceId, plantId: plant, companyId, companyTier: 'GOLD', lastStateChangedAt: NOW,
      },
    });
    ticketIds.push(ticket.ticketId);
    return ticket.ticketId;
  };

  const tokenFor = (seId: string) => tokens.signAccessToken({ user_id: seId, role: 'SERVICE_ENGINEER', zone_id: Number(zoneId) });

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-password' }).expect(200);
    return res.body.accessToken as string;
  }

  async function submitForm(token: string, ticketId: string, rootCauseCategory: string, diagnosisNotes: string): Promise<void> {
    await request(app.getHttpServer())
      .post(`/api/tickets/${ticketId}/troubleshoot`)
      .set('Authorization', `Bearer ${token}`)
      .send({ clientSubmissionId: randomUUID(), rootCauseCategory, diagnosisNotes })
      .expect(201);
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-mtf-' + NS } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-mtf-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-mtf-' + NS, zoneId } })).plantId;
    otherPlantId = (await prisma.plant.create({ data: { name: 'P-mtf-other-' + NS, zoneId } })).plantId;
    tempPlantId = (await prisma.plant.create({ data: { name: 'P-mtf-temp-' + NS, zoneId } })).plantId;

    const tagA = randomUUID().slice(0, 8);
    const uA = await prisma.user.create({ data: { name: 'SE A ' + tagA, role: 'SERVICE_ENGINEER', phone: 'mtf-a-' + tagA, email: `${tagA}@mtf.test`, zoneId } });
    seA = uA.userId;
    userIds.push(seA);
    await prisma.engineerMaster.create({ data: { engineerId: seA, coverageType: 'MULTI_PLANT', zoneId, dailyCapacity: 10 } });
    await prisma.seCoverage.create({ data: { seId: seA, plantId, coverageType: 'MULTI_PLANT' } });
    await prisma.seCoverage.create({ data: { seId: seA, plantId: tempPlantId, coverageType: 'MULTI_PLANT' } });

    const tagB = randomUUID().slice(0, 8);
    const uB = await prisma.user.create({ data: { name: 'SE B ' + tagB, role: 'SERVICE_ENGINEER', phone: 'mtf-b-' + tagB, email: `${tagB}@mtf.test`, zoneId } });
    seB = uB.userId;
    userIds.push(seB);
    await prisma.engineerMaster.create({ data: { engineerId: seB, coverageType: 'MULTI_PLANT', zoneId, dailyCapacity: 10 } });
    await prisma.seCoverage.create({ data: { seId: seB, plantId, coverageType: 'MULTI_PLANT' } });
  });

  afterAll(async () => {
    await prisma.componentRequest.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.troubleshootingSubmission.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.seCoverage.deleteMany({ where: { seId: { in: userIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [plantId, otherPlantId, tempPlantId] } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await app.close();
  });

  it("returns the SE's own submitted form for a ticket they cover", async () => {
    const ticketId = await makePoolTicket(plantId);
    await submitForm(tokenFor(seA), ticketId, 'GPS_ANTENNA_ISSUE', 'antenna reseated');

    const res = await request(app.getHttpServer())
      .get(`/api/me/tickets/${ticketId}/forms`)
      .set('Authorization', `Bearer ${tokenFor(seA)}`)
      .expect(200);

    expect(res.body.ticketId).toBe(ticketId);
    expect(res.body.forms).toHaveLength(1);
    expect(res.body.forms[0].seId).toBe(seA);
    expect(res.body.forms[0].rootCauseCategory).toBe('GPS_ANTENNA_ISSUE');
    expect(res.body.forms[0].diagnosisNotes).toBe('antenna reseated');
    expect(res.body.forms[0].submittedAt).toBeDefined();
  });

  it('returns an empty forms array for a ticket the SE can read but has not submitted on', async () => {
    const ticketId = await makePoolTicket(plantId);
    const res = await request(app.getHttpServer())
      .get(`/api/me/tickets/${ticketId}/forms`)
      .set('Authorization', `Bearer ${tokenFor(seA)}`)
      .expect(200);
    expect(res.body.forms).toEqual([]);
  });

  it("never returns another SE's submission on the same ticket", async () => {
    // A real first submission moves the ticket OPEN → VERIFICATION_PENDING, so a second SE's own
    // `POST .../troubleshoot` would 409 (Business-409 conflict) rather than land a second row — that
    // workflow rule is #16's, not this read's. Insert seB's row directly to isolate what this
    // endpoint alone is responsible for: filtering by `seId`, not the submission workflow.
    const ticketId = await makePoolTicket(plantId);
    await submitForm(tokenFor(seA), ticketId, 'GPS_ANTENNA_ISSUE', 'seA diagnosis');
    const cycle = await prisma.ticket.findUniqueOrThrow({ where: { ticketId }, select: { failureCycleId: true } });
    await prisma.troubleshootingSubmission.create({
      data: {
        ticketId, failureCycleId: cycle.failureCycleId!, submissionType: 'TROUBLESHOOTING_FORM',
        clientSubmissionId: randomUUID(), seId: seB, presenceSource: 'NONE',
        rootCauseCategory: 'POWER_ISSUE', diagnosisNotes: 'seB diagnosis', submittedAt: NOW,
      },
    });

    const resA = await request(app.getHttpServer())
      .get(`/api/me/tickets/${ticketId}/forms`)
      .set('Authorization', `Bearer ${tokenFor(seA)}`)
      .expect(200);
    expect(resA.body.forms).toHaveLength(1);
    expect(resA.body.forms[0].seId).toBe(seA);
    expect(resA.body.forms[0].diagnosisNotes).toBe('seA diagnosis');

    const resB = await request(app.getHttpServer())
      .get(`/api/me/tickets/${ticketId}/forms`)
      .set('Authorization', `Bearer ${tokenFor(seB)}`)
      .expect(200);
    expect(resB.body.forms).toHaveLength(1);
    expect(resB.body.forms[0].seId).toBe(seB);
    expect(resB.body.forms[0].diagnosisNotes).toBe('seB diagnosis');
  });

  it("keeps an SE's own submission readable after the ticket leaves their live coverage", async () => {
    const ticketId = await makePoolTicket(tempPlantId);
    await submitForm(tokenFor(seA), ticketId, 'WIRING_ISSUE', 'wiring fixed before reassignment');

    // The submission itself already moved the ticket to VERIFICATION_PENDING, and coverage is now
    // revoked too (e.g. a #158 plant-to-zone move) — seA has no remaining access path to the ticket
    // itself via item 1's rule...
    await prisma.seCoverage.deleteMany({ where: { seId: seA, plantId: tempPlantId } });
    await request(app.getHttpServer())
      .get(`/api/me/tickets/${ticketId}`)
      .set('Authorization', `Bearer ${tokenFor(seA)}`)
      .expect(404);

    // ...but their own submitted form on it remains readable.
    const res = await request(app.getHttpServer())
      .get(`/api/me/tickets/${ticketId}/forms`)
      .set('Authorization', `Bearer ${tokenFor(seA)}`)
      .expect(200);
    expect(res.body.forms).toHaveLength(1);
    expect(res.body.forms[0].diagnosisNotes).toBe('wiring fixed before reassignment');
  });

  it('404s a ticket outside coverage with no own submissions on it', async () => {
    const ticketId = await makePoolTicket(otherPlantId);
    await request(app.getHttpServer())
      .get(`/api/me/tickets/${ticketId}/forms`)
      .set('Authorization', `Bearer ${tokenFor(seA)}`)
      .expect(404);
  });

  it('404s an unknown ticket id', async () => {
    await request(app.getHttpServer())
      .get(`/api/me/tickets/${randomUUID()}/forms`)
      .set('Authorization', `Bearer ${tokenFor(seA)}`)
      .expect(404);
  });

  it('403s for a non-SE role', async () => {
    const ticketId = await makePoolTicket(plantId);
    const zmToken = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .get(`/api/me/tickets/${ticketId}/forms`)
      .set('Authorization', `Bearer ${zmToken}`)
      .expect(403);
  });

  it('401s an unauthenticated request', async () => {
    const ticketId = await makePoolTicket(plantId);
    await request(app.getHttpServer()).get(`/api/me/tickets/${ticketId}/forms`).expect(401);
  });
});
