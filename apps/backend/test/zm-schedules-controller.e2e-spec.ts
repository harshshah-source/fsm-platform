import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * Issue 13a slice 1 — ZM monitoring HTTP surface (AC#1/#2). GET /api/schedules (per-SE rows) and
 * GET /api/schedules/:engineerId (ordered stops + reasoning), manager-roled and zone-scoped. SEs read
 * their own plan via /api/schedules/me (Issue 11) and are gated out of the monitoring list.
 */
describe('ZM schedules monitoring (e2e)', () => {
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

  it('returns the per-SE schedule list for a ZM', async () => {
    const token = await login('zm.north@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/schedules')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  /**
   * #284 §D — the date filter over the wire: accepted, additive, and validated with the same
   * `INVALID_DATE` shape `GET /schedules/preview` already returns for the same parser.
   */
  it('#284 — accepts ?date= and rejects a malformed one with INVALID_DATE', async () => {
    const token = await login('zm.north@fsm.test');
    const filtered = await request(app.getHttpServer())
      .get('/api/schedules?date=2026-06-21')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(Array.isArray(filtered.body)).toBe(true);

    const bad = await request(app.getHttpServer())
      .get('/api/schedules?date=2026-02-31')
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
    expect(bad.body.code).toBe('INVALID_DATE');
  });

  /**
   * **`?detail=stops` — the read the Scheduler Console's future columns draw chips from.**
   *
   * Additive on exactly the terms `?date=` established (#284 §D): a caller that does not ask gets a
   * byte-identical response, so the assertion below is not "detail works" but "**omitting it changes
   * nothing**". That is the property a widened shared read can lose silently, because every existing
   * caller keeps working right up until one of them chokes on a field it never expected.
   *
   * Why the Console needs it at all: a future day used to be answerable only in counts, so a ticket
   * an operator had just moved onto Wednesday could be reported as `1 stop · 1 device` and never as
   * *which* device — indistinguishable from any other stop appearing, which is the same silence the
   * old cross-day defer produced.
   */
  it('accepts ?detail=stops, and omitting it leaves the response exactly as it was', async () => {
    const token = await login('zm.north@fsm.test');
    const plain = await request(app.getHttpServer())
      .get('/api/schedules')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const detailed = await request(app.getHttpServer())
      .get('/api/schedules?detail=stops')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(Array.isArray(detailed.body)).toBe(true);
    // The opt-out is the contract: no `stops` key at all unless it was asked for.
    for (const row of plain.body as Record<string, unknown>[]) {
      expect(row).not.toHaveProperty('stops');
    }
    // Same rows, same counts — `detail` widens a select, it does not change what is selected.
    expect((detailed.body as unknown[]).length).toBe((plain.body as unknown[]).length);
    for (const row of detailed.body as { stops?: unknown[]; batchCount: number; ticketCount: number }[]) {
      expect(Array.isArray(row.stops)).toBe(true);
      // Hollow stops are dropped, so `stops.length <= batchCount` rather than equal — a batch whose
      // every ticket was removed is not a stop anyone will make.
      expect(row.stops!.length).toBeLessThanOrEqual(row.batchCount);
      for (const stop of row.stops as { tickets: Record<string, unknown>[] }[]) {
        for (const t of stop.tickets) {
          // The provenance the chip grammar reads, including the server's own reading of it — the
          // client never re-derives which add sources are the engine's (#283's rule).
          expect(t).toHaveProperty('ticketId');
          expect(typeof t.systemPlaced).toBe('boolean');
        }
      }
    }
  });

  it('forbids an SE from the ZM monitoring list', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer())
      .get('/api/schedules')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('404s the detail for an engineer with no schedule in the ZM zone', async () => {
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .get('/api/schedules/00000000-0000-0000-0000-0000000000ff')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer()).get('/api/schedules').expect(401);
  });

  it('404s critical-queue assign for an unknown ticket as a ZM', async () => {
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .post('/api/schedules/assign')
      .set('Authorization', `Bearer ${token}`)
      .send({ ticketId: '00000000-0000-0000-0000-0000000000ff', seId: '00000000-0000-0000-0000-0000000000ee' })
      .expect(404);
  });

  it('forbids an SE from the critical-queue assign', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer())
      .post('/api/schedules/assign')
      .set('Authorization', `Bearer ${token}`)
      .send({ ticketId: '00000000-0000-0000-0000-0000000000ff', seId: '00000000-0000-0000-0000-0000000000ee' })
      .expect(403);
  });
});
