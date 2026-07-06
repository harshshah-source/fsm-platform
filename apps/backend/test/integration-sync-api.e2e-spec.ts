import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';

/**
 * Step 2 — the integration pipeline trigger surface (`POST /api/integration/run-pipeline` +
 * `/sync-masters`). Booting the full AppModule here proves the whole DI graph now wires:
 * `MasterSyncService` with its three ports (paginated source, mapping-table zone resolver, ACTIVE
 * scope), `IntegrationSyncService`, and the `DeviceStateModule` it depends on. In the test env
 * AutoPlant is unconfigured (setup-env clears the vars), so both triggers must 503 — the guard that
 * stops a stray run from silently no-opping against the empty source.
 */
describe('Step 2 — POST /api/integration/{run-pipeline,sync-masters}', () => {
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

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  };

  it('503s both triggers for Operations Head when AutoPlant is unconfigured', async () => {
    const token = await login('ops.head@fsm.test');
    await request(app.getHttpServer())
      .post('/api/integration/sync-masters')
      .set('Authorization', `Bearer ${token}`)
      .expect(503);
    await request(app.getHttpServer())
      .post('/api/integration/run-pipeline')
      .set('Authorization', `Bearer ${token}`)
      .expect(503);
  });

  it('forbids a Zonal Manager and rejects an anonymous caller', async () => {
    const zmToken = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .post('/api/integration/run-pipeline')
      .set('Authorization', `Bearer ${zmToken}`)
      .expect(403);
    await request(app.getHttpServer()).post('/api/integration/run-pipeline').expect(401);
  });
});
