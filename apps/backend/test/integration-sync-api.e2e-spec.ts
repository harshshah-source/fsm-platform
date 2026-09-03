import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { AutoPlantMysqlClient } from '../src/ingestion/autoplant/autoplant-mysql.client';
import { IntegrationSyncService } from '../src/ingestion/autoplant/integration-sync.service';
import { PrismaService } from '../src/prisma/prisma.service';

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

  /**
   * #343 — a trigger that 503'd never touched the source, so there is nothing to attribute. Auditing
   * the *attempt* would fill the ledger with rows for pipelines that did not run, which is the same
   * failure as not auditing at all: the operator can no longer trust that a row means a run happened.
   */
  it('a refused (503) trigger writes no audit row', async () => {
    const token = await login('ops.head@fsm.test');
    const prisma = app.get(PrismaService);
    const before = await prisma.auditLog.count({ where: { entityType: 'integration_pipeline' } });

    await request(app.getHttpServer())
      .post('/api/integration/sync-masters')
      .set('Authorization', `Bearer ${token}`)
      .expect(503);

    expect(await prisma.auditLog.count({ where: { entityType: 'integration_pipeline' } })).toBe(before);
  });
});

/**
 * #343 AC1 — the manual triggers with AutoPlant "configured". The env cannot be configured in test
 * (there is no AutoPlant to reach), so the two collaborators the controller consults are replaced:
 * the client's `isConfigured()` gate, and the sync service whose pipeline would otherwise take
 * minutes against a real MySQL. What is under test here is the controller's audit contract, not the
 * pipeline — the pipeline has its own specs.
 */
describe('#343 — manual ingestion triggers are attributable', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const summary = {
    master: { runId: '7', status: 'SUCCESS', stats: {} },
    snapshot: { runId: '8', status: 'SUCCESS', chunks: 0, inserted: 0 },
    deviceState: { upserted: 0, derived: true },
    recovered: { closed: 0, considered: 0 },
    tickets: { created: 0 },
    ingestComplete: true,
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AutoPlantMysqlClient)
      .useValue({ isConfigured: () => true, query: async () => [], ping: async () => true })
      .overrideProvider(IntegrationSyncService)
      .useValue({
        syncMasters: async () => summary.master,
        runPipeline: async () => summary,
      })
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { entityType: 'integration_pipeline' } });
    await app.close();
  });

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  };

  it('sync-masters writes MANUAL_SYNC_TRIGGERED and run-pipeline writes PIPELINE_RUN_TRIGGERED', async () => {
    const token = await login('ops.head@fsm.test');

    await request(app.getHttpServer())
      .post('/api/integration/sync-masters')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/integration/run-pipeline?chunkSize=40')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const rows = await prisma.auditLog.findMany({
      where: { entityType: 'integration_pipeline' },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((r) => r.action)).toEqual(['MANUAL_SYNC_TRIGGERED', 'PIPELINE_RUN_TRIGGERED']);
    expect(rows.map((r) => r.entityId)).toEqual(['sync-masters', 'run-pipeline']);
    expect(rows.every((r) => r.actorRole === 'OPERATIONS_HEAD')).toBe(true);
    expect(rows[0].metadata).toMatchObject({ trigger: 'manual' });
    // The clamped page size is on the row: a pipeline run behaves differently at 40 rows a query than
    // at 90, and "who ran it" without "how" cannot explain a slow afternoon.
    expect(rows[1].metadata).toMatchObject({ trigger: 'manual', chunkSize: 40 });
  });
});
