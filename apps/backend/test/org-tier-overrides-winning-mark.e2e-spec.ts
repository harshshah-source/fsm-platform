import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 157, Slice 5 — the monthly active-overrides report read marks the WINNING override per
 * (company, zone) pair (AC-6, the open half). "Winning" is the live effective override: the newest
 * ACTIVE row whose `expiresAt` has not passed (Q-A newest-wins) — the exact predicate the engine
 * resolves at (`effective-tier.ts`), never the swept `status` flag. The report is a truthful
 * mirror of what the recommender would actually apply, so the mark must reuse that predicate rather
 * than re-derive precedence.
 */
const NS = Date.now();

describe('Issue 157 Slice 5 — /api/org/tier-overrides winning-override mark (AC-6)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let companyId: number;
  let northZoneId: number;
  let southZoneId: number;
  const companyName = `TierWin-${NS}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    northZoneId = Number((await prisma.zone.findUniqueOrThrow({ where: { name: 'North' } })).zoneId);
    southZoneId = Number((await prisma.zone.findUniqueOrThrow({ where: { name: 'South' } })).zoneId);

    const oh = await login('ops.head@fsm.test');
    companyId = (
      await request(app.getHttpServer())
        .post('/api/org/companies')
        .set('Authorization', `Bearer ${oh}`)
        .send({ name: companyName, companyTier: 'SILVER', companyPriorityRank: 'C' })
        .expect(201)
    ).body.companyId;
  });

  afterAll(async () => {
    await prisma.companyTierOverride.deleteMany({ where: { companyId: BigInt(companyId) } });
    await prisma.auditLog.deleteMany({ where: { entityType: 'company_tier_overrides', entityId: { contains: `${companyId}:` } } });
    await prisma.auditLog.deleteMany({ where: { entityType: 'company_master', entityId: companyName } });
    await prisma.company.deleteMany({ where: { name: companyName } });
    await app.close();
  });

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-password' }).expect(200);
    return res.body.accessToken as string;
  }

  function futureIso(daysFromNow: number): string {
    return new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000).toISOString();
  }

  async function createOverride(token: string, tier: string, reason: string): Promise<string> {
    return (
      await request(app.getHttpServer())
        .post('/api/org/tier-overrides')
        .set('Authorization', `Bearer ${token}`)
        .send({ companyId, zoneId: northZoneId, tier, reason, expiresAt: futureIso(30) })
        .expect(201)
    ).body.id as string;
  }

  it('marks only the newest live override for a (company, zone) pair as winning', async () => {
    const oh = await login('ops.head@fsm.test');
    const olderId = await createOverride(oh, 'GOLD', 'Older stacked override on North for the pair');
    const newerId = await createOverride(oh, 'PLATINUM', 'Newer stacked override — this one wins');

    const rows: Array<{ id: string; companyId: number; isWinning: boolean }> = (
      await request(app.getHttpServer())
        .get(`/api/org/tier-overrides?zoneId=${northZoneId}&status=ACTIVE`)
        .set('Authorization', `Bearer ${oh}`)
        .expect(200)
    ).body;

    const mine = rows.filter((r) => r.companyId === companyId);
    const newer = mine.find((r) => r.id === newerId);
    const older = mine.find((r) => r.id === olderId);
    expect(newer?.isWinning).toBe(true);
    expect(older?.isWinning).toBe(false);
  });

  it('never marks an ACTIVE-but-expired override as winning, even when it is the newest by createdAt', async () => {
    const now = Date.now();
    // Winner: older by createdAt, but live. Loser: newest by createdAt, but already past expiresAt with
    // status still ACTIVE (the sweep has not run yet) — a naive "newest ACTIVE" would wrongly pick it.
    const live = await prisma.companyTierOverride.create({
      data: {
        companyId: BigInt(companyId),
        zoneId: BigInt(southZoneId),
        tier: 'GOLD',
        reason: 'Live override on South — the real winner',
        status: 'ACTIVE',
        createdAt: new Date(now - 20 * 60 * 1000),
        expiresAt: new Date(now + 30 * 24 * 60 * 60 * 1000),
      },
    });
    const expiredButNewest = await prisma.companyTierOverride.create({
      data: {
        companyId: BigInt(companyId),
        zoneId: BigInt(southZoneId),
        tier: 'PLATINUM',
        reason: 'Newest by createdAt but already lapsed — must not win',
        status: 'ACTIVE',
        createdAt: new Date(now - 5 * 60 * 1000),
        expiresAt: new Date(now - 60 * 1000),
      },
    });

    const oh = await login('ops.head@fsm.test');
    const rows: Array<{ id: string; companyId: number; isWinning: boolean }> = (
      await request(app.getHttpServer())
        .get(`/api/org/tier-overrides?zoneId=${southZoneId}&status=ACTIVE`)
        .set('Authorization', `Bearer ${oh}`)
        .expect(200)
    ).body;

    const mine = rows.filter((r) => r.companyId === companyId);
    expect(mine.find((r) => r.id === live.id.toString())?.isWinning).toBe(true);
    expect(mine.find((r) => r.id === expiredButNewest.id.toString())?.isWinning).toBe(false);
  });

  it('under a month filter, marks winning by the LIVE winner — a superseded row from an earlier month is not winning', async () => {
    // North already carries this month's live winner (the PLATINUM override from the first test).
    // Add a still-live override created in a PRIOR month; filtering the report to that month returns
    // only this row, and it must NOT be marked winning because the live winner sits outside the filter.
    const now = Date.now();
    const created = new Date(now - 40 * 24 * 60 * 60 * 1000);
    const priorMonth = await prisma.companyTierOverride.create({
      data: {
        companyId: BigInt(companyId),
        zoneId: BigInt(northZoneId),
        tier: 'GOLD',
        reason: 'Created last month, still live, but since superseded on North',
        status: 'ACTIVE',
        createdAt: created,
        expiresAt: new Date(now + 15 * 24 * 60 * 60 * 1000),
      },
    });
    const monthStr = `${created.getUTCFullYear()}-${String(created.getUTCMonth() + 1).padStart(2, '0')}`;

    const oh = await login('ops.head@fsm.test');
    const rows: Array<{ id: string; companyId: number; isWinning: boolean }> = (
      await request(app.getHttpServer())
        .get(`/api/org/tier-overrides?zoneId=${northZoneId}&month=${monthStr}`)
        .set('Authorization', `Bearer ${oh}`)
        .expect(200)
    ).body;

    const mine = rows.filter((r) => r.companyId === companyId);
    // The filter returned the prior-month row (and only it, for this company)…
    expect(mine.map((r) => r.id)).toContain(priorMonth.id.toString());
    // …but it is not the live winner, so it is not marked winning.
    expect(mine.find((r) => r.id === priorMonth.id.toString())?.isWinning).toBe(false);
  });
});
