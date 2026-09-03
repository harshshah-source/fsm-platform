import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 02, Slice 1 — the config write path. Operations Head edits a config value through the
 * guarded HTTP surface; it persists, is reflected on read, and (Slice 1b) writes an audit row.
 * This is the reusable "every config mutation is audited" spine (Issue 02 AC#6) and the issue's
 * stated end-to-end demo.
 */
describe('Issue 02 Slice 1 — PUT /api/settings/:key (config write)', () => {
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

  it('lets Operations Head update a setting value and reflects it on read', async () => {
    const token = await login('ops.head@fsm.test');
    const key = `test_threshold_${randomUUID().slice(0, 8)}`;

    await request(app.getHttpServer())
      .put(`/api/settings/${key}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ value: 42 })
      .expect(200)
      .expect((res) => {
        expect(res.body.value).toBe(42);
      });

    const read = await request(app.getHttpServer())
      .get('/api/settings')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(read.body[key]).toBe(42);
  });

  it('writes an audit_logs row attributed to the editing Operations Head', async () => {
    const token = await login('ops.head@fsm.test');
    const key = `test_threshold_${randomUUID().slice(0, 8)}`;

    await request(app.getHttpServer())
      .put(`/api/settings/${key}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ value: 7 })
      .expect(200);

    const prisma = new PrismaService();
    await prisma.onModuleInit();
    try {
      const rows = await prisma.auditLog.findMany({
        where: { entityType: 'system_settings', entityId: key },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].actorRole).toBe('OPERATIONS_HEAD');
      // ops.head seed user id
      expect(rows[0].actorId).toBe('33333333-3333-3333-3333-333333333333');
    } finally {
      await prisma.onModuleDestroy();
    }
  });

  /**
   * #343 AC3 — the audit row carries what the value **was** and what it **became**. Without the pair
   * a `SETTING_UPDATED` row says only that someone touched the dial: it cannot answer "what did this
   * change" and so cannot be used to undo or to explain a behaviour change that started at 14:02.
   * `previous` is `null` on a key's first-ever write — an honest "there was nothing here", distinct
   * from a key whose previous value happened to be zero.
   */
  it('AC3 — SETTING_UPDATED carries {key, previous, next}, with previous null on first write', async () => {
    const token = await login('ops.head@fsm.test');
    const key = `test_threshold_${randomUUID().slice(0, 8)}`;

    await request(app.getHttpServer())
      .put(`/api/settings/${key}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ value: 11 })
      .expect(200);
    await request(app.getHttpServer())
      .put(`/api/settings/${key}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ value: 13 })
      .expect(200);

    const prisma = new PrismaService();
    await prisma.onModuleInit();
    try {
      const rows = await prisma.auditLog.findMany({
        where: { entityType: 'system_settings', entityId: key },
        orderBy: { createdAt: 'asc' },
      });
      expect(rows).toHaveLength(2);
      expect(rows[0].metadata).toEqual({ key, previous: null, next: 11 });
      expect(rows[1].metadata).toEqual({ key, previous: 11, next: 13 });
    } finally {
      await prisma.onModuleDestroy();
    }
  });

  it('rejects a non-Operations-Head writer with 403', async () => {
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .put('/api/settings/inactivity_threshold_hours')
      .set('Authorization', `Bearer ${token}`)
      .send({ value: 999 })
      .expect(403);
  });
});
