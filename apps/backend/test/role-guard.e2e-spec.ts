import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('RoleGuard (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
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

  // TB4: a role outside the route's allow-list is rejected with 403.
  it('forbids a SERVICE_ENGINEER on an Operations-Head-only route with 403', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer())
      .get('/api/settings')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('allows an OPERATIONS_HEAD on the same route', async () => {
    const token = await login('ops.head@fsm.test');
    await request(app.getHttpServer())
      .get('/api/settings')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });
});
