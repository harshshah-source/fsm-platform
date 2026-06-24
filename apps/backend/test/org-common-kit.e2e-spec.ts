import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 02 Slice 9 — Common Kit definition (`common_kit_definition`). Operations Head configures
 * the components every SE carries without code changes (AC#3); input to the Recommender Common-Kit
 * Hard Filter (Issue 21). Upsert keyed by componentId.
 */
describe('Issue 02 Slice 9 — /api/org/common-kit', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    // Tear down the kit row + its auto-provisioned component_master so the global kit doesn't pollute
    // other suites (Issue 21: the kit is global state read by the Recommender Common-Kit filter).
    const prisma = app.get(PrismaService);
    await prisma.commonKitDefinition.deleteMany({ where: { componentId: BigInt(componentId) } });
    await prisma.componentMaster.deleteMany({ where: { componentId: BigInt(componentId) } });
    await app.close();
  });

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  }

  // Distinct componentId per run so parallel/repeat runs don't collide on the unique key.
  const componentId = 900000 + Math.floor(Math.random() * 90000);

  it('upserts a Common Kit component and lists it', async () => {
    const token = await login('ops.head@fsm.test');

    const created = await request(app.getHttpServer())
      .post('/api/org/common-kit')
      .set('Authorization', `Bearer ${token}`)
      .send({ componentId, minQty: 2 })
      .expect(201);
    expect(created.body.componentId).toBe(componentId);
    expect(created.body.minQty).toBe(2);
    expect(created.body.active).toBe(true);

    await request(app.getHttpServer())
      .post('/api/org/common-kit')
      .set('Authorization', `Bearer ${token}`)
      .send({ componentId, minQty: 5 })
      .expect(201);

    const list = await request(app.getHttpServer())
      .get('/api/org/common-kit')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const rows = list.body.filter((r: { componentId: number }) => r.componentId === componentId);
    expect(rows).toHaveLength(1);
    expect(rows[0].minQty).toBe(5);
  });

  it('rejects a non-positive minQty with 400', async () => {
    const token = await login('ops.head@fsm.test');
    await request(app.getHttpServer())
      .post('/api/org/common-kit')
      .set('Authorization', `Bearer ${token}`)
      .send({ componentId: 12345, minQty: 0 })
      .expect(400);
  });

  it('rejects a non-Operations-Head writer with 403', async () => {
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .post('/api/org/common-kit')
      .set('Authorization', `Bearer ${token}`)
      .send({ componentId: 12345, minQty: 1 })
      .expect(403);
  });
});
