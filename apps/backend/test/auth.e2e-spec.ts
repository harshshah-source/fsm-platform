import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Auth guard (e2e)', () => {
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

  // TB1: a guarded route must reject callers with no/invalid credentials.
  it('rejects an unauthenticated request to a guarded route with 401', async () => {
    await request(app.getHttpServer()).get('/api/me').expect(401);
  });
});
