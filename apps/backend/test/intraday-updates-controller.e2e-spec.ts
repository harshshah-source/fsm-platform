import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * Issue 31 slice 3 — the `/api/intraday-updates` surface, **reduced to its read by #356**.
 *
 * `add` / `remove` / `reorder` are deleted. #313 made `POST /batches/:id/override` the single same-day
 * write surface and no client has called these three since; a live route with zero callers is worse
 * than a missing one, because it looks like a supported way in. It carries its own validation, its own
 * error vocabulary and its own audit action, all of which drift away from the surface that is actually
 * used, and the first caller to find it gets a door that behaves like nobody has walked through it in
 * a year — which is exactly true. The recorded decision (plan §7, "356 deletion") is: delete the three
 * writes and their service methods, keep the GET.
 *
 * The GET is now a bounded page (`{ rows, nextCursor, limit }`) rather than every MANUAL_ZM_UPDATE
 * audit row ever written — see `same-day-update-service.e2e-spec.ts` for the windowing itself.
 */
describe('/api/intraday-updates (e2e)', () => {
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
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-password' }).expect(200);
    return res.body.accessToken as string;
  };

  it('returns the zone-scoped Intra-day Queue page for a manager (200, bounded)', async () => {
    const token = await login('zm.north@fsm.test');
    const res = await request(app.getHttpServer()).get('/api/intraday-updates').set('Authorization', `Bearer ${token}`).expect(200);
    expect(Array.isArray(res.body.rows)).toBe(true);
    expect(res.body.limit).toBe(50);
    expect(res.body.rows.length).toBeLessThanOrEqual(50);
  });

  it('takes the same paging vocabulary as the insertions read', async () => {
    const token = await login('zm.north@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/intraday-updates?take=5')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.limit).toBe(5);
    expect(res.body.rows.length).toBeLessThanOrEqual(5);
    await request(app.getHttpServer())
      .get('/api/intraday-updates?since=not-a-date')
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
  });

  it('forbids an SE from the queue read (403)', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer()).get('/api/intraday-updates').set('Authorization', `Bearer ${token}`).expect(403);
  });

  it('rejects an unauthenticated read (401)', async () => {
    await request(app.getHttpServer()).get('/api/intraday-updates').expect(401);
  });

  /**
   * #356 AC5. Asserted for a **manager**, deliberately: a 403 for an SE would prove nothing about the
   * route being gone, since the role guard would refuse it either way. A ZM is the exact caller these
   * routes were built for, and a 404 for them is the only evidence that the door itself no longer
   * exists.
   */
  it('AC5 — the three retired same-day write routes 404 for the manager they were built for', async () => {
    const token = await login('zm.north@fsm.test');
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);

    await auth(request(app.getHttpServer()).post('/api/intraday-updates/add'))
      .send({ ticketId: '00000000-0000-0000-0000-0000000000aa', seId: '00000000-0000-0000-0000-0000000000bb' })
      .expect(404);
    await auth(request(app.getHttpServer()).post('/api/intraday-updates/remove'))
      .send({ batchId: '1', ticketId: '00000000-0000-0000-0000-0000000000aa', reasonCode: 'WRONG_PLANT' })
      .expect(404);
    await auth(request(app.getHttpServer()).post('/api/intraday-updates/reorder'))
      .send({ batchId: '1', stopSequence: 1, reasonCode: 'RESEQUENCE' })
      .expect(404);
  });
});
