import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * #340 AC2 — a write made while acting is stamped with the acting role **and the acting zone**.
 *
 * #339 made the acting claim *true* (the gate proves it before any handler runs). #340 makes it
 * *recorded*. The two are separate defects and this file only pins the second: the guard already put
 * a proven `request.acting` on the request, and the eleven controller doors threw it away by
 * hand-building `{ …, actedAsRole: null }`.
 *
 * **Both columns, not one.** `acted_as_role` alone is not enough: the CSM-backup-share report
 * (Issue 27, `csmBackupShareByZone`) groups by `acting_zone`, so an audit row stamped with the role
 * and no zone is invisible to the one reader that exists for this attribution. Every assertion here
 * checks the pair.
 *
 * **The pair of roles is the point.** A CSM acting and an Operations Head acting reach the gate by
 * two different routes — the CSM only because the cascade named them, the OH unconditionally by
 * pan-India authority — and only one of those routes existed in the old code's imagination. Running
 * the same write down both is what tells "attribution is wired" apart from "the CSM path happens to
 * work".
 *
 * The door under test is `POST /api/tickets/:id/auto-recovery-close`: one of the eleven, and the
 * only one of them a CSM and an Operations Head may *both* call, so the same write really is the
 * same write.
 */
const DEV_CSM = String(9_340_001n);
const DEV_OH = String(9_340_002n);
const ALL = [DEV_CSM, DEV_OH];

describe('#340 — acting attribution reaches the audit row (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let windowId: bigint;
  const ticketByDevice = new Map<string, string>();

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  };

  const seedOpen = async (deviceId: string) => {
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

    zoneId = (await prisma.zone.create({ data: { name: 'Z-attr-' + Date.now() } })).zoneId;
    companyId = (
      await prisma.company.create({
        data: { name: 'Co-attr-' + Date.now(), companyTier: 'GOLD', companyPriorityRank: 'B' },
      })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-attr-' + Date.now(), zoneId } })).plantId;

    // The CSM half of the pair only reaches the handler at all while this zone's ZM duty has actually
    // cascaded (#339). Opening the window is a precondition of the test, not part of what it asserts.
    windowId = (
      await prisma.roleUnavailability.create({
        data: {
          role: 'ZONAL_MANAGER',
          zoneId,
          windowStart: new Date(Date.now() - 60 * 60_000),
          windowEnd: null,
          reason: 'fixture: ZM out (#340)',
          createdByRole: 'OPERATIONS_HEAD',
        },
      })
    ).id;

    await seedOpen(DEV_CSM);
    await seedOpen(DEV_OH);
  });

  afterAll(async () => {
    const ticketIds = [...ticketByDevice.values()];
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticket: { deviceId: { in: ALL } } } });
    await prisma.ticket.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.roleUnavailability.deleteMany({ where: { id: windowId } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await app.close();
  });

  async function closeActingAs(email: string, deviceId: string): Promise<void> {
    const token = await login(email);
    await request(app.getHttpServer())
      .post(`/api/tickets/${ticketByDevice.get(deviceId)}/auto-recovery-close`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Acting-As-Zone', String(zoneId))
      .expect(200);
  }

  async function auditRowFor(deviceId: string) {
    return prisma.auditLog.findFirstOrThrow({
      where: { action: 'AUTO_RECOVERY_CLOSED', entityId: ticketByDevice.get(deviceId) },
      orderBy: { createdAt: 'desc' },
    });
  }

  it('stamps a CSM acting in a zone with the acting role and that zone', async () => {
    await closeActingAs('csm@fsm.test', DEV_CSM);

    const row = await auditRowFor(DEV_CSM);
    expect(row.actorRole).toBe('CENTRAL_SERVICE_MANAGER');
    expect(row.actedAsRole).toBe('CENTRAL_SERVICE_MANAGER');
    expect(row.actingZone).toBe(zoneId);
  });

  it('stamps an Operations Head acting in the same zone the same way', async () => {
    await closeActingAs('ops.head@fsm.test', DEV_OH);

    const row = await auditRowFor(DEV_OH);
    expect(row.actorRole).toBe('OPERATIONS_HEAD');
    expect(row.actedAsRole).toBe('OPERATIONS_HEAD');
    expect(row.actingZone).toBe(zoneId);
  });

  it('leaves a non-acting write unattributed — the columns still mean "acting"', async () => {
    // The same door, same caller, no header. `acted_as_role` must stay null: if attribution were
    // stamped from the caller's own role rather than from the proven acting context, every row in
    // the table would look like a backup action and the CSM-share report would read 100% everywhere.
    const deviceId = String(9_340_003n);
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
    ticketByDevice.set(deviceId, ticket.ticketId);
    ALL.push(deviceId);

    const token = await login('csm@fsm.test');
    await request(app.getHttpServer())
      .post(`/api/tickets/${ticket.ticketId}/auto-recovery-close`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const row = await auditRowFor(deviceId);
    expect(row.actorRole).toBe('CENTRAL_SERVICE_MANAGER');
    expect(row.actedAsRole).toBeNull();
    expect(row.actingZone).toBeNull();
  });
});
