import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 03 slice 3 — `/api/notifications`. The signed-in user's in-app notification list (newest first,
 * unread filter + unread count) and read state. A user only ever sees / marks their own notifications.
 */
describe('Issue 03 slice 3 — /api/notifications (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  // Auth uses the in-memory dev-seed store (fixed UUIDs), and notifications.recipient_user_id has no FK.
  const zmId = '11111111-1111-1111-1111-111111111111'; // zm.north@fsm.test
  const ohId = '33333333-3333-3333-3333-333333333333'; // ops.head@fsm.test
  const createdIds: bigint[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { id: { in: createdIds } } });
    await app.close();
  });

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-password' }).expect(200);
    return res.body.accessToken as string;
  };

  async function seed(recipientUserId: string, title: string): Promise<bigint> {
    const n = await prisma.notification.create({ data: { recipientUserId, recipientRole: 'ZONAL_MANAGER', type: 'SLA_WARNING', title } });
    createdIds.push(n.id);
    return n.id;
  }

  it('lists the user’s own notifications newest-first with an unread count', async () => {
    const token = await login('zm.north@fsm.test');
    const before = (await request(app.getHttpServer()).get('/api/notifications').set('Authorization', `Bearer ${token}`).expect(200)).body;

    const tag = randomUUID().slice(0, 6);
    await seed(zmId, `older ${tag}`);
    const newerId = await seed(zmId, `newer ${tag}`);

    const res = await request(app.getHttpServer()).get('/api/notifications').set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body.unreadCount).toBe(before.unreadCount + 2);
    const mine = res.body.items.filter((i: { title: string }) => i.title.endsWith(tag));
    expect(mine[0].id).toBe(String(newerId)); // newest first
    expect(mine.every((i: { read: boolean }) => i.read === false)).toBe(true);
  });

  it('marks a notification read and drops it from the unread filter', async () => {
    const token = await login('zm.north@fsm.test');
    const id = await seed(zmId, 'to-read ' + randomUUID().slice(0, 6));
    await request(app.getHttpServer()).post(`/api/notifications/${id}/read`).set('Authorization', `Bearer ${token}`).expect(200);

    const unread = (await request(app.getHttpServer()).get('/api/notifications?unread=true').set('Authorization', `Bearer ${token}`).expect(200)).body;
    expect(unread.items.some((i: { id: string }) => i.id === String(id))).toBe(false);
  });

  it('cannot mark another user’s notification read (404)', async () => {
    const otherId = await seed(ohId, 'not-yours');
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer()).post(`/api/notifications/${otherId}/read`).set('Authorization', `Bearer ${token}`).expect(404);
  });

  it('requires authentication (401)', async () => {
    await request(app.getHttpServer()).get('/api/notifications').expect(401);
  });
});
