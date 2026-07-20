import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 90 — `/api/reports/work-type-mix` + `/api/reports/verification-outcomes`. Read-only ticket /
 * verification-run aggregations for the two gated Reports-landing panels. Exact numbers are isolated
 * via the spec's own (unique) company filter; zone scoping is proven by seeding the same company into
 * zone 1 (the ZM's) and a second fresh zone — the ZM must see only zone 1's share.
 * Seeded logins: `zm.north` (ZM zone 1), `ops.head`, `se.north`.
 */
const JUNE = (day: number) => new Date(Date.UTC(2026, 5, day));
const WINDOW = 'from=2026-06-01&to=2026-06-30';

describe('Issue 90 — work-type-mix + verification-outcomes (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let companyId: bigint;
  let plant1: bigint; // zone 1 (the ZM's zone)
  let plant2: bigint; // the fresh other zone
  let zone2: bigint;
  const deviceId = String(9_090_000n + BigInt(Math.floor(Math.random() * 1000)));
  const ticketIds: string[] = [];
  const runIds: string[] = [];
  const cycleIds: string[] = [];

  /** Minimal ticket row; a TROUBLESHOOT ticket must anchor a failure cycle (DB CHECK). */
  const seedTicket = async (workType: 'TROUBLESHOOT' | 'INSTALL' | 'RECOVERY', plantId: bigint, createdAt: Date) => {
    let failureCycleId: string | undefined;
    if (workType === 'TROUBLESHOOT') {
      // VERIFIED + closed: only one LIVE cycle may exist per device, and this spec seeds several.
      const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'VERIFIED', openedAt: createdAt, closedAt: createdAt } });
      cycleIds.push(cycle.cycleId);
      failureCycleId = cycle.cycleId;
    }
    const t = await prisma.ticket.create({
      data: { workType, status: 'OPEN', failureCycleId, deviceId, plantId, companyId, companyTier: 'GOLD', lastStateChangedAt: createdAt, createdAt },
    });
    ticketIds.push(t.ticketId);
    return t.ticketId;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    const stamp = Date.now();
    await prisma.zone.upsert({ where: { zoneId: 1n }, update: {}, create: { zoneId: 1n, name: 'Zone-1-seed' } });
    zone2 = (await prisma.zone.create({ data: { name: 'Z-mix-' + stamp } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-mix-' + stamp, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plant1 = (await prisma.plant.create({ data: { name: 'P-mix-1-' + stamp, zoneId: 1n } })).plantId;
    plant2 = (await prisma.plant.create({ data: { name: 'P-mix-2-' + stamp, zoneId: zone2 } })).plantId;
    await prisma.device.create({ data: { deviceId, deviceType: 'GPS-X' } });

    // Zone 1: 2× TROUBLESHOOT + 1× INSTALL. Zone 2: 1× RECOVERY. RECOVERY exists only cross-zone,
    // so the ZM's mix zero-fills it while the Operations Head counts it.
    const ts1 = await seedTicket('TROUBLESHOOT', plant1, JUNE(5));
    const ts2 = await seedTicket('TROUBLESHOOT', plant1, JUNE(10));
    await seedTicket('INSTALL', plant1, JUNE(12));
    await seedTicket('RECOVERY', plant2, JUNE(15));
    // Outside the queried window — must never be counted.
    await seedTicket('TROUBLESHOOT', plant1, new Date(Date.UTC(2026, 3, 1)));

    // Verification runs: zone 1 gets CLOSED + PARTIAL_RECOVERY + a pending (null outcome, fraud-flagged);
    // zone 2 gets FAILED_VERIFICATION.
    const run = async (ticketId: string, startedAt: Date, outcome: 'CLOSED' | 'FAILED_VERIFICATION' | 'PARTIAL_RECOVERY' | null, fraudFlag = false) => {
      const r = await prisma.verificationRun.create({
        data: { ticketId, deviceId, startedAt, outcome, outcomeAt: outcome ? startedAt : null, fraudFlag },
      });
      runIds.push(r.runId);
    };
    await run(ts1, JUNE(6), 'CLOSED');
    await run(ts2, JUNE(11), 'PARTIAL_RECOVERY');
    await run(ts2, JUNE(12), null, true);
    await run(ticketIds[3], JUNE(16), 'FAILED_VERIFICATION');
    // Outside the window.
    await run(ts1, new Date(Date.UTC(2026, 3, 2)), 'CLOSED');
  });

  afterAll(async () => {
    await prisma.verificationRun.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { cycleId: { in: cycleIds } } });
    await prisma.device.deleteMany({ where: { deviceId } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [plant1, plant2] } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId: zone2 } });
    await app.close();
  });

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-password' }).expect(200);
    return res.body.accessToken as string;
  };

  const counts = (rows: Array<Record<string, unknown>>, key: 'workType' | 'outcome') =>
    new Map(rows.map((r) => [r[key] as string, r.count as number]));

  it('Operations Head sees the cross-zone work-type mix, zero-fill included and window enforced', async () => {
    const oh = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get(`/api/reports/work-type-mix?${WINDOW}&companyId=${companyId}`)
      .set('Authorization', `Bearer ${oh}`)
      .expect(200);

    expect(res.body.total).toBe(4);
    const byType = counts(res.body.rows, 'workType');
    expect(byType.get('TROUBLESHOOT')).toBe(2);
    expect(byType.get('INSTALL')).toBe(1);
    expect(byType.get('RECOVERY')).toBe(1);
    // Every work type is always present (zero-filled, canonical order).
    expect(res.body.rows.map((r: { workType: string }) => r.workType)).toEqual(['TROUBLESHOOT', 'INSTALL', 'RECOVERY']);
  });

  it('a ZM is pinned to their own zone — zone 2 work never leaks in', async () => {
    const zm = await login('zm.north@fsm.test');
    const res = await request(app.getHttpServer())
      .get(`/api/reports/work-type-mix?${WINDOW}&companyId=${companyId}`)
      .set('Authorization', `Bearer ${zm}`)
      .expect(200);

    expect(res.body.total).toBe(3);
    const byType = counts(res.body.rows, 'workType');
    expect(byType.get('TROUBLESHOOT')).toBe(2);
    expect(byType.get('INSTALL')).toBe(1);
    expect(byType.get('RECOVERY')).toBe(0);
  });

  it('Operations Head sees the cross-zone verification-outcome distribution with PENDING + fraud count', async () => {
    const oh = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get(`/api/reports/verification-outcomes?${WINDOW}&companyId=${companyId}`)
      .set('Authorization', `Bearer ${oh}`)
      .expect(200);

    expect(res.body.total).toBe(4);
    expect(res.body.fraudFlagged).toBe(1);
    const byOutcome = counts(res.body.rows, 'outcome');
    expect(byOutcome.get('CLOSED')).toBe(1);
    expect(byOutcome.get('PARTIAL_RECOVERY')).toBe(1);
    expect(byOutcome.get('FAILED_VERIFICATION')).toBe(1);
    expect(byOutcome.get('PENDING')).toBe(1);
    // Zero-filled outcomes still present.
    expect(byOutcome.get('CLOSED_AUTO_RECOVERY')).toBe(0);
  });

  it('a ZM sees only their own zone’s verification runs', async () => {
    const zm = await login('zm.north@fsm.test');
    const res = await request(app.getHttpServer())
      .get(`/api/reports/verification-outcomes?${WINDOW}&companyId=${companyId}`)
      .set('Authorization', `Bearer ${zm}`)
      .expect(200);

    expect(res.body.total).toBe(3);
    const byOutcome = counts(res.body.rows, 'outcome');
    expect(byOutcome.get('FAILED_VERIFICATION')).toBe(0);
    expect(byOutcome.get('PENDING')).toBe(1);
  });

  it('forbids a Service Engineer on both endpoints (403)', async () => {
    const se = await login('se.north@fsm.test');
    await request(app.getHttpServer()).get(`/api/reports/work-type-mix?${WINDOW}`).set('Authorization', `Bearer ${se}`).expect(403);
    await request(app.getHttpServer()).get(`/api/reports/verification-outcomes?${WINDOW}`).set('Authorization', `Bearer ${se}`).expect(403);
  });

  it('rejects an invalid day and a reversed range (400)', async () => {
    const oh = await login('ops.head@fsm.test');
    await request(app.getHttpServer()).get('/api/reports/work-type-mix?from=2026-13-01').set('Authorization', `Bearer ${oh}`).expect(400);
    await request(app.getHttpServer())
      .get('/api/reports/verification-outcomes?from=2026-06-30&to=2026-06-01')
      .set('Authorization', `Bearer ${oh}`)
      .expect(400);
  });
});
