import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/auth/token.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RecommenderService } from '../src/recommender/recommender.service';
import { SHARED_AUTH_SE_ID, ensureSharedSeCoversPlant, releaseSharedSePlantCoverage } from './fixtures/shared-auth-se';

/**
 * Issue 16, slice 4 — the troubleshoot HTTP surface. POST /api/tickets/:id/troubleshoot submits the
 * structured form for the authenticated SE: root_cause_category required (400 without it), success →
 * VERIFICATION_PENDING, a duplicate client_submission_id is a 200 no-op. SE-only.
 *
 * #352 extends this file to the **component wire contract**: the two fields the mobile form will send
 * once it has a picker — `componentUnavailableItem` (required when `componentUnavailable` is true) and
 * `consumedComponents` — and the named error vocabulary the client renders (400
 * `COMPONENT_ITEM_REQUIRED`, 400 `UNKNOWN_COMPONENT`, 409 `INSUFFICIENT_VAN_STOCK`). These live here
 * rather than in the service specs because the defect they close is a *wire* defect: the service has
 * carried `consumedComponents` and a bigint item since Issue 24, and neither could be reached over
 * HTTP — the controller passed a hard `null` item into a CHECK constraint (500) and dropped consumed
 * parts on the floor.
 */
const NS = Date.now();
const SE_ID = SHARED_AUTH_SE_ID; // se.north@fsm.test — shared across 16 specs, see fixtures/shared-auth-se.ts

describe('SE troubleshoot controller (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: TokenService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let otherSeId: string; // an SE with NO coverage of `plantId` (#162 wrong-SE regression)
  // #352 fixtures. The shared auth SE's van stock is shared across sixteen files, so every
  // stock-mutating case below runs as an SE this file mints and owns.
  let cableId: bigint; // a real `component_master` row
  let wireSeId: string; // covers `plantId`, carries 5 cables
  let loserSeId: string; // covers `plantId`, carries 5 cables — the Business-409 shadow-use case
  let shortSeId: string; // covers `plantId`, carries 1 cable — the INSUFFICIENT_VAN_STOCK case
  // AC3's walk runs in a zone of its own so the recommender sees one plant, one SE, one ticket.
  let kitZoneId: bigint;
  let kitPlantId: bigint;
  let kitSeId: string;
  let kitDefs: { componentId: bigint; minQty: number }[];
  const wireSeIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];

  /** An SE of this file's own: covers `plantId`, carries `qty` cables. */
  const makeStockedSe = async (qty: number): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-tc-w-' + tag, email: `se-tc-w-${tag}@x.test`, zoneId },
    });
    wireSeIds.push(u.userId);
    await prisma.engineerMaster.create({ data: { engineerId: u.userId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
    await prisma.seCoverage.create({ data: { seId: u.userId, plantId, coverageType: 'DEDICATED' } });
    await prisma.seVanStock.create({ data: { seId: u.userId, componentId: cableId, qty } });
    return u.userId;
  };
  const tokenFor = (seId: string, zone: bigint = zoneId): string =>
    tokens.signAccessToken({ user_id: seId, role: 'SERVICE_ENGINEER', zone_id: Number(zone) });
  const stockOf = async (seId: string): Promise<number> =>
    (await prisma.seVanStock.findUniqueOrThrow({ where: { seId_componentId: { seId, componentId: cableId } } })).qty;

  const makeTicket = async (): Promise<string> => {
    const deviceId = String(11_500_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: new Date() } });
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
    ticketIds.push(ticket.ticketId);
    return ticket.ticketId;
  };

  /**
   * A ticket the Recommender will actually look at (#352 AC3): on `kitPlantId`, with the
   * `device_states` row the morning pool selects on. Same shape `recommender-common-kit.e2e-spec.ts`
   * uses — the pool reads device state, not the ticket alone.
   */
  const makeDispatchableTicket = async (now: Date): Promise<string> => {
    const deviceId = String(11_500_000_000 + (NS % 100_000) * 10 + 500 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId, isInactive: true, slaBucket: 'CRITICAL', eligibleForUptime: true, hasOpenFailureCycle: true,
        latestGpsDatetime: new Date(now.getTime() - 30 * 60_000), plantId: kitPlantId, companyId, computedAt: now,
      },
    });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: now } });
    const ticket = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT', status: 'OPEN', failureCycleId: cycle.cycleId, deviceId,
        plantId: kitPlantId, companyId, companyTier: 'GOLD', lastStateChangedAt: now,
      },
    });
    ticketIds.push(ticket.ticketId);
    return ticket.ticketId;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-tc-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-tc-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-tc-' + NS, zoneId } })).plantId;
    await ensureSharedSeCoversPlant(prisma, { zoneId, plantId, tag: `tc-${NS}` });

    // A second, real SE with no coverage of `plantId` at all — the #162 wrong-SE regression case.
    const otherTag = randomUUID().slice(0, 8);
    const otherUser = await prisma.user.create({
      data: { name: 'SE Other', role: 'SERVICE_ENGINEER', phone: 'ph-tc-other-' + otherTag, email: `se-tc-other-${otherTag}@x.test`, zoneId },
    });
    otherSeId = otherUser.userId;
    await prisma.engineerMaster.create({ data: { engineerId: otherSeId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });

    // #352 — the catalog row the wire cases name, and the three SEs that carry it.
    cableId = (await prisma.componentMaster.create({ data: { name: 'cable-tc-' + NS, category: 'CABLE' } })).componentId;
    wireSeId = await makeStockedSe(5);
    loserSeId = await makeStockedSe(5);
    shortSeId = await makeStockedSe(1);

    // #352 AC3 — a zone of its own, so the recommender run at the end of the walk sees exactly one
    // plant, one SE and one ticket instead of everything the cases above left lying in `zoneId`.
    kitZoneId = (await prisma.zone.create({ data: { name: 'Z-tc-kit-' + NS } })).zoneId;
    kitPlantId = (await prisma.plant.create({ data: { name: 'P-tc-kit-' + NS, zoneId: kitZoneId } })).plantId;
    const kitTag = randomUUID().slice(0, 8);
    kitSeId = (
      await prisma.user.create({
        data: { name: 'SE ' + kitTag, role: 'SERVICE_ENGINEER', phone: 'ph-tc-k-' + kitTag, email: `se-tc-k-${kitTag}@x.test`, zoneId: kitZoneId },
      })
    ).userId;
    wireSeIds.push(kitSeId);
    await prisma.engineerMaster.create({ data: { engineerId: kitSeId, coverageType: 'DEDICATED', zoneId: kitZoneId, dailyCapacity: 10 } });
    await prisma.seCoverage.create({ data: { seId: kitSeId, plantId: kitPlantId, coverageType: 'DEDICATED' } });
    // Stocked to EXACTLY the seeded Common Kit's minimums (`org-seed.ts` — Cable 1, SIM 1, Antenna 1,
    // Fuse 2). No kit definition is created here on purpose: `common_kit_definition` is global, and a
    // spec that adds an active row to it grounds every other SE in the database for as long as it runs.
    kitDefs = await prisma.commonKitDefinition.findMany({ where: { active: true } });
    for (const k of kitDefs) {
      await prisma.seVanStock.create({ data: { seId: kitSeId, componentId: k.componentId, qty: k.minQty } });
    }
  });

  afterAll(async () => {
    // se_coverage first: se_coverage_se_id_fkey is ON DELETE RESTRICT (#255 AC-3). And guard on
    // `otherSeId` — if beforeAll threw before it was assigned, an undefined filter is dropped by
    // Prisma and `deleteMany` would clear engineer_master wholesale.
    await releaseSharedSePlantCoverage(prisma, plantId);
    if (otherSeId) {
      await prisma.engineerMaster.deleteMany({ where: { engineerId: otherSeId } });
      await prisma.user.deleteMany({ where: { userId: otherSeId } });
    }
    // #352 — component_requests reference submission_id, so they go before the submissions below.
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.componentBlockedQueue.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.inventoryTransaction.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.componentRequest.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.softState.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.troubleshootingSubmission.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.auditLog.deleteMany({ where: { entityType: 'tickets', entityId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    if (wireSeIds.length > 0) {
      await prisma.seCoverage.deleteMany({ where: { seId: { in: wireSeIds } } });
      await prisma.seVanStock.deleteMany({ where: { seId: { in: wireSeIds } } });
      await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: wireSeIds } } });
      await prisma.user.deleteMany({ where: { userId: { in: wireSeIds } } });
    }
    if (cableId) await prisma.componentMaster.deleteMany({ where: { componentId: cableId } });
    await prisma.plant.deleteMany({ where: { plantId } });
    if (kitPlantId) await prisma.plant.deleteMany({ where: { plantId: kitPlantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    if (kitZoneId) await prisma.zone.deleteMany({ where: { zoneId: kitZoneId } });
    await app.close();
  });

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-password' }).expect(200);
    return res.body.accessToken as string;
  }

  it('submits the form and moves the ticket to VERIFICATION_PENDING', async () => {
    const token = await login('se.north@fsm.test');
    const ticketId = await makeTicket();
    const res = await request(app.getHttpServer())
      .post(`/api/tickets/${ticketId}/troubleshoot`)
      .set('Authorization', `Bearer ${token}`)
      .send({ clientSubmissionId: randomUUID(), rootCauseCategory: 'GPS_ANTENNA_ISSUE', seGps: { lat: 12.9, lon: 77.5 } })
      .expect(201);
    expect(res.body.result).toBe('OK');
    expect(res.body.duplicate).toBe(false);
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
    expect(ticket.status).toBe('VERIFICATION_PENDING');
  });

  it('rejects a submission without root_cause_category (400)', async () => {
    const token = await login('se.north@fsm.test');
    const ticketId = await makeTicket();
    await request(app.getHttpServer())
      .post(`/api/tickets/${ticketId}/troubleshoot`)
      .set('Authorization', `Bearer ${token}`)
      .send({ clientSubmissionId: randomUUID() })
      .expect(400);
  });

  it('returns the existing record on a duplicate client_submission_id', async () => {
    const token = await login('se.north@fsm.test');
    const ticketId = await makeTicket();
    const clientSubmissionId = randomUUID();
    const first = await request(app.getHttpServer())
      .post(`/api/tickets/${ticketId}/troubleshoot`)
      .set('Authorization', `Bearer ${token}`)
      .send({ clientSubmissionId, rootCauseCategory: 'WIRING_ISSUE' })
      .expect(201);
    const second = await request(app.getHttpServer())
      .post(`/api/tickets/${ticketId}/troubleshoot`)
      .set('Authorization', `Bearer ${token}`)
      .send({ clientSubmissionId, rootCauseCategory: 'WIRING_ISSUE' })
      .expect(201);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.submission.submissionId).toBe(first.body.submission.submissionId);
  });

  it('#162 — rejects a submission from a correctly-authenticated SE outside the ticket coverage (404, no submission row)', async () => {
    const ticketId = await makeTicket();
    const token = tokens.signAccessToken({ user_id: otherSeId, role: 'SERVICE_ENGINEER', zone_id: Number(zoneId) });
    await request(app.getHttpServer())
      .post(`/api/tickets/${ticketId}/troubleshoot`)
      .set('Authorization', `Bearer ${token}`)
      .send({ clientSubmissionId: randomUUID(), rootCauseCategory: 'UNKNOWN' })
      .expect(404);
    const rows = await prisma.troubleshootingSubmission.findMany({ where: { ticketId } });
    expect(rows.length).toBe(0);
  });

  it('forbids a non-SE role', async () => {
    const token = await login('zm.north@fsm.test');
    const ticketId = await makeTicket();
    await request(app.getHttpServer())
      .post(`/api/tickets/${ticketId}/troubleshoot`)
      .set('Authorization', `Bearer ${token}`)
      .send({ clientSubmissionId: randomUUID(), rootCauseCategory: 'UNKNOWN' })
      .expect(403);
  });

  // ---------------------------------------------------------------------------------------------
  // #352 — the component wire contract.
  // ---------------------------------------------------------------------------------------------

  describe('#352 component-unavailable (AC1)', () => {
    it('AC1 — an item names the component on the raised request, and the ticket stays OPEN', async () => {
      const ticketId = await makeTicket();
      const res = await request(app.getHttpServer())
        .post(`/api/tickets/${ticketId}/troubleshoot`)
        .set('Authorization', `Bearer ${tokenFor(wireSeId)}`)
        .send({
          clientSubmissionId: randomUUID(),
          rootCauseCategory: 'GPS_ANTENNA_ISSUE',
          componentUnavailable: true,
          componentUnavailableItem: String(cableId),
        })
        .expect(201);
      expect(res.body.result).toBe('OK');

      const req = await prisma.componentRequest.findFirstOrThrow({ where: { ticketId } });
      expect(req.componentId).toBe(cableId);
      expect(req.status).toBe('REQUESTED');
      expect(req.submissionId).toBe(res.body.submission.submissionId);
      // ADR-0008: the ticket stays OPEN and the cycle waits for the part.
      expect((await prisma.ticket.findUniqueOrThrow({ where: { ticketId } })).status).toBe('OPEN');
    });

    it('AC1 — without an item it is a 400 COMPONENT_ITEM_REQUIRED, never a 500', async () => {
      const ticketId = await makeTicket();
      const res = await request(app.getHttpServer())
        .post(`/api/tickets/${ticketId}/troubleshoot`)
        .set('Authorization', `Bearer ${tokenFor(wireSeId)}`)
        .send({ clientSubmissionId: randomUUID(), rootCauseCategory: 'GPS_ANTENNA_ISSUE', componentUnavailable: true })
        .expect(400);
      expect(res.body.code).toBe('COMPONENT_ITEM_REQUIRED');
      // The 500 this closes left a half-story behind: no submission, no request, and no way to tell.
      expect(await prisma.troubleshootingSubmission.count({ where: { ticketId } })).toBe(0);
      expect(await prisma.componentRequest.count({ where: { ticketId } })).toBe(0);
    });

    it('AC1 — an item that is not in the catalog is a 400 UNKNOWN_COMPONENT', async () => {
      const ticketId = await makeTicket();
      const res = await request(app.getHttpServer())
        .post(`/api/tickets/${ticketId}/troubleshoot`)
        .set('Authorization', `Bearer ${tokenFor(wireSeId)}`)
        .send({
          clientSubmissionId: randomUUID(),
          rootCauseCategory: 'GPS_ANTENNA_ISSUE',
          componentUnavailable: true,
          componentUnavailableItem: '999999999',
        })
        .expect(400);
      expect(res.body.code).toBe('UNKNOWN_COMPONENT');
      expect(res.body.componentIds).toEqual(['999999999']);
      expect(await prisma.troubleshootingSubmission.count({ where: { ticketId } })).toBe(0);
    });

    it('AC1 — a non-numeric item id is the same 400 UNKNOWN_COMPONENT, not a BigInt SyntaxError 500', async () => {
      const ticketId = await makeTicket();
      const res = await request(app.getHttpServer())
        .post(`/api/tickets/${ticketId}/troubleshoot`)
        .set('Authorization', `Bearer ${tokenFor(wireSeId)}`)
        .send({
          clientSubmissionId: randomUUID(),
          rootCauseCategory: 'GPS_ANTENNA_ISSUE',
          componentUnavailable: true,
          componentUnavailableItem: 'antenna',
        })
        .expect(400);
      expect(res.body.code).toBe('UNKNOWN_COMPONENT');
    });
  });

  describe('#352 consumed components (AC2)', () => {
    it('AC2 — decrements van stock and writes a PRE_VERIFICATION TICKET_CONSUMPTION row', async () => {
      const before = await stockOf(wireSeId);
      const ticketId = await makeTicket();
      const res = await request(app.getHttpServer())
        .post(`/api/tickets/${ticketId}/troubleshoot`)
        .set('Authorization', `Bearer ${tokenFor(wireSeId)}`)
        .send({
          clientSubmissionId: randomUUID(),
          rootCauseCategory: 'WIRING_ISSUE',
          consumedComponents: [{ componentId: String(cableId), qty: 2 }],
        })
        .expect(201);

      const txns = await prisma.inventoryTransaction.findMany({ where: { ticketId, seId: wireSeId } });
      expect(txns).toHaveLength(1);
      expect(txns[0].type).toBe('TICKET_CONSUMPTION');
      expect(txns[0].status).toBe('PRE_VERIFICATION');
      expect(txns[0].qty).toBe(2);
      expect(txns[0].componentId).toBe(cableId);
      expect(txns[0].submissionId).toBe(res.body.submission.submissionId);
      expect(await stockOf(wireSeId)).toBe(before - 2);
    });

    it('AC2 — the Business-409 path records SHADOW_USE and answers shadowUseRecorded: true', async () => {
      const ticketId = await makeTicket();
      // The winner submits and the ticket leaves OPEN.
      await request(app.getHttpServer())
        .post(`/api/tickets/${ticketId}/troubleshoot`)
        .set('Authorization', `Bearer ${tokenFor(wireSeId)}`)
        .send({ clientSubmissionId: randomUUID(), rootCauseCategory: 'WIRING_ISSUE' })
        .expect(201);

      const before = await stockOf(loserSeId);
      const res = await request(app.getHttpServer())
        .post(`/api/tickets/${ticketId}/troubleshoot`)
        .set('Authorization', `Bearer ${tokenFor(loserSeId)}`)
        .send({
          clientSubmissionId: randomUUID(),
          rootCauseCategory: 'WIRING_ISSUE',
          consumedComponents: [{ componentId: String(cableId), qty: 1 }],
        })
        .expect(409);
      expect(res.body.code).toBe('TICKET_ALREADY_CLOSED');
      expect(res.body.shadowUseRecorded).toBe(true); // permanently false before #352
      expect(res.body.winnerSeId).toBe(wireSeId);

      const shadow = await prisma.inventoryTransaction.findMany({
        where: { ticketId, seId: loserSeId, status: 'SHADOW_USE' },
      });
      expect(shadow).toHaveLength(1);
      expect(await stockOf(loserSeId)).toBe(before - 1); // the van is short whatever the ticket did
    });

    it('AC2 — consuming more than the van carries is a 409 INSUFFICIENT_VAN_STOCK that writes nothing', async () => {
      const before = await stockOf(shortSeId); // 1
      const ticketId = await makeTicket();
      const res = await request(app.getHttpServer())
        .post(`/api/tickets/${ticketId}/troubleshoot`)
        .set('Authorization', `Bearer ${tokenFor(shortSeId)}`)
        .send({
          clientSubmissionId: randomUUID(),
          rootCauseCategory: 'WIRING_ISSUE',
          consumedComponents: [{ componentId: String(cableId), qty: before + 1 }],
        })
        .expect(409);
      expect(res.body.code).toBe('INSUFFICIENT_VAN_STOCK');
      expect(res.body.shortages).toEqual([{ componentId: String(cableId), requested: before + 1, available: before }]);
      expect(await stockOf(shortSeId)).toBe(before);
      expect(await prisma.troubleshootingSubmission.count({ where: { ticketId } })).toBe(0);
      expect(await prisma.inventoryTransaction.count({ where: { ticketId } })).toBe(0);
    });

    it('AC2 — an unknown consumed component is a 400 UNKNOWN_COMPONENT, not an FK 500', async () => {
      const ticketId = await makeTicket();
      const res = await request(app.getHttpServer())
        .post(`/api/tickets/${ticketId}/troubleshoot`)
        .set('Authorization', `Bearer ${tokenFor(wireSeId)}`)
        .send({
          clientSubmissionId: randomUUID(),
          rootCauseCategory: 'WIRING_ISSUE',
          consumedComponents: [{ componentId: '999999999', qty: 1 }],
        })
        .expect(400);
      expect(res.body.code).toBe('UNKNOWN_COMPONENT');
      expect(await prisma.troubleshootingSubmission.count({ where: { ticketId } })).toBe(0);
    });

    it('rejects a malformed consumedComponents entry at the pipe (qty must be a positive int)', async () => {
      const ticketId = await makeTicket();
      await request(app.getHttpServer())
        .post(`/api/tickets/${ticketId}/troubleshoot`)
        .set('Authorization', `Bearer ${tokenFor(wireSeId)}`)
        .send({
          clientSubmissionId: randomUUID(),
          rootCauseCategory: 'WIRING_ISSUE',
          consumedComponents: [{ componentId: String(cableId), qty: 0 }],
        })
        .expect(400);
      await request(app.getHttpServer())
        .post(`/api/tickets/${ticketId}/troubleshoot`)
        .set('Authorization', `Bearer ${tokenFor(wireSeId)}`)
        .send({ clientSubmissionId: randomUUID(), rootCauseCategory: 'WIRING_ISSUE', consumedComponents: 'cable' })
        .expect(400);
      expect(await prisma.troubleshootingSubmission.count({ where: { ticketId } })).toBe(0);
    });

    it('AC5 — a submission carrying neither new field is unchanged: no request, no ledger row', async () => {
      const before = await stockOf(wireSeId);
      const ticketId = await makeTicket();
      await request(app.getHttpServer())
        .post(`/api/tickets/${ticketId}/troubleshoot`)
        .set('Authorization', `Bearer ${tokenFor(wireSeId)}`)
        .send({ clientSubmissionId: randomUUID(), rootCauseCategory: 'POWER_ISSUE', seGps: { lat: 12.9, lon: 77.5 } })
        .expect(201);
      expect((await prisma.ticket.findUniqueOrThrow({ where: { ticketId } })).status).toBe('VERIFICATION_PENDING');
      expect(await prisma.componentRequest.count({ where: { ticketId } })).toBe(0);
      expect(await prisma.inventoryTransaction.count({ where: { ticketId } })).toBe(0);
      expect(await stockOf(wireSeId)).toBe(before);
    });
  });

  describe('#352 consumption reaches the Common Kit and the Recommender (AC3)', () => {
    it('AC3 — a consumption that empties a kit item flips the kit and blocks the next ticket', async () => {
      const now = new Date('2026-06-23T06:00:00Z');
      const token = tokenFor(kitSeId, kitZoneId);
      const cable = kitDefs[0];

      // 1. The van is exactly kit-complete to start with.
      const before = await request(app.getHttpServer()).get('/api/me/van-stock').set('Authorization', `Bearer ${token}`).expect(200);
      expect(before.body.commonKit.complete).toBe(true);

      // 2. The SE fits the last one on a real visit, over the wire.
      const ticketA = await makeDispatchableTicket(now);
      await request(app.getHttpServer())
        .post(`/api/tickets/${ticketA}/troubleshoot`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          clientSubmissionId: randomUUID(),
          rootCauseCategory: 'WIRING_ISSUE',
          consumedComponents: [{ componentId: String(cable.componentId), qty: cable.minQty }],
        })
        .expect(201);

      // 3. The Common Kit notices — the SE mobile Home badge and the Recommender read the same source.
      const after = await request(app.getHttpServer()).get('/api/me/van-stock').set('Authorization', `Bearer ${token}`).expect(200);
      expect(after.body.commonKit.complete).toBe(false);
      expect((after.body.commonKit.missing as { componentId: string; shortBy: number }[])).toContainEqual(
        expect.objectContaining({ componentId: String(cable.componentId), shortBy: cable.minQty }),
      );

      // 4. …and so does the Recommender: the zone's only SE now fails the Common-Kit Hard Filter, so
      //    the next ticket is left unassigned and lands on the Component-Blocked Queue with the part.
      const ticketB = await makeDispatchableTicket(now);
      const summary = await app.get(RecommenderService).runForZone(kitZoneId, { now });
      expect(summary.recommended).toBe(0);
      expect(summary.unassignable).toBe(1);

      const blocked = await prisma.componentBlockedQueue.findFirstOrThrow({ where: { ticketId: ticketB, resolvedAt: null } });
      expect(blocked.reason).toBe('COMMON_KIT_INCOMPLETE');
      expect(blocked.seId).toBe(kitSeId);
      expect((blocked.missingComponents as { componentId: string }[]).some((m) => m.componentId === String(cable.componentId))).toBe(true);
    });
  });

  describe('#352 GET /api/components (AC4)', () => {
    it('AC4 — returns the catalog to an SE, in the shape the picker reads', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/components')
        .set('Authorization', `Bearer ${tokenFor(wireSeId)}`)
        .expect(200);
      expect(Array.isArray(res.body)).toBe(true);
      const row = (res.body as { componentId: string; name: string; category: string | null; serialTracked: boolean }[]).find(
        (c) => c.componentId === String(cableId),
      );
      expect(row).toEqual({ componentId: String(cableId), name: 'cable-tc-' + NS, category: 'CABLE', serialTracked: false });
    });

    it('AC4 — is readable by a manager too (one catalog, every role)', async () => {
      const token = await login('wm@fsm.test');
      const res = await request(app.getHttpServer()).get('/api/components').set('Authorization', `Bearer ${token}`).expect(200);
      expect((res.body as { componentId: string }[]).some((c) => c.componentId === String(cableId))).toBe(true);
    });

    it('AC4 — is not public', async () => {
      await request(app.getHttpServer()).get('/api/components').expect(401);
    });
  });
});
