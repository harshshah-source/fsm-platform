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
