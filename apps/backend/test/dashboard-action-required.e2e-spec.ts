import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * Issue 06, slice 4 — `/api/dashboard/action-required` (AC#1, AC#6).
 *
 * The urgency-ordered Action Required card contract. Each card's data source is its own issue
 * (batches→11, readiness→28, insertions→29, verification→18/19, component-blocked→21,
 * waiting-component→22, non-op→35, manual-assign→30); an unwired one is a graceful stub
 * (`available:false`, `count:0`) and its owning issue flips it on.
 *
 * **The stub flag is the contract, not a placeholder.** `available:false` says *"no source is wired"*,
 * which is a different statement from `count:0` meaning *"no work"* — and the Scheduler Console's
 * attention band renders them differently for exactly that reason.
 *
 * Four are wired: `waiting_component_overdue` (Issue 23), `recovery_stalled` (Issue 37), and — since
 * Console Phase 3 / B6 — `vehicle_unavailability` and `failed_verification`, each one `COUNT(*)` over
 * data that already ships and already renders on its own page.
 */
describe('Issue 06 slice 4 — /api/dashboard/action-required', () => {
  let app: INestApplication;

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns urgency-ordered cards, each a graceful stub for now', async () => {
    const token = await login('zm.north@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/dashboard/action-required')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const cards = res.body as Array<{
      key: string;
      label: string;
      urgency: number;
      count: number;
      available: boolean;
    }>;
    expect(cards.length).toBeGreaterThanOrEqual(8);
    // urgency is strictly ascending (1 = most urgent first).
    for (let i = 1; i < cards.length; i++) {
      expect(cards[i].urgency).toBeGreaterThan(cards[i - 1].urgency);
    }
    // Sources whose owning issue hasn't landed are still graceful stubs. `waiting_component_overdue`
    // (Issue 23) and `recovery_stalled` (Issue 37) are wired: available, with a count ≥ 0.
    const wired = new Set([
      'waiting_component_overdue',
      'recovery_stalled',
      // B6 — lit by Console Phase 3 from data that already ships.
      'vehicle_unavailability',
      'failed_verification',
    ]);
    for (const c of cards) {
      if (wired.has(c.key)) {
        expect(c.available).toBe(true);
        expect(c.count).toBeGreaterThanOrEqual(0);
      } else {
        expect(c.available).toBe(false);
        expect(c.count).toBe(0);
      }
    }
    expect(cards.map((c) => c.key)).toContain('vehicle_unavailability');
    expect(cards.map((c) => c.key)).toContain('non_op_awaiting_manager');
  });

  /**
   * **B5 — `?zoneId=` is a correctness fix.** These counts are global for a CSM/OH, which was right
   * on a pan-India dashboard and is wrong beside the Scheduler Console's single-zone deck: the two
   * panes would disagree about how much trouble that zone is in.
   */
  it('narrows a CSM to one zone when asked, and never widens a ZM', async () => {
    const csm = await login('csm@fsm.test');
    const global = await request(app.getHttpServer())
      .get('/api/dashboard/action-required')
      .set('Authorization', `Bearer ${csm}`)
      .expect(200);
    const scoped = await request(app.getHttpServer())
      .get('/api/dashboard/action-required?zoneId=1')
      .set('Authorization', `Bearer ${csm}`)
      .expect(200);

    const total = (body: unknown) =>
      (body as { count: number; available: boolean }[])
        .filter((c) => c.available)
        .reduce((n, c) => n + c.count, 0);
    // One zone can never hold more than every zone. (Equality is legitimate on a fixture database
    // where all the work happens to sit in zone 1, so this is `<=`, not `<`.)
    expect(total(scoped.body)).toBeLessThanOrEqual(total(global.body));

    // A ZM is clamped by scope, so naming a zone they do not own must not move their answer.
    const zm = await login('zm.north@fsm.test');
    const own = await request(app.getHttpServer())
      .get('/api/dashboard/action-required')
      .set('Authorization', `Bearer ${zm}`)
      .expect(200);
    const tryWiden = await request(app.getHttpServer())
      .get('/api/dashboard/action-required?zoneId=99999')
      .set('Authorization', `Bearer ${zm}`)
      .expect(200);
    expect(total(tryWiden.body)).toBe(total(own.body));
  });

  it('forbids a Service Engineer', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer())
      .get('/api/dashboard/action-required')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });
});
