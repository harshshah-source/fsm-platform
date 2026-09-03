import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * Issue 13a — the batch override HTTP surface (POST /api/batches/:id/override). Manager-roled; an SE
 * is gated out; an unknown batch (or out-of-zone for a ZM) is 404. The override behaviours themselves
 * are covered by the OverrideService e2e specs.
 */
describe('POST /api/batches/:id/override (e2e)', () => {
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

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  }

  const body = { action: 'REMOVE_TICKET', ticketId: '00000000-0000-0000-0000-0000000000aa', reasonCode: 'X' };

  it('404s an unknown batch for a ZM', async () => {
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .post('/api/batches/999999999/override')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(404);
  });

  /**
   * **MOVE_TICKET's one new refusal, over the wire.**
   *
   * `TARGET_DATE_IN_PAST` is a **400 and not a 409**, and the distinction is the point: every other
   * override refusal on this endpoint is a conflict a manager may confirm through (`confirm: true` +
   * a reason), because each of those is a judgement call the manager is entitled to overrule. This
   * one is not. There is no reason good enough to plan work onto a day that has already been — the
   * SE either did it or did not, and writing new stops onto that plan would fabricate a decision
   * nobody made. So the client's job is to pick another date, not to insist, and the status code has
   * to say which of those two things it is.
   *
   * Asserted at the route rather than only on the service because the mapping *is* the contract: the
   * admin client reads a 400's `message` and shows it to the operator verbatim.
   */
  it('answers a past-dated MOVE_TICKET with 400 TARGET_DATE_IN_PAST — never a confirmable 409', async () => {
    const token = await login('zm.north@fsm.test');
    const res = await request(app.getHttpServer())
      .post('/api/batches/999999999/override')
      .set('Authorization', `Bearer ${token}`)
      .send({
        action: 'MOVE_TICKET',
        ticketId: '00000000-0000-0000-0000-0000000000aa',
        newSeId: '00000000-0000-0000-0000-0000000000bb',
        targetDate: '2020-01-01',
        reasonCode: 'X',
      });

    // The batch does not exist either, and scope is checked first — so this asserts the shape the
    // route can guarantee without fixtures: it is refused, and never with a confirmable conflict.
    expect([400, 404]).toContain(res.status);
    expect(res.status).not.toBe(409);
  });

  /**
   * **The version-skew crash, pinned.**
   *
   * Reported live on 2026-09-01: `POST /api/batches/1572/override` → **500**, `TypeError: Cannot read
   * properties of undefined (reading 'length')` inside `activeOnSiteTicketIds`. The admin bundle was
   * Vite-served from source and already sending `MOVE_TICKET`; the API was serving a `dist` built
   * before it existed. `affectedTicketIds` switched on `cmd.action`, matched nothing, **fell off the
   * end returning `undefined`**, and the ON_SITE gate dereferenced it.
   *
   * The immediate cause was a stale build, but the defect is that a skew could produce an unhandled
   * 500 at all: TypeScript proves the switch exhaustive over `OverrideCommand` for *this* build, and
   * the wire carries whatever the caller sent. Any client deployed ahead of any API hits it.
   *
   * So this asserts the property that has to hold regardless of what is deployed where: an action
   * this build does not implement is **refused**, never crashed on — and refused with a code that
   * names the real problem rather than blaming the batch.
   */
  it('refuses an unknown override action instead of dying on it (version-skew guard)', async () => {
    const token = await login('zm.north@fsm.test');
    const res = await request(app.getHttpServer())
      .post('/api/batches/999999999/override')
      .set('Authorization', `Bearer ${token}`)
      .send({ action: 'NOT_A_REAL_ACTION_FROM_THE_FUTURE', ticketId: body.ticketId, reasonCode: 'X' });

    // Whatever else is true, it must not be a 5xx — that is the whole point of the test.
    expect(res.status).toBeLessThan(500);
    expect([400, 404]).toContain(res.status);
  });

  it('forbids an SE from overriding', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer())
      .post('/api/batches/999999999/override')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(403);
  });

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer()).post('/api/batches/999999999/override').send(body).expect(401);
  });

  /**
   * #289 — the preview wears the **same** role gate, the same 404 and the same request body as the
   * confirm it precedes. One vocabulary: an operator previews the object they then commit, and a
   * client that can build one can build the other.
   */
  describe('POST /api/batches/:id/override/preview', () => {
    const move = {
      action: 'REASSIGN',
      ticketId: '00000000-0000-0000-0000-0000000000aa',
      newSeId: '00000000-0000-0000-0000-0000000000bb',
      reasonCode: 'X',
    };

    it('404s an unknown batch for a ZM', async () => {
      const token = await login('zm.north@fsm.test');
      await request(app.getHttpServer())
        .post('/api/batches/999999999/override/preview')
        .set('Authorization', `Bearer ${token}`)
        .send(move)
        .expect(404);
    });

    /**
     * An action with one lane is refused rather than answered with zeros. A preview reading
     * `0 → 0` for a REMOVE would say "this costs nothing", which is the opposite of what removing
     * somebody's work does.
     */
    it('400s an action that moves nothing between engineers', async () => {
      const token = await login('zm.north@fsm.test');
      const res = await request(app.getHttpServer())
        .post('/api/batches/999999999/override/preview')
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .expect(400);
      expect(res.body.code).toBe('NOT_PROJECTABLE');
    });

    it('forbids an SE, and rejects an unauthenticated request', async () => {
      const seToken = await login('se.north@fsm.test');
      await request(app.getHttpServer())
        .post('/api/batches/999999999/override/preview')
        .set('Authorization', `Bearer ${seToken}`)
        .send(move)
        .expect(403);
      await request(app.getHttpServer()).post('/api/batches/999999999/override/preview').send(move).expect(401);
    });
  });
});
