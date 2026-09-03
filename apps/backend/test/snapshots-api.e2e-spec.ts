import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { ORPHANED_RUN_ERROR } from '../src/ingestion/stale-run';
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

  /**
   * #343 AC1 — a manual run is a person deciding to re-read the fleet out of band, and `snapshot_runs`
   * records only that a run happened, never who asked for it. The row is keyed on the run so the
   * trigger and its outcome can be joined; `trigger: 'manual'` is what separates it from the cron,
   * which produces identical run rows and no audit row at all.
   */
  it('POST /run writes a SNAPSHOT_RUN_TRIGGERED audit row keyed on the run it started', async () => {
    const token = await login('ops.head@fsm.test');

    const res = await request(app.getHttpServer())
      .post('/api/snapshots/run')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const rows = await prisma.auditLog.findMany({
      where: { entityType: 'snapshot_runs', entityId: String(res.body.runId) },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('SNAPSHOT_RUN_TRIGGERED');
    expect(rows[0].actorRole).toBe('OPERATIONS_HEAD');
    expect(rows[0].metadata).toMatchObject({ trigger: 'manual', status: res.body.status });

    await prisma.auditLog.deleteMany({ where: { entityType: 'snapshot_runs', entityId: String(res.body.runId) } });
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

/**
 * #348 — the three gaps the freshness surface had, at the HTTP edge.
 *
 * 1. `/latest` was ZM/CSM/OH only, so the global banner 403'd for a Warehouse Manager and a Service
 *    Engineer — and swallowed it, which is why nobody noticed. Those two roles never saw freshness.
 * 2. The payload carried no verdict about the AGE of `dataAsOf`; a 21-hour-old snapshot came back
 *    looking exactly like a two-minute-old one, because no age threshold existed anywhere.
 * 3. A run the heartbeat reaper closed appeared in `/runs` as a bare FAILED with no reason, so a
 *    process restart and a real ingestion failure were the same row.
 */
describe('#348 — role-safe freshness, silence, and the reaped-run reason', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const SCHEDULER_FLAG = 'INGESTION_SCHEDULER_ENABLED';
  let originalFlag: string | undefined;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
    originalFlag = process.env[SCHEDULER_FLAG];
  });

  beforeEach(async () => {
    await prisma.rawDeviceSnapshot.deleteMany({});
    await prisma.snapshotRunChunk.deleteMany({});
    await prisma.snapshotRun.deleteMany({});
  });

  afterEach(() => {
    if (originalFlag === undefined) delete process.env[SCHEDULER_FLAG];
    else process.env[SCHEDULER_FLAG] = originalFlag;
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

  const latestAs = async (email: string): Promise<Record<string, unknown>> => {
    const token = await login(email);
    const res = await request(app.getHttpServer())
      .get('/api/snapshots/latest')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return res.body as Record<string, unknown>;
  };

  /** A finished SUCCESS run whose data landed `minutesAgo` minutes back. */
  const seedSuccess = async (minutesAgo: number): Promise<void> => {
    const at = new Date(Date.now() - minutesAgo * 60_000);
    await prisma.snapshotRun.create({ data: { status: 'SUCCESS', dataAsOf: at, finishedAt: at, startedAt: at } });
  };

  it('AC3 — a Warehouse Manager gets the banner feed', async () => {
    await seedSuccess(2);
    const body = await latestAs('wm@fsm.test');
    expect(body.dataAsOf).toBeTruthy();
  });

  it('AC3 — a Service Engineer gets the banner feed', async () => {
    // The role furthest from a screen that would otherwise tell them the fleet view is a day old.
    await seedSuccess(2);
    const body = await latestAs('se.north@fsm.test');
    expect(body.dataAsOf).toBeTruthy();
  });

  it('AC3 — and the roles that already had it still do', async () => {
    await seedSuccess(2);
    expect((await latestAs('zm.north@fsm.test')).dataAsOf).toBeTruthy();
    expect((await latestAs('csm@fsm.test')).dataAsOf).toBeTruthy();
    expect((await latestAs('ops.head@fsm.test')).dataAsOf).toBeTruthy();
  });

  it('AC3 — widening the role list did not make it public', async () => {
    await request(app.getHttpServer()).get('/api/snapshots/latest').expect(401);
  });

  it('AC1 — a snapshot older than 2x the cadence comes back overdue', async () => {
    process.env[SCHEDULER_FLAG] = 'true';
    // 21 hours: the case the survey found reading as healthy, because nothing compared the age to
    // anything at all. At the shipped 30-minute cadence the threshold is 60 minutes.
    await seedSuccess(21 * 60);

    const body = await latestAs('zm.north@fsm.test');

    expect(body.overdue).toBe(true);
    expect(body.schedulerPaused).toBe(false);
    expect((body.ingestion as Record<string, unknown>).silenceMinutes).toBe(21 * 60);
  });

  it('AC1 — every role is told, not just the ones that used to have the route', async () => {
    process.env[SCHEDULER_FLAG] = 'true';
    await seedSuccess(21 * 60);

    for (const email of ['wm@fsm.test', 'se.north@fsm.test', 'zm.north@fsm.test', 'ops.head@fsm.test']) {
      expect((await latestAs(email)).overdue).toBe(true);
    }
  });

  it('AC1 — zero runs at all is overdue, not healthy', async () => {
    process.env[SCHEDULER_FLAG] = 'true';
    // The exact silence case: no run means no non-SUCCESS run, so every streak rule scores clean.
    const body = await latestAs('zm.north@fsm.test');

    expect(body.overdue).toBe(true);
    expect(body.dataAsOf).toBeNull();
    expect((body.ingestion as Record<string, unknown>).streak).toBe(0);
  });

  it('a recent snapshot is not overdue', async () => {
    process.env[SCHEDULER_FLAG] = 'true';
    await seedSuccess(5);

    const body = await latestAs('zm.north@fsm.test');
    expect(body.overdue).toBe(false);
    expect((body.ingestion as Record<string, unknown>).alert).toBe(false);
  });

  it('AC4 — a deliberately disabled scheduler is paused, never overdue', async () => {
    process.env[SCHEDULER_FLAG] = 'false';
    await seedSuccess(21 * 60);

    const body = await latestAs('zm.north@fsm.test');

    expect(body.schedulerPaused).toBe(true);
    expect(body.overdue).toBe(false);
    expect((body.ingestion as Record<string, unknown>).alert).toBe(false);
    // Paused is not fresh: the age is still on the payload for the banner to state.
    expect((body.ingestion as Record<string, unknown>).silenceMinutes).toBe(21 * 60);
  });

  it('AC2 — a reaped run records ORPHANED_RUN_ERROR in the run history', async () => {
    // A run whose process died: RUNNING, with a heartbeat well past the stale threshold. The reaper
    // fires inside `startRun`, so triggering the next run is what closes it — exactly the production
    // path, not a direct call to the reaper.
    const dead = new Date(Date.now() - 90 * 60_000);
    const orphan = await prisma.snapshotRun.create({
      data: { status: 'RUNNING', startedAt: dead, heartbeatAt: dead },
    });

    const opsToken = await login('ops.head@fsm.test');
    await request(app.getHttpServer())
      .post('/api/snapshots/run')
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(200);

    const runs = await request(app.getHttpServer())
      .get('/api/snapshots/runs')
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(200);

    const reaped = (runs.body as Array<Record<string, unknown>>).find((r) => r.runId === orphan.runId.toString());
    expect(reaped?.status).toBe('FAILED');
    expect(reaped?.error).toBe(ORPHANED_RUN_ERROR);
  });

  /**
   * #349 AC2 — `GET /snapshots/runs` had no consumer at all, so nothing ever exercised the paging
   * and status-filter arguments it has always accepted. The health page's run-history table is that
   * consumer; these two cases pin the contract it pages and filters against, so the table cannot be
   * built on arguments that quietly do nothing.
   */
  it('#349 AC2 — /runs pages with limit + offset, newest first', async () => {
    const base = Date.now() - 10 * 60_000;
    for (let i = 0; i < 3; i++) {
      const at = new Date(base + i * 60_000);
      await prisma.snapshotRun.create({ data: { status: 'SUCCESS', startedAt: at, finishedAt: at, dataAsOf: at } });
    }
    const token = await login('ops.head@fsm.test');

    const page1 = await request(app.getHttpServer())
      .get('/api/snapshots/runs?limit=2&offset=0')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const page2 = await request(app.getHttpServer())
      .get('/api/snapshots/runs?limit=2&offset=2')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(page1.body).toHaveLength(2);
    expect(page2.body).toHaveLength(1);
    // Newest first, and the pages do not overlap — the two properties a prev/next pager needs.
    const ids = [...page1.body, ...page2.body].map((r: { runId: string }) => r.runId);
    expect(new Set(ids).size).toBe(3);
    expect(Number(ids[0])).toBeGreaterThan(Number(ids[2]));
  });

  it('#349 AC2 — /runs filters by status and ignores a status that is not one', async () => {
    const now = new Date();
    await prisma.snapshotRun.create({ data: { status: 'SUCCESS', startedAt: now, finishedAt: now } });
    await prisma.snapshotRun.create({ data: { status: 'FAILED', startedAt: now, finishedAt: now } });
    const token = await login('ops.head@fsm.test');

    const failed = await request(app.getHttpServer())
      .get('/api/snapshots/runs?status=FAILED')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(failed.body).toHaveLength(1);
    expect(failed.body[0].status).toBe('FAILED');

    // A junk filter must widen to everything rather than 500 or return nothing — the table's
    // "All statuses" option sends no status at all, but a stale bookmark can send anything.
    const junk = await request(app.getHttpServer())
      .get('/api/snapshots/runs?status=NOPE')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(junk.body).toHaveLength(2);
  });

  it('AC2 — a run that ended on its own carries no reason, so the marker means something', async () => {
    const opsToken = await login('ops.head@fsm.test');
    await request(app.getHttpServer())
      .post('/api/snapshots/run')
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(200);

    const runs = await request(app.getHttpServer())
      .get('/api/snapshots/runs')
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(200);

    expect((runs.body as Array<Record<string, unknown>>)[0].error).toBeNull();
  });
});
