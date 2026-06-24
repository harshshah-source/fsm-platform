import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * Issue 06, slice 4 — `/api/dashboard/action-required` (AC#1, AC#6).
 *
 * The urgency-ordered Action Required card contract. Every card's data source is a later issue
 * (batches→11, readiness→28, insertions→29, verification→18/19, component-blocked→21,
 * waiting-component→22, non-op→35, manual-assign→30), so each card is a graceful stub
 * (`available:false`, `count:0`) here; later issues flip availability and wire counts.
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
    // is wired (Issue 23): it is available, with a count ≥ 0.
    for (const c of cards) {
      if (c.key === 'waiting_component_overdue') {
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

  it('forbids a Service Engineer', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer())
      .get('/api/dashboard/action-required')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });
});
