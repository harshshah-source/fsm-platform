import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 157, Slice 2 — `/api/org/tier-overrides` (AC-2). CSM/ZM authority extension over the
 * OH-owned global company tier (#46): mandatory reason (min 10 chars), expiry <= 2 months, a
 * ZONAL_MANAGER clamped to their own zone (the zone travels in the body, not `:zoneId`/`zone_id`
 * that `ZoneScopeGuard` reads — the #102 install-scope precedent), every mutation audited, and
 * stacking (Q-A) — multiple ACTIVE overrides for the same (company, zone) never conflict.
 */
const NS = Date.now();

describe('Issue 157 Slice 2 — /api/org/tier-overrides', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let companyId: number;
  let northZoneId: number;
  let southZoneId: number;
  const companyName = `TierOv-${NS}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    const north = await prisma.zone.findUniqueOrThrow({ where: { name: 'North' } });
    const south = await prisma.zone.findUniqueOrThrow({ where: { name: 'South' } });
    northZoneId = Number(north.zoneId);
    southZoneId = Number(south.zoneId);

    const oh = await login('ops.head@fsm.test');
    const created = await request(app.getHttpServer())
      .post('/api/org/companies')
      .set('Authorization', `Bearer ${oh}`)
      .send({ name: companyName, companyTier: 'SILVER', companyPriorityRank: 'C' })
      .expect(201);
    companyId = created.body.companyId;
  });

  afterAll(async () => {
    await prisma.companyTierOverride.deleteMany({ where: { companyId: BigInt(companyId) } });
    await prisma.auditLog.deleteMany({ where: { entityType: 'company_tier_overrides', entityId: { contains: `${companyId}:` } } });
    await prisma.auditLog.deleteMany({ where: { entityType: 'company_master', entityId: companyName } });
    await prisma.company.deleteMany({ where: { name: companyName } });
    await app.close();
  });

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  }

  function futureIso(daysFromNow: number): string {
    return new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000).toISOString();
  }

  it('lets Operations Head create a zone-scoped override, audited TIER_OVERRIDE_SET', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .post('/api/org/tier-overrides')
      .set('Authorization', `Bearer ${token}`)
      .send({
        companyId,
        zoneId: northZoneId,
        tier: 'PLATINUM',
        reason: 'Escalated by regional sales for Q3 campaign',
        expiresAt: futureIso(30),
      })
      .expect(201);
    expect(res.body.tier).toBe('PLATINUM');
    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.zoneId).toBe(northZoneId);

    const audits = await prisma.auditLog.findMany({
      where: { entityType: 'company_tier_overrides', action: 'TIER_OVERRIDE_SET', entityId: `${companyId}:${northZoneId}` },
    });
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const metadata = audits[audits.length - 1].metadata as Record<string, unknown>;
    expect(metadata.prevEffectiveTier).toBe('SILVER');
    expect(metadata.newTier).toBe('PLATINUM');
  });

  it('permits lowering a tier, not just raising it (Q-G)', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .post('/api/org/tier-overrides')
      .set('Authorization', `Bearer ${token}`)
      .send({
        companyId,
        zoneId: southZoneId,
        tier: 'SILVER',
        reason: 'Demoting this account for a scoped period',
        expiresAt: futureIso(30),
      })
      .expect(201);
    expect(res.body.tier).toBe('SILVER');
  });

  it('lets CSM create an override in a zone other than any home zone (Q-C cross-zone)', async () => {
    const token = await login('csm@fsm.test');
    await request(app.getHttpServer())
      .post('/api/org/tier-overrides')
      .set('Authorization', `Bearer ${token}`)
      .send({
        companyId,
        zoneId: southZoneId,
        tier: 'GOLD',
        reason: 'CSM cross-zone override for a stalled account',
        expiresAt: futureIso(10),
      })
      .expect(201);
  });

  it("clamps a ZM to their own zone: North succeeds, South is 403 (zm.north's home zone is North)", async () => {
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .post('/api/org/tier-overrides')
      .set('Authorization', `Bearer ${token}`)
      .send({
        companyId,
        zoneId: northZoneId,
        tier: 'GOLD',
        reason: 'ZM North raising this account for the quarter',
        expiresAt: futureIso(5),
      })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/org/tier-overrides')
      .set('Authorization', `Bearer ${token}`)
      .send({
        companyId,
        zoneId: southZoneId,
        tier: 'GOLD',
        reason: 'ZM North should not be able to do this',
        expiresAt: futureIso(5),
      })
      .expect(403);
  });

  it('allows stacking — a second ACTIVE override for the same (company, zone) does not conflict (Q-A)', async () => {
    const token = await login('ops.head@fsm.test');
    await request(app.getHttpServer())
      .post('/api/org/tier-overrides')
      .set('Authorization', `Bearer ${token}`)
      .send({ companyId, zoneId: northZoneId, tier: 'GOLD', reason: 'First stacked override on North', expiresAt: futureIso(20) })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/org/tier-overrides')
      .set('Authorization', `Bearer ${token}`)
      .send({ companyId, zoneId: northZoneId, tier: 'PLATINUM', reason: 'Second stacked override on North', expiresAt: futureIso(20) })
      .expect(201);

    const active = await prisma.companyTierOverride.findMany({
      where: { companyId: BigInt(companyId), zoneId: BigInt(northZoneId), status: 'ACTIVE' },
    });
    expect(active.length).toBeGreaterThanOrEqual(2);
  });

  it.each([
    ['a reason under 10 characters', { reason: 'short' }],
    ['an unknown tier', { tier: 'DIAMOND' }],
    ['an expiry more than 2 months out', { expiresAt: futureIso(90) }],
    ['an expiry in the past', { expiresAt: futureIso(-1) }],
  ])('400s on %s', async (_label, override) => {
    const token = await login('ops.head@fsm.test');
    await request(app.getHttpServer())
      .post('/api/org/tier-overrides')
      .set('Authorization', `Bearer ${token}`)
      .send({
        companyId,
        zoneId: northZoneId,
        tier: 'PLATINUM',
        reason: 'A perfectly adequate reason for this override',
        expiresAt: futureIso(30),
        ...override,
      })
      .expect(400);
  });

  it('400s an unknown company', async () => {
    const token = await login('ops.head@fsm.test');
    await request(app.getHttpServer())
      .post('/api/org/tier-overrides')
      .set('Authorization', `Bearer ${token}`)
      .send({ companyId: 999999999, zoneId: northZoneId, tier: 'PLATINUM', reason: 'Reason long enough here', expiresAt: futureIso(30) })
      .expect(400);
  });

  it('cancels an ACTIVE override (audited TIER_OVERRIDE_CANCELLED); re-cancelling is 400; unknown id is 404', async () => {
    const token = await login('ops.head@fsm.test');
    const created = await request(app.getHttpServer())
      .post('/api/org/tier-overrides')
      .set('Authorization', `Bearer ${token}`)
      .send({ companyId, zoneId: northZoneId, tier: 'GOLD', reason: 'Override created only to be cancelled', expiresAt: futureIso(15) })
      .expect(201);
    const id = created.body.id;

    await request(app.getHttpServer())
      .delete(`/api/org/tier-overrides/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);

    const row = await prisma.companyTierOverride.findUniqueOrThrow({ where: { id: BigInt(id) } });
    expect(row.status).toBe('CANCELLED');
    const audits = await prisma.auditLog.findMany({
      where: { entityType: 'company_tier_overrides', action: 'TIER_OVERRIDE_CANCELLED', entityId: id },
    });
    expect(audits.length).toBe(1);

    await request(app.getHttpServer())
      .delete(`/api/org/tier-overrides/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(400);

    await request(app.getHttpServer())
      .delete('/api/org/tier-overrides/999999999')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it("forbids a ZM from cancelling another zone's override", async () => {
    const oh = await login('ops.head@fsm.test');
    const created = await request(app.getHttpServer())
      .post('/api/org/tier-overrides')
      .set('Authorization', `Bearer ${oh}`)
      .send({ companyId, zoneId: southZoneId, tier: 'GOLD', reason: 'South override a North ZM cannot cancel', expiresAt: futureIso(15) })
      .expect(201);

    const zm = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .delete(`/api/org/tier-overrides/${created.body.id}`)
      .set('Authorization', `Bearer ${zm}`)
      .expect(403);
  });

  it('scopes the list read to a ZM\'s own zone regardless of a requested zoneId, but not for OH', async () => {
    const zm = await login('zm.north@fsm.test');
    const zmView = await request(app.getHttpServer())
      .get(`/api/org/tier-overrides?companyId=${companyId}&zoneId=${southZoneId}`)
      .set('Authorization', `Bearer ${zm}`)
      .expect(200);
    expect(zmView.body.every((r: { zoneId: number }) => r.zoneId === northZoneId)).toBe(true);

    const oh = await login('ops.head@fsm.test');
    const ohView = await request(app.getHttpServer())
      .get(`/api/org/tier-overrides?zoneId=${southZoneId}`)
      .set('Authorization', `Bearer ${oh}`)
      .expect(200);
    expect(ohView.body.some((r: { zoneId: number }) => r.zoneId === southZoneId)).toBe(true);
    expect(ohView.body.every((r: { zoneId: number }) => r.zoneId === southZoneId)).toBe(true);
  });

  it('rejects a Service Engineer with 403 on every route', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer())
      .post('/api/org/tier-overrides')
      .set('Authorization', `Bearer ${token}`)
      .send({ companyId, zoneId: northZoneId, tier: 'GOLD', reason: 'Should never be created by an SE', expiresAt: futureIso(5) })
      .expect(403);
    await request(app.getHttpServer())
      .get('/api/org/tier-overrides')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });
});
