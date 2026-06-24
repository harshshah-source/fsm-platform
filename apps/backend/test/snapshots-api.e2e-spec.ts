import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 04, slice 7 — the `/api/snapshots/*` HTTP surface (LLD §5.1).
 *
 *  - GET  /api/snapshots/latest — ZM/CSM/OpsHead — data-as-of + latest run status (banner feed).
 *  - GET  /api/snapshots/runs   — OpsHead — paged run history.
 *  - POST /api/snapshots/run    — OpsHead — trigger a run; 409 RUN_IN_PROGRESS if one is in flight.
 *
 * Snapshot tables are wiped per test so the queries are deterministic against the shared local DB.
 */
describe('Issue 04 slice 7 — /api/snapshots', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await prisma.rawDeviceSnapshot.deleteMany({});
    await prisma.snapshotRunChunk.deleteMany({});
    await prisma.snapshotRun.deleteMany({});
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

  it('POST /run triggers a run (Operations Head) and returns a run id', async () => {
    const token = await login('ops.head@fsm.test');

    const res = await request(app.getHttpServer())
      .post('/api/snapshots/run')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.runId).toBeTruthy();
    expect(res.body.status).toBe('SUCCESS'); // placeholder source is empty → clean no-op run
    const count = await prisma.snapshotRun.count();
    expect(count).toBe(1);
  });

  it('POST /run returns 409 RUN_IN_PROGRESS while a run is in flight', async () => {
    const token = await login('ops.head@fsm.test');
    await prisma.snapshotRun.create({ data: { status: 'RUNNING' } });

    const res = await request(app.getHttpServer())
      .post('/api/snapshots/run')
      .set('Authorization', `Bearer ${token}`)
      .expect(409);

    expect(res.body.code).toBe('RUN_IN_PROGRESS');
  });

  it('POST /run is forbidden for a Zonal Manager', async () => {
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .post('/api/snapshots/run')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('GET /latest returns the data-as-of and latest run status to a Zonal Manager', async () => {
    const asOf = new Date(Date.UTC(2026, 5, 19, 8, 0, 0));
    await prisma.snapshotRun.create({
      data: { status: 'SUCCESS', dataAsOf: asOf, finishedAt: new Date() },
    });
    const token = await login('zm.north@fsm.test');

    const res = await request(app.getHttpServer())
      .get('/api/snapshots/latest')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.dataAsOf).toBe(asOf.toISOString());
    expect(res.body.latest.status).toBe('SUCCESS');
  });

  it('GET /runs lists run history for Operations Head and 403s a Zonal Manager', async () => {
    await prisma.snapshotRun.create({ data: { status: 'FAILED', finishedAt: new Date() } });

    const opsToken = await login('ops.head@fsm.test');
    const ok = await request(app.getHttpServer())
      .get('/api/snapshots/runs')
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(200);
    expect(Array.isArray(ok.body)).toBe(true);
    expect(ok.body).toHaveLength(1);
    expect(ok.body[0].status).toBe('FAILED');

    const zmToken = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .get('/api/snapshots/runs')
      .set('Authorization', `Bearer ${zmToken}`)
      .expect(403);
  });

  it('GET /latest requires authentication', async () => {
    await request(app.getHttpServer()).get('/api/snapshots/latest').expect(401);
  });
});
