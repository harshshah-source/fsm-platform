import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * **#291 — the Zonal-Manager widening of `dispatch-run`, and the clamp that makes it safe.**
 *
 * `POST /api/schedules/dispatch-run` read its zone straight off the request body and never compared it
 * to the caller. That was safe only while every permitted role was global-scope. #291 widens the role
 * list to `ZONAL_MANAGER`, so the clamp is now the only thing standing between a ZM and every zone in
 * the country — and these are the tests that say so.
 *
 * **The clamp ignores the body rather than validating it**, and the second test is the one that
 * distinguishes the two. A validating clamp (403 on mismatch) would pass that test's *first* case and
 * fail its second: a client that simply stops sending `zoneId` falls through to the pan-India path.
 * Asserting "runs the caller's own zone" in **both** cases is what pins the safe construction rather
 * than a safe-looking one.
 */
describe('#291 — dispatch-run is clamped to the caller’s zone', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let northZoneId: number;
  let southZoneId: number;

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  };

  /** The run summary names how many zones it touched; one zone is the clamp holding. */
  const runAs = async (token: string, body?: Record<string, unknown>) => {
    const req = request(app.getHttpServer())
      .post('/api/schedules/dispatch-run')
      .set('Authorization', `Bearer ${token}`);
    const res = await (body ? req.send(body) : req).expect(200);
    return res.body as { zones: number; runId?: string };
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    const north = await prisma.zone.findFirst({ where: { name: 'North' }, select: { zoneId: true } });
    const south = await prisma.zone.findFirst({ where: { name: 'South' }, select: { zoneId: true } });
    northZoneId = Number(north!.zoneId);
    southZoneId = Number(south!.zoneId);
  });

  afterAll(async () => {
    await app.close();
  });

  it('lets a Zonal Manager trigger a run at all — the widening', async () => {
    const token = await login('zm.north@fsm.test');
    const summary = await runAs(token, { reason: 'console run now' });
    expect(summary.zones).toBe(1);
  });

  /**
   * The two halves of "ignore, not validate", in one test because they are one property: **no request a
   * ZM can compose reaches another zone or reaches all of them.**
   */
  it('runs the caller’s own zone whether the body names another zone or names none', async () => {
    const token = await login('zm.north@fsm.test');

    // (a) naming another zone is ignored, not obeyed and not 403'd
    const named = await runAs(token, { zoneId: southZoneId });
    expect(named.zones).toBe(1);

    // (b) naming nothing does NOT fall through to pan-India — the trap a validating clamp leaves open
    const unnamed = await runAs(token);
    expect(unnamed.zones).toBe(1);

    // Both ran the ZM's own zone. Read it back off the ledger rather than trusting the count: "1 zone"
    // would also be true if the clamp had picked the wrong single zone.
    const runs = await prisma.dispatchRun.findMany({
      where: { trigger: 'MANUAL', actorRole: 'ZONAL_MANAGER' },
      orderBy: { runId: 'desc' },
      take: 2,
      select: { runId: true },
    });
    const zones = await prisma.dispatchRunZone.findMany({
      where: { runId: { in: runs.map((r) => r.runId) } },
      select: { zoneId: true },
    });
    expect(zones.length).toBeGreaterThan(0);
    for (const z of zones) expect(Number(z.zoneId)).toBe(northZoneId);
  });

  it('leaves the pan-India path intact for a non-acting Operations Head', async () => {
    const token = await login('ops.head@fsm.test');
    const summary = await runAs(token);
    // Compared against the engine's own definition of "every active zone" (one distinct zone per
    // plant) rather than a hard-coded `> 1`: a fixture database with a single active zone would make
    // that assertion vacuous and would pass even if the OH had been clamped by mistake.
    const active = await prisma.plant.findMany({ distinct: ['zoneId'], select: { zoneId: true } });
    expect(summary.zones).toBe(active.length);
  });

  it('still narrows an Operations Head to a named zone', async () => {
    const token = await login('ops.head@fsm.test');
    const summary = await runAs(token, { zoneId: northZoneId });
    expect(summary.zones).toBe(1);
  });

  /**
   * Part 3 of the four-part change. A guard that answers "which zones are busy" globally leaks the
   * national run schedule through a control whose only job is to grey out one button — and would grey
   * it out for a run in a zone the ZM cannot act on.
   */
  it('scopes the in-flight guard to the caller’s zone for a ZM, and leaves it global for an OH', async () => {
    const zmToken = await login('zm.north@fsm.test');
    const ohToken = await login('ops.head@fsm.test');

    const zmRes = await request(app.getHttpServer())
      .get('/api/schedules/dispatch-run/in-flight')
      .set('Authorization', `Bearer ${zmToken}`)
      .expect(200);
    for (const row of zmRes.body.inFlight as { zoneId: string }[]) {
      expect(Number(row.zoneId)).toBe(northZoneId);
    }

    // The OH read must still be answerable at all (shape, not contents — nothing need be in flight).
    const ohRes = await request(app.getHttpServer())
      .get('/api/schedules/dispatch-run/in-flight')
      .set('Authorization', `Bearer ${ohToken}`)
      .expect(200);
    expect(Array.isArray(ohRes.body.inFlight)).toBe(true);
  });

  it('still forbids a Service Engineer — the widening is to managers, not to everyone', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer())
      .post('/api/schedules/dispatch-run')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });
});
