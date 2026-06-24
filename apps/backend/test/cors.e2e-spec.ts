import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../src/app.config';
import { AppModule } from '../src/app.module';

/**
 * The admin app (Vite dev server, :5173) is a separate origin from the API, so the
 * backend must send CORS headers or the browser blocks login. configureApp() is the
 * shared bootstrap used by both main.ts and the tests.
 */
describe('CORS (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('reflects the admin dev origin on an actual request', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('Origin', 'http://localhost:5173')
      .send({ email: 'zm.north@fsm.test', password: 'correct-password' })
      .expect(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });
});
