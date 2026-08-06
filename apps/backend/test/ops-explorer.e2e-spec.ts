import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/auth/token.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { OpsExplorerController } from '../src/ops-explorer/ops-explorer.controller';
import { OpsExplorerQueryDto } from '../src/ops-explorer/ops-explorer.dto';

/**
 * #217 — the Operations Data Explorer's HTTP contract: the two access gates, the developer-mode strip,
 * and the read-only guarantee.
 *
 * The flags are read per request (see `OpsExplorerEnabledGuard`), so this spec flips
 * `process.env.OPS_EXPLORER_*` between cases against ONE booted app rather than booting three. That is
 * a direct consequence of the guard's design decision and is worth pinning: if someone "optimises" the
 * guard to capture the flags at construction, these tests fail rather than silently passing forever.
 */
describe('#217 — /api/ops-explorer (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: TokenService;

  const ohToken = () => tokens.signAccessToken({ user_id: 'ops-217', role: 'OPERATIONS_HEAD', zone_id: null });
  const zmToken = () => tokens.signAccessToken({ user_id: 'zm-217', role: 'ZONAL_MANAGER', zone_id: 1 });

  const enable = (developerMode: boolean) => {
    process.env.OPS_EXPLORER_ENABLED = 'true';
    process.env.OPS_EXPLORER_DEVELOPER_MODE = developerMode ? 'true' : 'false';
  };
  const disable = () => {
    delete process.env.OPS_EXPLORER_ENABLED;
    delete process.env.OPS_EXPLORER_DEVELOPER_MODE;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);
  });

  afterEach(() => disable());

  afterAll(async () => {
    disable();
    await app.close();
  });

  describe('AC-1 — the feature flag is a 404, not a 403', () => {
    it('404s every route for Operations Head when the flag is off', async () => {
      disable();
      const token = ohToken();
      // Each request is CONSTRUCTED inside the loop, not collected into an array first: supertest binds
      // an ephemeral server per request object at construction, so building five up front and awaiting
      // them one at a time leaves four bound against a socket the first one already tore down.
      const routes: Array<['get' | 'post', string]> = [
        ['get', '/api/ops-explorer/meta'],
        ['get', '/api/ops-explorer/datasets/devices'],
        ['get', '/api/ops-explorer/reconciliation'],
        ['post', '/api/ops-explorer/datasets/devices/query'],
        ['post', '/api/ops-explorer/datasets/devices/export'],
      ];
      for (const [verb, path] of routes) {
        await request(app.getHttpServer())
          [verb](path)
          .set('Authorization', `Bearer ${token}`)
          .send(verb === 'post' ? {} : undefined)
          .expect(404);
      }
    });

    it('still requires authentication when the flag is on', async () => {
      enable(false);
      await request(app.getHttpServer()).get('/api/ops-explorer/meta').expect(401);
    });
  });

  describe('AC-2 — role gating', () => {
    it('403s a Zonal Manager and 200s Operations Head', async () => {
      enable(false);
      await request(app.getHttpServer())
        .get('/api/ops-explorer/meta')
        .set('Authorization', `Bearer ${zmToken()}`)
        .expect(403);
      await request(app.getHttpServer())
        .get('/api/ops-explorer/meta')
        .set('Authorization', `Bearer ${ohToken()}`)
        .expect(200);
    });
  });

  describe('AC-3/AC-4 — the module is read-only and gated in one place', () => {
    it('registers no mutating verb', () => {
      const proto = OpsExplorerController.prototype;
      const methods = Object.getOwnPropertyNames(proto).filter((m) => m !== 'constructor');
      for (const name of methods) {
        const path = Reflect.getMetadata('path', proto[name as keyof typeof proto] as object);
        const method = Reflect.getMetadata('method', proto[name as keyof typeof proto] as object);
        expect(path, `${name} should be a route`).toBeDefined();
        // RequestMethod: 0 = GET, 1 = POST. Anything else is a write verb and does not belong here.
        expect([0, 1], `${name} uses a mutating verb`).toContain(method);
      }
    });

    it('declares the role allow-list on the class, not per handler', () => {
      const classRoles = Reflect.getMetadata('roles', OpsExplorerController);
      expect(classRoles).toEqual(['OPERATIONS_HEAD']);
      const proto = OpsExplorerController.prototype;
      for (const name of Object.getOwnPropertyNames(proto).filter((m) => m !== 'constructor')) {
        const handlerRoles = Reflect.getMetadata('roles', proto[name as keyof typeof proto] as object);
        expect(handlerRoles, `${name} must not hard-code its own roles`).toBeUndefined();
      }
    });

    it('reflects the real DTO class on @Body() params, not an erased placeholder', () => {
      // Regression for a real bug: `import type { OpsExplorerQueryDto } from './ops-explorer.dto'`
      // in the controller erased the class from the COMPILED build (tsc respects `import type` and
      // strips it), so `emitDecoratorMetadata` had nothing to point `@Body()` at — Nest's global
      // ValidationPipe then validated against a bogus metatype with zero registered rules, and
      // `forbidNonWhitelisted` rejected every real field a caller sent ("property pageSize should
      // not exist") while an empty body sailed through untouched. Invisible under this suite's own
      // vitest+SWC transform (apparently doesn't reproduce the erasure) — only surfaced by hitting
      // the real `tsc`-compiled server through a browser. Import must stay a VALUE import; this
      // pins the metadata shape so a regression is a red test, not a silent live 400.
      const proto = OpsExplorerController.prototype;
      for (const method of ['query', 'export']) {
        const paramTypes = Reflect.getMetadata('design:paramtypes', proto, method) as unknown[];
        expect(paramTypes, method).toBeDefined();
        // (key: string, body: OpsExplorerQueryDto, ...) — body is always index 1.
        expect(paramTypes[1], `${method} @Body() param type`).toBe(OpsExplorerQueryDto);
      }
    });
  });

  describe('developer mode is stripped server-side', () => {
    it('omits SQL, FROM and the developer lineage when the flag is off', async () => {
      enable(false);
      const res = await request(app.getHttpServer())
        .get('/api/ops-explorer/meta')
        .set('Authorization', `Bearer ${ohToken()}`)
        .expect(200);

      expect(res.body.developerMode).toBe(false);
      // Every dataset, not just `devices` — a leak in dataset #7 is just as real as one in #1.
      for (const dataset of res.body.datasets) {
        expect(dataset.from, `${dataset.key}.from`).toBeUndefined();
        for (const col of dataset.columns) {
          expect(col.lineage.developer, `${dataset.key}.${col.key}.lineage.developer`).toBeUndefined();
          expect(col.lineage.definition, `${dataset.key}.${col.key}.lineage.definition`).toBeTruthy();
          expect(col.lineage.table, `${dataset.key}.${col.key}.lineage.table`).toBeTruthy();
          // drilldown.valueSql is a raw SQL expression and must never reach the client, in either
          // mode — assert on the specific field rather than a substring, because the operational
          // LINEAGE PROSE legitimately says things like "the LEFT JOIN leaves this blank" in plain
          // English (see plants/vehicles/tickets `excludes`), so scanning for that phrase is a false
          // positive, not a safety check.
          expect(col.drilldown?.valueSql, `${dataset.key}.${col.key}.drilldown.valueSql`).toBeUndefined();
        }
      }
      const devices = res.body.datasets.find((d: { key: string }) => d.key === 'devices');
      expect(JSON.stringify(devices)).not.toContain('ds.sla_bucket');
    });

    it('includes the lineage layer and per-query diagnostics when the flag is on', async () => {
      enable(true);
      const meta = await request(app.getHttpServer())
        .get('/api/ops-explorer/meta')
        .set('Authorization', `Bearer ${ohToken()}`)
        .expect(200);
      expect(meta.body.developerMode).toBe(true);
      const devices = meta.body.datasets.find((d: { key: string }) => d.key === 'devices');
      expect(devices.from).toContain('LEFT JOIN device_states');

      const page = await request(app.getHttpServer())
        .post('/api/ops-explorer/datasets/devices/query')
        .set('Authorization', `Bearer ${ohToken()}`)
        .send({ pageSize: 5 })
        .expect(200);
      expect(page.body.diagnostics.rowsSql).toContain('SELECT');
      expect(page.body.diagnostics.endpoint).toBe('POST /api/ops-explorer/datasets/devices/query');
      expect(typeof page.body.diagnostics.rowsQueryMs).toBe('number');
    });

    it('omits diagnostics entirely in operational mode', async () => {
      enable(false);
      const page = await request(app.getHttpServer())
        .post('/api/ops-explorer/datasets/devices/query')
        .set('Authorization', `Bearer ${ohToken()}`)
        .send({ pageSize: 5 })
        .expect(200);
      expect(page.body.diagnostics).toBeUndefined();
    });
  });

  describe('AC-7/AC-8 — querying', () => {
    beforeEach(() => enable(false));

    it('returns a page with the default columns and a total row count', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/ops-explorer/datasets/devices/query')
        .set('Authorization', `Bearer ${ohToken()}`)
        .send({ pageSize: 3 })
        .expect(200);
      expect(res.body.pageSize).toBe(3);
      expect(res.body.rows.length).toBeLessThanOrEqual(3);
      expect(res.body.columns.map((c: { key: string }) => c.key)).toContain('deviceId');
      expect(typeof res.body.totalRows).toBe('number');
    });

    it('accepts every OpsExplorerQueryDto field together in one request', async () => {
      // Black-box companion to the metadata-reflection regression test above. NOTE: this test alone
      // did NOT catch the `import type` erasure bug — it passed both before and after the fix, because
      // this suite's vitest+SWC transform doesn't reproduce tsc's import-type erasure, so the global
      // ValidationPipe was silently a no-op for this DTO under test the whole time. Kept anyway as the
      // black-box contract; the metadata-reflection test is what actually guards the compiled build.
      const res = await request(app.getHttpServer())
        .post('/api/ops-explorer/datasets/devices/query')
        .set('Authorization', `Bearer ${ohToken()}`)
        .send({
          columns: ['deviceId', 'zoneName'],
          filters: [{ column: 'isDeparted', operator: 'eq', value: false }],
          search: 'x',
          sort: [{ column: 'deviceId', direction: 'asc' }],
          page: 1,
          pageSize: 5,
        })
        .expect(200);
      expect(res.body.pageSize).toBe(5);
    });

    it('400s an unknown filter column rather than running anything', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/ops-explorer/datasets/devices/query')
        .set('Authorization', `Bearer ${ohToken()}`)
        .send({ filters: [{ column: 'device_id); DROP TABLE devices; --', operator: 'eq', value: 'x' }] })
        .expect(400);
      expect(res.body.code ?? res.body.message?.code).toBe('UNKNOWN_COLUMN');
      // The table is still there.
      expect(await prisma.device.count()).toBeGreaterThanOrEqual(0);
    });

    it('404s an unknown dataset', async () => {
      await request(app.getHttpServer())
        .post('/api/ops-explorer/datasets/nope/query')
        .set('Authorization', `Bearer ${ohToken()}`)
        .send({})
        .expect(404);
    });
  });

  describe('AC-5/AC-9 — audited, server-side export', () => {
    it('streams CSV of the filtered result and writes one audit row', async () => {
      enable(false);
      const before = await prisma.auditLog.count({ where: { entityType: 'OPS_EXPLORER_EXPORT' } });

      const res = await request(app.getHttpServer())
        .post('/api/ops-explorer/datasets/devices/export')
        .set('Authorization', `Bearer ${ohToken()}`)
        .send({ columns: ['deviceId', 'zoneName'], filters: [{ column: 'isDeparted', operator: 'eq', value: false }] })
        .expect(200);

      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain('ops-explorer-devices-');
      expect(res.text.split('\n')[0]).toContain('Device ID');

      const after = await prisma.auditLog.count({ where: { entityType: 'OPS_EXPLORER_EXPORT' } });
      expect(after).toBe(before + 1);
    });

    it('audits opening the tool', async () => {
      enable(false);
      const before = await prisma.auditLog.count({ where: { action: 'OPS_EXPLORER_ACCESSED' } });
      await request(app.getHttpServer())
        .get('/api/ops-explorer/meta')
        .set('Authorization', `Bearer ${ohToken()}`)
        .expect(200);
      expect(await prisma.auditLog.count({ where: { action: 'OPS_EXPLORER_ACCESSED' } })).toBe(before + 1);
    });
  });

  describe('AC-10/AC-11 — reconciliation', () => {
    it('evaluates every identity over the live database and reports a signed difference', async () => {
      enable(true);
      const res = await request(app.getHttpServer())
        .get('/api/ops-explorer/reconciliation')
        .set('Authorization', `Bearer ${ohToken()}`)
        .expect(200);

      const keys = res.body.identities.map((i: { key: string }) => i.key);
      expect(keys).toEqual([
        'zoneRollup',
        'companyRollup',
        'mirroredPartition',
        'operationalPartition',
        'bucketRollup',
        'dispatchBatchLedger',
        'autoplantPlantsCount',
        'autoplantVehiclesCount',
      ]);
      for (const identity of res.body.identities) {
        expect(identity.difference).toBe(identity.left.value - identity.right.value);
        if (identity.status === 'UNAVAILABLE') {
          // The two AutoPlant identities (#217 S3) — no VPN in this environment, so they never claim
          // a PASS or FAIL over data that was never read.
          expect(identity.unavailableReason).toBeTruthy();
          expect(identity.likelySources).toEqual([]);
          continue;
        }
        expect(identity.status).toBe(identity.difference === 0 ? 'PASS' : 'FAIL');
        if (identity.status === 'PASS') expect(identity.likelySources).toEqual([]);
        else expect(identity.likelySources.length).toBeGreaterThan(0);
      }
    });

    it('AutoPlant identities are UNAVAILABLE — not a fabricated PASS/FAIL — when the source is unconfigured (#217 S3)', async () => {
      // #182: the e2e suite deletes every AUTOPLANT_MYSQL_* var and never re-sets it, so this is the
      // real, deterministic state of every dev/test/CI run — not a mock of one.
      expect(process.env.AUTOPLANT_MYSQL_HOST).toBeUndefined();
      enable(true);
      const res = await request(app.getHttpServer())
        .get('/api/ops-explorer/reconciliation')
        .set('Authorization', `Bearer ${ohToken()}`)
        .expect(200);

      const byKey = Object.fromEntries(res.body.identities.map((i: { key: string }) => [i.key, i]));
      for (const key of ['autoplantPlantsCount', 'autoplantVehiclesCount']) {
        expect(byKey[key].status, key).toBe('UNAVAILABLE');
        expect(byKey[key].unavailableReason, key).toMatch(/AutoPlant/i);
        expect(byKey[key].sql, `${key} sql in dev mode`).toBeUndefined();
      }
    });

    it('UNAVAILABLE never flips the overall report to FAIL by itself', async () => {
      enable(false);
      const res = await request(app.getHttpServer())
        .get('/api/ops-explorer/reconciliation')
        .set('Authorization', `Bearer ${ohToken()}`)
        .expect(200);
      const nonAutoplant = res.body.identities.filter(
        (i: { key: string }) => i.key !== 'autoplantPlantsCount' && i.key !== 'autoplantVehiclesCount',
      );
      const expectedOverall = nonAutoplant.every((i: { status: string }) => i.status !== 'FAIL') ? 'PASS' : 'FAIL';
      expect(res.body.status).toBe(expectedOverall);
    });

    it('the three single-query partition identities always hold — they are structural', async () => {
      enable(false);
      const res = await request(app.getHttpServer())
        .get('/api/ops-explorer/reconciliation')
        .set('Authorization', `Bearer ${ohToken()}`)
        .expect(200);
      const byKey = Object.fromEntries(
        res.body.identities.map((i: { key: string; status: string }) => [i.key, i.status]),
      );
      expect(byKey.mirroredPartition).toBe('PASS');
      expect(byKey.operationalPartition).toBe('PASS');
      expect(byKey.bucketRollup).toBe('PASS');
    });

    it('omits the per-identity SQL in operational mode', async () => {
      enable(false);
      const res = await request(app.getHttpServer())
        .get('/api/ops-explorer/reconciliation')
        .set('Authorization', `Bearer ${ohToken()}`)
        .expect(200);
      for (const identity of res.body.identities) expect(identity.sql).toBeUndefined();
    });
  });
});
