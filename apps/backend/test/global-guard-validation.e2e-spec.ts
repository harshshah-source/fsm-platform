import {
  Body,
  Controller,
  Get,
  type INestApplication,
  Module,
  Post,
} from '@nestjs/common';
import { IsString } from 'class-validator';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.config';

/**
 * #99 — global auth guard + request validation + body limits.
 *
 * The canary module below simulates tomorrow's mistake: a controller added WITHOUT `@UseGuards`
 * and with a real DTO class. The global `APP_GUARD` must still 401 it, and the global
 * `ValidationPipe` (whitelist + forbidNonWhitelisted + transform) must reject unknown fields —
 * so forgetting the per-controller decorators no longer ships a world-readable, garbage-accepting
 * route.
 */
class CanaryBody {
  @IsString()
  name!: string;
}

@Controller('sweep-canary')
class CanaryController {
  @Get()
  read(): { ok: true } {
    return { ok: true };
  }

  @Post()
  write(@Body() body: CanaryBody): { echoed: string } {
    return { echoed: body.name };
  }
}

@Module({ controllers: [CanaryController] })
class CanaryModule {}

describe('#99 global guard + validation + body limits (e2e)', () => {
  let app: INestApplication;

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, CanaryModule],
    }).compile();
    app = moduleRef.createNestApplication(undefined, { bodyParser: false });
    configureApp(app); // production HTTP config: prefix + CORS + body limits (sole JSON parser)
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  // AC#1 — the global guard protects a route whose author forgot @UseGuards.
  it('401s an unauthenticated request to a controller with no local @UseGuards', async () => {
    await request(app.getHttpServer()).get('/api/sweep-canary').expect(401);
  });

  it('still serves the forgotten controller to an authenticated caller', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/sweep-canary')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body).toEqual({ ok: true });
  });

  // AC#1 — the intentionally public routes are @Public() and stay reachable without a token.
  it('keeps login/refresh/health public', async () => {
    await request(app.getHttpServer()).get('/api/health').expect(200);
    const ready = await request(app.getHttpServer()).get('/api/health/ready');
    expect([200, 503]).toContain(ready.status); // readiness may be red, but never 401
    // A tokenless login with valid dev credentials succeeds — the guard did not intercept it.
    const token = await login('ops.head@fsm.test');
    expect(token).toBeTruthy();
  });

  // Route-guard sweep (AC#4): every registered route must 401 without a token unless it is on the
  // explicit public allowlist. A future route added without a guard — or made @Public casually —
  // fails this test until the allowlist is consciously edited.
  it('sweeps the full route map: everything 401s bare except the public allowlist', async () => {
    const PUBLIC = new Set([
      'GET /api/health',
      'GET /api/health/ready',
      'POST /api/auth/login',
      'POST /api/auth/refresh',
      'POST /api/auth/logout', // #91 S3 — the presented refresh token IS the credential, like /refresh
      'GET /api/non-op/confirm', // customer tokenised-email link (Issue 35 AC#6) — token IS the credential
    ]);
    interface RouteLayer {
      route?: { path: string; methods: Record<string, boolean> };
    }
    const stack = (
      app.getHttpAdapter().getInstance() as { _router: { stack: RouteLayer[] } }
    )._router.stack;
    const routes = stack
      .filter((l) => l.route)
      .flatMap((l) =>
        Object.keys(l.route!.methods).map((m) => ({
          method: m.toUpperCase(),
          path: l.route!.path,
        })),
      );
    expect(routes.length).toBeGreaterThan(50); // the enumerator actually saw the app

    const leaks: string[] = [];
    for (const { method, path } of routes) {
      // #169 dual-serve versioning registers every route at BOTH `/api/...` and `/api/v1/...`.
      // Normalise the version segment away so `PUBLIC` stays ONE conscious list of public routes
      // instead of one per version — and so adding `/v2` later cannot slip a public alias past this
      // sweep unnoticed. The allowlist's whole job (see the comment above) is that widening it is a
      // deliberate edit; a per-version copy would defeat that.
      const key = `${method} ${path.replace(/^\/api\/v\d+\//, '/api/')}`;
      if (PUBLIC.has(key)) continue;
      const concrete = path.replace(/:[^/]+/g, '1'); // substitute params; guard runs before lookup
      const res = await request(app.getHttpServer())[
        method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete'
      ](concrete);
      if (res.status !== 401) leaks.push(`${key} → ${res.status}`);
    }
    expect(leaks).toEqual([]);
  });

  // AC#2 — global ValidationPipe: unknown fields on a DTO-typed route are rejected, not absorbed.
  it('rejects unknown body fields on a DTO route with 400 (forbidNonWhitelisted)', async () => {
    const token = await login('ops.head@fsm.test');
    await request(app.getHttpServer())
      .post('/api/sweep-canary')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'ok', smuggled: 'field' })
      .expect(400);
    const good = await request(app.getHttpServer())
      .post('/api/sweep-canary')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'ok' })
      .expect(201);
    expect(good.body).toEqual({ echoed: 'ok' });
  });

  // AC#2 — the audit's named case: BigInt(garbage) on the cross-zone path must be a 400, not a 500.
  it('400s zoneId garbage on POST /api/cross-zone/sweep instead of a raw 500', async () => {
    const token = await login('ops.head@fsm.test');
    await request(app.getHttpServer())
      .post('/api/cross-zone/sweep')
      .set('Authorization', `Bearer ${token}`)
      .send({ zoneId: 'not-a-number' })
      .expect(400);
  });

  // AC#3 — explicit body-size limit: a mid-size body (over Express's 100kb default) is accepted,
  // an oversized one is cleanly 413'd. Proves OUR limit governs, not the accidental default.
  it('accepts a 512kb body and rejects a 2mb body with 413', async () => {
    const midsize = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'nobody@fsm.test', password: 'x'.repeat(512 * 1024) });
    expect(midsize.status).not.toBe(413);
    const oversized = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'nobody@fsm.test', password: 'x'.repeat(2 * 1024 * 1024) });
    expect(oversized.status).toBe(413);
  });

  // AC#3 — CSV row cap on the install bulk path: over-cap payloads are rejected by count alone,
  // with a distinct clear error (before any per-row DB validation work happens).
  it('rejects an install CSV over the row cap with CSV_TOO_MANY_ROWS', async () => {
    const token = await login('ops.head@fsm.test');
    const header = 'vehicle_no,plant_id,company_id,device_type,device_id';
    const rows = Array.from({ length: 1001 }, (_, i) => `VH-${i},1,1,GPS,DVC-${i}`);
    const res = await request(app.getHttpServer())
      .post('/api/install/upload')
      .set('Authorization', `Bearer ${token}`)
      .send({ csv: [header, ...rows].join('\n') })
      .expect(400);
    expect(res.body.code).toBe('CSV_TOO_MANY_ROWS');
    expect(res.body.maxRows).toBe(1000);
  });
});
