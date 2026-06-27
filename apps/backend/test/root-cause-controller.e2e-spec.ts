import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 41 slice 3 — `/api/reports/root-cause` HTTP surface. Operations Head recomputes a month, then the
 * report reads the % distribution from `root_cause_summary_monthly`: every documented category zero-filled,
 * filterable by zone/company/plant/device-type/SE/month, ZM zone-scoped, manager-roles only. Seeded:
 * `zm.north` (ZM zone 1), `ops.head`, `se.north`. A unique plant in zone 1 isolates exact numbers.
 */
const NS = Date.now();

describe('Issue 41 slice 3 — /api/reports/root-cause (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let zone1: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let seId: string;
  const userIds: string[] = [];
  const deviceIds: bigint[] = [];
  const cycleIds: string[] = [];
  const ticketIds: string[] = [];
  const submissionIds: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    zone1 = (await prisma.zone.upsert({ where: { zoneId: 1n }, update: {}, create: { zoneId: 1n, name: 'Zone-1-seed' } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-rcc-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-rcc-' + NS, zoneId: zone1 } })).plantId;

    const tag = randomUUID().slice(0, 8);
    const user = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'rcc-' + tag, email: `rcc-${tag}@rcc.test`, zoneId: zone1 },
    });
    seId = user.userId;
    userIds.push(seId);
    await prisma.engineerMaster.create({ data: { engineerId: seId, coverageType: 'DEDICATED', zoneId: zone1, dailyCapacity: 10 } });

    // 3 POWER + 1 SIM in May → total 4 → POWER 75%, SIM 25%.
    for (let i = 0; i < 3; i++) await addSubmission('POWER_ISSUE', new Date(Date.UTC(2026, 4, 5 + i)));
    await addSubmission('SIM_NETWORK_ISSUE', new Date(Date.UTC(2026, 4, 10)));
  });

  afterAll(async () => {
    await prisma.rootCauseSummaryMonthly.deleteMany({ where: { plantId } });
    await prisma.troubleshootingSubmission.deleteMany({ where: { submissionId: { in: submissionIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { cycleId: { in: cycleIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await app.close();
  });

  async function addSubmission(category: 'POWER_ISSUE' | 'SIM_NETWORK_ISSUE', submittedAt: Date): Promise<void> {
    const deviceId = BigInt(9_413_000_000 + deviceIds.length + (NS % 1000));
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId, deviceType: 'GPS-X' } });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: submittedAt } });
    cycleIds.push(cycle.cycleId);
    const ticket = await prisma.ticket.create({
      data: { workType: 'TROUBLESHOOT', status: 'OPEN', failureCycleId: cycle.cycleId, deviceId, plantId, companyId, companyTier: 'GOLD', lastStateChangedAt: submittedAt },
    });
    ticketIds.push(ticket.ticketId);
    const sub = await prisma.troubleshootingSubmission.create({
      data: {
        ticketId: ticket.ticketId,
        failureCycleId: cycle.cycleId,
        submissionType: 'TROUBLESHOOTING_FORM',
        clientSubmissionId: randomUUID(),
        seId,
        presenceSource: 'NONE',
        rootCauseCategory: category,
        submittedAt,
      },
    });
    submissionIds.push(sub.submissionId);
  }

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-password' }).expect(200);
    return res.body.accessToken as string;
  };

  it('Operations Head recomputes May, then the per-plant distribution shows the exact %', async () => {
    const oh = await login('ops.head@fsm.test');
    const recompute = await request(app.getHttpServer())
      .post('/api/reports/root-cause/recompute?month=2026-05')
      .set('Authorization', `Bearer ${oh}`)
      .expect(200);
    expect(recompute.body.month).toBe('2026-05-01');
    expect(recompute.body.submissions).toBeGreaterThanOrEqual(4);

    const report = await request(app.getHttpServer())
      .get(`/api/reports/root-cause?from=2026-05&to=2026-05&plantId=${plantId}`)
      .set('Authorization', `Bearer ${oh}`)
      .expect(200);
    expect(report.body.totalSubmissions).toBe(4);
    expect(report.body.distribution).toHaveLength(10);
    const byCat = Object.fromEntries(report.body.distribution.map((d: { category: string }) => [d.category, d]));
    expect(byCat.POWER_ISSUE.pct).toBe(75);
    expect(byCat.SIM_NETWORK_ISSUE.pct).toBe(25);
    expect(byCat.GPS_ANTENNA_ISSUE.count).toBe(0);
  });

  it('a ZM sees their own zone (zone 1) data', async () => {
    const zm = await login('zm.north@fsm.test');
    const report = await request(app.getHttpServer())
      .get(`/api/reports/root-cause?from=2026-05&to=2026-05&plantId=${plantId}`)
      .set('Authorization', `Bearer ${zm}`)
      .expect(200);
    expect(report.body.totalSubmissions).toBe(4);
    expect(report.body.filters.zoneId).toBe(1);
  });

  it('forbids a Service Engineer (403)', async () => {
    const se = await login('se.north@fsm.test');
    await request(app.getHttpServer()).get('/api/reports/root-cause?from=2026-05&to=2026-05').set('Authorization', `Bearer ${se}`).expect(403);
  });

  it('forbids a ZM from triggering recompute — Operations Head only (403)', async () => {
    const zm = await login('zm.north@fsm.test');
    await request(app.getHttpServer()).post('/api/reports/root-cause/recompute?month=2026-05').set('Authorization', `Bearer ${zm}`).expect(403);
  });

  it('rejects an invalid month (400)', async () => {
    const oh = await login('ops.head@fsm.test');
    await request(app.getHttpServer()).get('/api/reports/root-cause?from=2026-13').set('Authorization', `Bearer ${oh}`).expect(400);
  });
});
