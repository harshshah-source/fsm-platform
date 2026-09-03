import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Acting-as-role context.
 *
 * **#339 turned this from a parse into a gate.** Before it, `resolveActingContext` granted acting to
 * *any* CSM or Operations Head whose `X-Acting-As-Zone` header parsed as a number: `role_unavailability`
 * was never consulted (`RoleBackupService.currentActingRoleForZone` had no callers at all), zone `99`
 * was accepted, and `abc` parsed to `NaN` and fell through to pan-India — the widest scope in the
 * system, reached by sending nonsense. Every request also re-parsed the header independently in three
 * places (`acting-context`, `manager-scope`, `request-actor`), so a check added to one would not have
 * bound the others.
 *
 * The rule this pins: **a CSM may act in a zone only while that zone's ZM duty has actually cascaded
 * to them** (CONTEXT.md §15 — an open `role_unavailability` window for that zone's ZM, and the CSM
 * themselves not out). **An Operations Head may act anywhere** — pan-India authority is theirs by
 * role — but the request is still attributed. A ZM or WM sending the header is unchanged: ignored,
 * never widened.
 */
describe('Acting-as-role context (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  /** `role_unavailability` rows this file wrote, cleaned per test — the suite shares one database. */
  const windows: bigint[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterEach(async () => {
    if (windows.length > 0) {
      await prisma.roleUnavailability.deleteMany({ where: { id: { in: windows } } });
      windows.length = 0;
    }
    await prisma.auditLog.deleteMany({ where: { action: { in: ['ACTING_STARTED', 'ACTING_ENDED'] } } });
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

  /** A zone that exists in the seeded reference data, with its numeric id. */
  async function seededZone(): Promise<number> {
    const zone = await prisma.zone.findFirstOrThrow({ where: { name: 'North' }, select: { zoneId: true } });
    return Number(zone.zoneId);
  }

  /** Open a ZM-out window for `zoneId` through the real door, so the cascade actually holds. */
  async function openZmWindow(zoneId: number): Promise<void> {
    const row = await prisma.roleUnavailability.create({
      data: {
        role: 'ZONAL_MANAGER',
        zoneId: BigInt(zoneId),
        windowStart: new Date(Date.now() - 60 * 60_000),
        windowEnd: null,
        reason: 'fixture: ZM out',
        createdByRole: 'OPERATIONS_HEAD',
      },
    });
    windows.push(row.id);
  }

  describe("AC1 — a CSM acts only while the zone's ZM duty has actually cascaded to them", () => {
    it('refuses a CSM whose target zone has no open ZM window (403 ACTING_NOT_PERMITTED)', async () => {
      const token = await login('csm@fsm.test');
      const zoneId = await seededZone();

      const res = await request(app.getHttpServer())
        .get('/api/me')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Acting-As-Zone', String(zoneId))
        .expect(403);

      // Refused, not silently downgraded: a request that *believes* it is acting must not proceed as
      // an ordinary pan-India CSM read — the caller would see cross-zone data under a zone banner.
      expect(res.body.code).toBe('ACTING_NOT_PERMITTED');
    });

    it('stamps acted_as_role = CENTRAL_SERVICE_MANAGER while that zone\'s ZM is out', async () => {
      const token = await login('csm@fsm.test');
      const zoneId = await seededZone();
      await openZmWindow(zoneId);

      const res = await request(app.getHttpServer())
        .get('/api/me')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Acting-As-Zone', String(zoneId))
        .expect(200);

      expect(res.body.acted_as_role).toBe('CENTRAL_SERVICE_MANAGER');
    });
  });

  it('AC2 — an Operations Head may act in any zone, and is still attributed', async () => {
    const token = await login('ops.head@fsm.test');
    const zoneId = await seededZone();

    const res = await request(app.getHttpServer())
      .get('/api/me')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Acting-As-Zone', String(zoneId))
      .expect(200);

    expect(res.body.acted_as_role).toBe('OPERATIONS_HEAD');
  });

  describe('AC3 — an unusable zone is an error, never a silent pan-India read', () => {
    it('rejects a non-numeric zone (400 ACTING_ZONE_INVALID)', async () => {
      const token = await login('csm@fsm.test');
      const res = await request(app.getHttpServer())
        .get('/api/me')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Acting-As-Zone', 'abc')
        .expect(400);
      expect(res.body.code).toBe('ACTING_ZONE_INVALID');
    });

    it('rejects a zone that does not exist (400 ACTING_ZONE_INVALID)', async () => {
      const token = await login('ops.head@fsm.test');
      const res = await request(app.getHttpServer())
        .get('/api/me')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Acting-As-Zone', '999999')
        .expect(400);
      expect(res.body.code).toBe('ACTING_ZONE_INVALID');
    });
  });

  describe('AC7 — the header does not widen a role that cannot act', () => {
    it('leaves a Zonal Manager clamped, header or no header', async () => {
      const token = await login('zm.north@fsm.test');
      const zoneId = await seededZone();
      await openZmWindow(zoneId);

      const res = await request(app.getHttpServer())
        .get('/api/me')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Acting-As-Zone', String(zoneId))
        .expect(200);

      expect(res.body.acted_as_role).toBeNull();
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

  describe('AC5 — entering and leaving acting is on the record', () => {
    it('writes ACTING_STARTED and ACTING_ENDED audit rows carrying the zone', async () => {
      const token = await login('csm@fsm.test');
      const zoneId = await seededZone();
      await openZmWindow(zoneId);

      await request(app.getHttpServer())
        .post('/api/acting/enter')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Acting-As-Zone', String(zoneId))
        .expect(201);

      const started = await prisma.auditLog.findFirstOrThrow({ where: { action: 'ACTING_STARTED' } });
      expect(started.actingZone).toBe(BigInt(zoneId));
      expect(started.actedAsRole).toBe('CENTRAL_SERVICE_MANAGER');
      expect(started.entityType).toBe('zones');

      await request(app.getHttpServer())
        .post('/api/acting/exit')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Acting-As-Zone', String(zoneId))
        .expect(201);

      const ended = await prisma.auditLog.findFirstOrThrow({ where: { action: 'ACTING_ENDED' } });
      expect(ended.actingZone).toBe(BigInt(zoneId));
    });

    it('refuses to record an entry the gate would not have allowed', async () => {
      const token = await login('csm@fsm.test');
      const zoneId = await seededZone();

      // No open window: the gate refuses before the endpoint is reached, so no audit row is written
      // claiming an acting session that never happened.
      await request(app.getHttpServer())
        .post('/api/acting/enter')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Acting-As-Zone', String(zoneId))
        .expect(403);

      expect(await prisma.auditLog.count({ where: { action: 'ACTING_STARTED' } })).toBe(0);
    });
  });

  describe('AC4 (backend half) — the windows are listable and endable', () => {
    it('lists open windows and ends one by id', async () => {
      const token = await login('ops.head@fsm.test');
      const zoneId = await seededZone();
      await openZmWindow(zoneId);

      const list = await request(app.getHttpServer())
        .get('/api/role-unavailability')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const mine = (list.body as { id: string; role: string; zoneId: string | null; open: boolean }[]).find(
        (r) => r.id === String(windows[0]),
      );
      expect(mine).toBeDefined();
      expect(mine!.role).toBe('ZONAL_MANAGER');
      expect(mine!.zoneId).toBe(String(zoneId));
      expect(mine!.open).toBe(true);

      await request(app.getHttpServer())
        .delete(`/api/role-unavailability/${windows[0]}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      // Ended, not deleted: the window is history, and the cascade reads it by time.
      const row = await prisma.roleUnavailability.findUniqueOrThrow({ where: { id: windows[0] } });
      expect(row.windowEnd).not.toBeNull();
      expect(row.windowEnd!.getTime()).toBeLessThanOrEqual(Date.now());

      // …and the CSM can no longer act in that zone, which is the point of ending it.
      const csm = await login('csm@fsm.test');
      await request(app.getHttpServer())
        .get('/api/me')
        .set('Authorization', `Bearer ${csm}`)
        .set('X-Acting-As-Zone', String(zoneId))
        .expect(403);
    });

    it('refuses a Zonal Manager both the list and the end', async () => {
      const token = await login('zm.north@fsm.test');
      const zoneId = await seededZone();
      await openZmWindow(zoneId);

      await request(app.getHttpServer())
        .get('/api/role-unavailability')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
      await request(app.getHttpServer())
        .delete(`/api/role-unavailability/${windows[0]}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });
  });
});
