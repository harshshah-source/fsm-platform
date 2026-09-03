import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issues 29/30, retired to direct-assignment by #268 — the `/api/intraday-insertions/*` HTTP surface
 * (RBAC + routing + input validation). The direct-assign/escalation behaviour itself is covered by the
 * `IntradayInsertionService` e2e spec. `accept`/`decline`/`sweep-timeouts` are retired with the offer
 * machinery they served and must 404 (#268 AC: "retired endpoints return 404").
 *
 * **#356** adds the queue read's bound. `GET` used to return every insertion ever written in scope —
 * 552 rows for one ZM on the day the survey looked, growing forever, and slowest on exactly the busy
 * afternoon a dispatcher most needs it. It is now a page: `{ rows, nextCursor, limit }`, newest first,
 * default 50, filterable by `status` and `since`, walked by an opaque `cursor`. The envelope is a
 * breaking change to the response shape and deliberately so — an array cannot say "there is more",
 * and a truncated array that does not say it has been truncated is worse than the unbounded read it
 * replaces.
 */
describe('/api/intraday-insertions (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  /** The seeded North ZM's zone, and one ticket built in it to hang synthetic ledger rows off. */
  let zoneId: bigint;
  let ticketId: string;
  let deviceId: string;
  const insertionIds: bigint[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    const zm = await prisma.user.findFirstOrThrow({ where: { email: 'zm.north@fsm.test' } });
    zoneId = zm.zoneId!;

    // Built rather than borrowed: the North zone's seeded ticket set is not guaranteed to be
    // non-empty, and a fixture that depends on what the seed happens to leave behind fails for a
    // reason that has nothing to do with the thing under test.
    const plant = await prisma.plant.findFirstOrThrow({ where: { zoneId } });
    const company = await prisma.company.findFirstOrThrow();
    deviceId = String(12_356_000_000 + (Date.now() % 1_000_000));
    await prisma.device.create({ data: { deviceId } });
    const cycle = await prisma.failureCycle.create({
      data: { deviceId, state: 'OPEN', openedAt: new Date('2030-07-01T00:00:00.000Z') },
    });
    ticketId = (
      await prisma.ticket.create({
        data: {
          workType: 'TROUBLESHOOT',
          status: 'OPEN',
          failureCycleId: cycle.cycleId,
          deviceId,
          plantId: plant.plantId,
          companyId: company.companyId,
          companyTier: 'GOLD',
          lastStateChangedAt: new Date('2030-07-01T00:00:00.000Z'),
        },
      })
    ).ticketId;
  });

  afterAll(async () => {
    await prisma.intradayInsertion.deleteMany({ where: { insertionId: { in: insertionIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId } });
    await prisma.ticket.deleteMany({ where: { ticketId } });
    await prisma.failureCycle.deleteMany({ where: { deviceId } });
    await prisma.device.deleteMany({ where: { deviceId } });
    await app.close();
  });

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  }

  /** One synthetic ledger row. `createdAt` is set explicitly so `since` has something to bite on. */
  async function seedInsertion(status: 'ASSIGNED_DIRECT' | 'ESCALATION_REQUIRED', createdAt: Date): Promise<bigint> {
    const row = await prisma.intradayInsertion.create({
      data: {
        ticketId,
        zoneId,
        insertionType: 'SYSTEM_CRITICAL',
        slaBucket: 'CRITICAL',
        offeredSeId: null,
        offeredAt: createdAt,
        acceptanceDeadline: null,
        respondedAt: createdAt,
        status,
        createdAt,
      },
    });
    insertionIds.push(row.insertionId);
    return row.insertionId;
  }

  const get = (token: string, qs = '') =>
    request(app.getHttpServer()).get(`/api/intraday-insertions${qs}`).set('Authorization', `Bearer ${token}`);

  it('lets a ZM read the zone-scoped Intra-day Queue', async () => {
    const token = await login('zm.north@fsm.test');
    const res = await get(token).expect(200);
    expect(Array.isArray(res.body.rows)).toBe(true);
    expect(res.body.limit).toBe(50);
  });

  it('forbids an SE from reading the manager queue', async () => {
    const token = await login('se.north@fsm.test');
    await get(token).expect(403);
  });

  it('forbids an SE from triggering the manual sweep (manager-only)', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer())
      .post('/api/intraday-insertions/fire')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('lets a ZM trigger the manual sweep for their own zone with no body', async () => {
    const token = await login('zm.north@fsm.test');
    const res = await request(app.getHttpServer())
      .post('/api/intraday-insertions/fire')
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(200);
    expect(res.body).toEqual({ assigned: expect.any(Number), escalated: expect.any(Number) });
  });

  it('404s the retired accept endpoint — the offer machinery it served is gone', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer())
      .post('/api/intraday-insertions/999999999/accept')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('404s the retired decline endpoint', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer())
      .post('/api/intraday-insertions/999999999/decline')
      .set('Authorization', `Bearer ${token}`)
      .send({ reasonCode: 'AT_CAPACITY' })
      .expect(404);
  });

  it('404s the retired sweep-timeouts endpoint', async () => {
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .post('/api/intraday-insertions/sweep-timeouts')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('404s the retired /me/intraday-insertions endpoint — the SE never had an offer to poll for', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer())
      .get('/api/me/intraday-insertions')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer()).get('/api/intraday-insertions').expect(401);
  });

  describe('#356 — the read is a bounded, filterable, cursor-paged window', () => {
    const BASE = new Date('2030-07-01T04:00:00.000Z');
    let token: string;

    beforeAll(async () => {
      token = await login('zm.north@fsm.test');
      // 60 rows — one more than a default page can hold, so "bounded" is observable.
      for (let i = 0; i < 60; i++) {
        await seedInsertion(i % 2 === 0 ? 'ASSIGNED_DIRECT' : 'ESCALATION_REQUIRED', new Date(BASE.getTime() + i * 60_000));
      }
    });

    it('AC1 — defaults to 50 rows, newest first, and reports the next cursor', async () => {
      const res = await get(token, '?since=2030-01-01T00:00:00.000Z').expect(200);
      expect(res.body.limit).toBe(50);
      expect(res.body.rows).toHaveLength(50);
      const times = res.body.rows.map((r: { createdAt: string }) => r.createdAt);
      expect([...times].sort().reverse()).toEqual(times);
      expect(res.body.nextCursor).toEqual(expect.any(String));
    });

    it('AC1 — `take` is honoured, and a caller cannot raise the ceiling', async () => {
      const small = await get(token, '?take=5&since=2030-01-01T00:00:00.000Z').expect(200);
      expect(small.body.rows).toHaveLength(5);
      expect(small.body.limit).toBe(5);
      const huge = await get(token, '?take=99999&since=2030-01-01T00:00:00.000Z').expect(200);
      expect(huge.body.limit).toBe(200);
      // 60 synthetic rows exist, so the ceiling is not what bounds this page — exhaustion is.
      expect(huge.body.rows).toHaveLength(60);
      expect(huge.body.nextCursor).toBeNull();
    });

    it('AC1 — the cursor walks the window without repeating a row', async () => {
      const first = await get(token, '?take=40&since=2030-01-01T00:00:00.000Z').expect(200);
      const second = await get(
        token,
        `?take=40&since=2030-01-01T00:00:00.000Z&cursor=${first.body.nextCursor}`,
      ).expect(200);
      const ids = [
        ...first.body.rows.map((r: { insertionId: string }) => r.insertionId),
        ...second.body.rows.map((r: { insertionId: string }) => r.insertionId),
      ];
      expect(new Set(ids).size).toBe(ids.length);
      expect(second.body.rows).toHaveLength(20);
      expect(second.body.nextCursor).toBeNull();
    });

    it('AC1 — `status` filters the window', async () => {
      const res = await get(token, '?status=ESCALATION_REQUIRED&since=2030-01-01T00:00:00.000Z').expect(200);
      expect(res.body.rows.length).toBeGreaterThan(0);
      expect(res.body.rows.every((r: { status: string }) => r.status === 'ESCALATION_REQUIRED')).toBe(true);
    });

    it('AC1 — `since` filters by date', async () => {
      const since = new Date(BASE.getTime() + 55 * 60_000).toISOString();
      const res = await get(token, `?since=${since}`).expect(200);
      expect(res.body.rows).toHaveLength(5);
      expect(res.body.rows.every((r: { createdAt: string }) => r.createdAt >= since)).toBe(true);
    });

    it('400s a malformed query rather than silently ignoring it', async () => {
      await get(token, '?since=not-a-date').expect(400);
      await get(token, '?cursor=not-a-number').expect(400);
      await get(token, '?status=NOT_A_STATUS').expect(400);
    });
  });
});
