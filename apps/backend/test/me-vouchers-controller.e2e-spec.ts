import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/auth/token.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * #163 item 1 — `GET /api/me/vouchers`, the SE-readable variant of the manager-only `GET /vouchers`
 * review queue. Today the SE creates (`POST /vouchers`) and resubmits blind — there is no read path
 * back at all. Fields per the issue's own field-level derivation + `docs/ui/mobile/vouchers.png`:
 * `plantName` (the manager row only carries a numeric `plantId`), `reviewNotes` + reviewer name (the
 * rejection reason the SE must act on to resubmit), and the KPI rollups the screen renders
 * (₹ claimed total, pending count, approved count).
 */
const NS = Date.now();

describe('#163 item 1 — GET /api/me/vouchers (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: TokenService;

  let zoneId: bigint;
  let plantId: bigint;
  let se: string;
  let seOther: string;
  const userIds: string[] = [];
  const voucherIds: string[] = [];

  const seToken = () => tokens.signAccessToken({ user_id: se, role: 'SERVICE_ENGINEER', zone_id: Number(zoneId) });
  const otherSeToken = () => tokens.signAccessToken({ user_id: seOther, role: 'SERVICE_ENGINEER', zone_id: Number(zoneId) });

  const itemsBody = () => [{ category: 'TRAVEL', amount: 1200, merchantVendorName: 'Uber', photoRef: 'r1.jpg' }];

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-password' }).expect(200);
    return res.body.accessToken as string;
  }

  async function createVoucher(token: string, plant?: bigint): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/vouchers')
      .set('Authorization', `Bearer ${token}`)
      .send({ clientSubmissionId: randomUUID(), plantId: plant != null ? Number(plant) : null, items: itemsBody() })
      .expect(201);
    voucherIds.push(res.body.voucher.voucherId as string);
    return res.body.voucher.voucherId as string;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-mv-' + NS } })).zoneId;
    plantId = (await prisma.plant.create({ data: { name: 'P-mv-' + NS, zoneId } })).plantId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({ data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'mv-' + tag, email: `${tag}@mv.test`, zoneId } });
    se = u.userId;
    userIds.push(se);
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });

    const tagO = randomUUID().slice(0, 8);
    const uO = await prisma.user.create({ data: { name: 'SE Other ' + tagO, role: 'SERVICE_ENGINEER', phone: 'mv-o-' + tagO, email: `${tagO}@mv.test`, zoneId } });
    seOther = uO.userId;
    userIds.push(seOther);
    await prisma.engineerMaster.create({ data: { engineerId: seOther, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { entityType: 'expense_vouchers', entityId: { in: voucherIds } } });
    await prisma.expenseVoucherItem.deleteMany({ where: { voucherId: { in: voucherIds } } });
    await prisma.expenseVoucher.deleteMany({ where: { voucherId: { in: voucherIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await app.close();
  });

  it("lists the caller's own vouchers — pending, approved, and rejected-with-reviewer — never another SE's", async () => {
    const pendingId = await createVoucher(seToken());
    const approvedId = await createVoucher(seToken(), plantId);
    const rejectedId = await createVoucher(seToken());
    await createVoucher(otherSeToken()); // never appears in `se`'s list

    const ohToken = await login('ops.head@fsm.test');
    await request(app.getHttpServer())
      .post(`/api/vouchers/${approvedId}/review`)
      .set('Authorization', `Bearer ${ohToken}`)
      .send({ action: 'APPROVE' })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/vouchers/${rejectedId}/review`)
      .set('Authorization', `Bearer ${ohToken}`)
      .send({ action: 'REJECT', notes: 'Missing receipt' })
      .expect(200);

    const res = await request(app.getHttpServer())
      .get('/api/me/vouchers')
      .set('Authorization', `Bearer ${seToken()}`)
      .expect(200);

    const byId = new Map((res.body.items as Array<Record<string, unknown>>).map((r) => [r.voucherId, r]));
    expect(byId.size).toBe(3);
    expect(byId.has(pendingId)).toBe(true);

    const approvedRow = byId.get(approvedId)!;
    expect(approvedRow.status).toBe('APPROVED');
    expect(approvedRow.plantId).toBe(Number(plantId));
    expect(approvedRow.plantName).toBe('P-mv-' + NS);
    expect(approvedRow.reviewerName).toBe('Operations Head');

    const rejectedRow = byId.get(rejectedId)!;
    expect(rejectedRow.status).toBe('REJECTED');
    expect(rejectedRow.reviewNotes).toBe('Missing receipt');
    expect(rejectedRow.reviewerName).toBe('Operations Head');
    expect(Array.isArray(rejectedRow.items)).toBe(true);
    expect((rejectedRow.items as Array<{ amount: number }>)[0].amount).toBe(1200);

    expect(res.body.summary.claimedTotal).toBe(3600); // se's own 3 vouchers x 1200 (seOther's excluded)
    expect(res.body.summary.pendingCount).toBe(1);
    expect(res.body.summary.approvedCount).toBe(1);
    expect(res.body.cursor).toBeNull();
  });

  it('forbids a non-SE role', async () => {
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer()).get('/api/me/vouchers').set('Authorization', `Bearer ${token}`).expect(403);
  });

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer()).get('/api/me/vouchers').expect(401);
  });
});
