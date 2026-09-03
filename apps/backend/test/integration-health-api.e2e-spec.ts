import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Phase 4/8 — `GET /api/integration/health` HTTP surface (blueprint §9). Verifies the controller +
 * guard chain end-to-end: Operations Head gets the health JSON; a Zonal Manager is forbidden; an
 * anonymous caller is unauthorized. In the test env AutoPlant is unconfigured, so `source.connected`
 * is false without any VPN — the endpoint still answers (freshness from the FSM run tables).
 */
describe('Phase 4 — GET /api/integration/health', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  };

  it('returns the integration health to Operations Head', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/integration/health')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.source).toMatchObject({ configured: false, connected: false });
    expect(res.body).toHaveProperty('masterSync');
    expect(res.body).toHaveProperty('snapshot');
    expect(res.body).toHaveProperty('checkedAt');
  });

  it('forbids a Zonal Manager', async () => {
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .get('/api/integration/health')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('rejects an anonymous caller', async () => {
    await request(app.getHttpServer()).get('/api/integration/health').expect(401);
  });
});

/**
 * #349 — the payload contract the Integration Health page renders.
 *
 * The gap this pins is not a missing computation: `source`, the two freshness ages, `reconciliation`
 * and `lifecycle` were all being computed and returned, and the page threw four fifths of it away.
 * These cases hold the wire shape still so the sections cannot be dropped again silently — an
 * assertion the old spec could not make, because it only checked that three keys existed.
 *
 * The one thing that genuinely was NOT on the payload is the per-run departure churn (#129's
 * health-page AC): `entity_stats.departures` records what each master sync opened and closed, and
 * `device_departures.cancelled_tickets_count` records the work those departures auto-closed, and
 * neither was ever read back out. Both are derived here, per run.
 */
describe('#349 — integration health carries every section the page renders', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const NS = Date.now() % 100_000;
  const DEVICES = [`RR_D349A${NS}`, `RR_D349B${NS}`];
  const VEHICLE = `ZZ349${NS}`;
  const runIds: bigint[] = [];
  let companyId: bigint;
  let plantId: bigint;
  let zoneId: bigint;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    zoneId = (await prisma.zone.create({ data: { name: `Z349_${NS}_${Date.now()}` } })).zoneId;
    companyId = (
      await prisma.company.create({
        data: { name: `Health Co ${NS}`, companyTier: 'SILVER', companyPriorityRank: 'P3' },
      })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: `Health Plant ${NS}`, zoneId } })).plantId;
    const vehicle = await prisma.vehicle.create({
      data: { vehicleNo: VEHICLE, plantId, companyId, status: 'UNDEPLOYED' },
    });
    for (const deviceId of DEVICES) {
      await prisma.device.create({ data: { deviceId, currentVehicleId: vehicle.vehicleId } });
    }
  });

  afterAll(async () => {
    await prisma.deviceDeparture.deleteMany({ where: { deviceId: { in: DEVICES } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: DEVICES } } });
    await prisma.vehicle.deleteMany({ where: { vehicleNo: VEHICLE } });
    if (runIds.length > 0) await prisma.masterSyncRun.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await app.close();
  });

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  };

  const health = async (): Promise<Record<string, any>> => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/integration/health')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return res.body as Record<string, any>;
  };

  it('AC1 — connectivity, both freshness ages with their staleness yardstick, and lifecycle', async () => {
    const body = await health();

    // Connectivity: the section that told an operator whether the VPN is up, and was never rendered.
    expect(body.source).toMatchObject({ configured: expect.any(Boolean), connected: expect.any(Boolean) });

    // Freshness: the age AND the threshold it is judged against (#348). An age with no yardstick is
    // what let a 21-hour-old snapshot read as an ordinary timestamp.
    for (const feed of ['masterSync', 'snapshot']) {
      expect(body[feed]).toMatchObject({
        staleAfterMinutes: expect.any(Number),
        stale: expect.any(Boolean),
      });
      expect(body[feed]).toHaveProperty('lastAt');
      expect(body[feed]).toHaveProperty('ageMinutes');
      expect(body[feed]).toHaveProperty('lastStatus');
    }

    // Lifecycle (#218/#224): drift is a contradiction, missingFromSource is the excluded population
    // beside it, quietRuns is the pass reporting that it did nothing.
    expect(body.lifecycle).toMatchObject({
      drift: expect.any(Number),
      missingFromSource: expect.any(Number),
      quietRuns: expect.any(Number),
      quietRunsAlert: expect.any(Boolean),
      quietRunsThreshold: expect.any(Number),
      healthy: expect.any(Boolean),
    });

    expect(body).toHaveProperty('reconciliation');
    expect(body).toHaveProperty('schedulerEnabled');
    expect(body).toHaveProperty('checkedAt');
  });

  it('AC3 — reports departures, restores and departure-auto-closed tickets per master-sync run', async () => {
    const run = await prisma.masterSyncRun.create({
      data: {
        status: 'SUCCESS',
        finishedAt: new Date(),
        entityStats: { departures: { inserted: 2, updated: 1, skipped: 0 } },
      },
    });
    runIds.push(run.runId);

    // The auto-closed work: two devices left the fleet on this run, taking their open tickets with
    // them. `cancelled_tickets_count` is the only record that it happened and nothing read it.
    await prisma.deviceDeparture.create({
      data: {
        deviceId: DEVICES[0],
        observedStatus: 'UNDEPLOYED',
        reason: 'SOURCE_STATUS',
        detectedByRunId: run.runId,
        cancelledTicketsCount: 3,
      },
    });
    await prisma.deviceDeparture.create({
      data: {
        deviceId: DEVICES[1],
        observedStatus: 'MISSING_FROM_SOURCE',
        reason: 'ABSENT_FROM_READ',
        detectedByRunId: run.runId,
        cancelledTicketsCount: 4,
      },
    });

    const body = await health();
    const newest = (body.lifecycle.runs as Array<Record<string, any>>)[0];

    expect(newest.runId).toBe(run.runId.toString());
    expect(newest.departed).toBe(2);
    expect(newest.restored).toBe(1);
    expect(newest.ticketsAutoClosed).toBe(7);
    expect(newest.quiet).toBe(false);
  });

  it('AC3 — a run whose lifecycle pass moved nothing is reported as quiet, not omitted', async () => {
    const run = await prisma.masterSyncRun.create({
      data: {
        status: 'SUCCESS',
        finishedAt: new Date(),
        entityStats: { departures: { inserted: 0, updated: 0, skipped: 0 } },
      },
    });
    runIds.push(run.runId);

    const body = await health();
    const newest = (body.lifecycle.runs as Array<Record<string, any>>)[0];

    // The #218 failure, per run: a run that says it did nothing is the signal, so it must appear.
    expect(newest.runId).toBe(run.runId.toString());
    expect(newest.departed).toBe(0);
    expect(newest.restored).toBe(0);
    expect(newest.ticketsAutoClosed).toBe(0);
    expect(newest.quiet).toBe(true);
  });
});
