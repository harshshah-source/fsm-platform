import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.config';

/**
 * Wave 0 / #169 — `/api/v1` without breaking `/api`.
 *
 * The SE mobile contract freeze needs a version segment in the URL *before* a client ships, because
 * adding `/v1` after v1 is in the field is itself the breaking change it exists to prevent. But 90
 * backend e2e specs and every `apps/admin` API module call `/api/...` today, so a hard switch is not
 * available.
 *
 * URI versioning with `defaultVersion: ['1', VERSION_NEUTRAL]` registers every route at BOTH paths,
 * so `/api/v1` exists from now on and `/api` keeps working until the admin client is migrated
 * deliberately. These tests pin both halves — the second is the one that catches a future
 * "tidy-up" that drops VERSION_NEUTRAL and silently 404s the whole admin app.
 */
describe('API versioning (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app); // production HTTP config — prefix + versioning + CORS + body limits
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves the versioned path /api/v1/health', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('still serves the unversioned path /api/health (admin + 90 e2e specs depend on it)', async () => {
    const res = await request(app.getHttpServer()).get('/api/health').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('applies versioning to guarded routes too, not just @Public ones', async () => {
    // 401 (not 404) proves the route is registered under /v1 and reached the auth guard.
    await request(app.getHttpServer()).get('/api/v1/me').expect(401);
    await request(app.getHttpServer()).get('/api/me').expect(401);
  });

  it('does not invent other version segments', async () => {
    await request(app.getHttpServer()).get('/api/v2/health').expect(404);
  });
});
