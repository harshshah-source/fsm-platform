import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Acting-as-role context (e2e)', () => {
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

  // TB7: a CSM acting in a ZM's zone has acted_as_role stamped as CENTRAL_SERVICE_MANAGER.
  it('stamps acted_as_role = CENTRAL_SERVICE_MANAGER when a CSM acts in a ZM zone', async () => {
    const token = await login('csm@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/me')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Acting-As-Zone', '1')
      .expect(200);
    expect(res.body.acted_as_role).toBe('CENTRAL_SERVICE_MANAGER');
  });

  it('leaves acted_as_role null for a normal Zonal Manager request', async () => {
    const token = await login('zm.north@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.acted_as_role).toBeNull();
  });

  it('leaves acted_as_role null for a CSM not acting in any zone', async () => {
    const token = await login('csm@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.acted_as_role).toBeNull();
  });
});
