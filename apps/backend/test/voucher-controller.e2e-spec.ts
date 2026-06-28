import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 38 — Expense Vouchers HTTP surface + RBAC (`/api/vouchers`). Drives the full lifecycle through
 * the controller: SE submit → ZM review queue + approve → OH Finance export → OH Mark PAID, and asserts
 * the role guards (SE owns create/resubmit; ZM/CSM/OH review; OH owns export + mark-paid).
 */
describe('Issue 38 — VouchersController (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const created: string[] = [];

  const monthOf = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  }

  const itemsBody = () => [
    { category: 'TRAVEL', amount: 1200, merchantVendorName: 'Uber', photoRef: 'r1.jpg' },
    { category: 'MEAL', amount: 250 },
  ];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (created.length > 0) {
      await prisma.auditLog.deleteMany({ where: { entityType: 'expense_vouchers', entityId: { in: created } } });
      await prisma.expenseVoucherItem.deleteMany({ where: { voucherId: { in: created } } });
      await prisma.expenseVoucher.deleteMany({ where: { voucherId: { in: created } } });
    }
    await app.close();
  });

  it('rejects an unauthenticated request with 401', async () => {
    await request(app.getHttpServer()).get('/api/vouchers').expect(401);
  });

  it('SE creates a voucher (201, ZONAL_MANAGER_REVIEW); ZM cannot create (403)', async () => {
    const se = await login('se.north@fsm.test');
    const res = await request(app.getHttpServer())
      .post('/api/vouchers')
      .set('Authorization', `Bearer ${se}`)
      .send({ clientSubmissionId: randomUUID(), ticketId: null, items: itemsBody() })
      .expect(201);
    expect(res.body.voucher.status).toBe('ZONAL_MANAGER_REVIEW');
    expect(res.body.voucher.totalAmount).toBe(1450);
    created.push(res.body.voucher.voucherId);

    const zm = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .post('/api/vouchers')
      .set('Authorization', `Bearer ${zm}`)
      .send({ clientSubmissionId: randomUUID(), items: itemsBody() })
      .expect(403);
  });

  it('create with no photo on any item → 400 PHOTO_REQUIRED', async () => {
    const se = await login('se.north@fsm.test');
    const res = await request(app.getHttpServer())
      .post('/api/vouchers')
      .set('Authorization', `Bearer ${se}`)
      .send({ clientSubmissionId: randomUUID(), items: [{ category: 'TRAVEL', amount: 100 }] })
      .expect(400);
    expect(res.body.code).toBe('PHOTO_REQUIRED');
  });

  it('ZM sees the queue; SE cannot read it (403)', async () => {
    const se = await login('se.north@fsm.test');
    const sub = await request(app.getHttpServer())
      .post('/api/vouchers')
      .set('Authorization', `Bearer ${se}`)
      .send({ clientSubmissionId: randomUUID(), items: itemsBody() })
      .expect(201);
    created.push(sub.body.voucher.voucherId);

    const zm = await login('zm.north@fsm.test');
    const queue = await request(app.getHttpServer())
      .get('/api/vouchers')
      .set('Authorization', `Bearer ${zm}`)
      .expect(200);
    expect(queue.body.some((r: { voucherId: string }) => r.voucherId === sub.body.voucher.voucherId)).toBe(true);

    await request(app.getHttpServer()).get('/api/vouchers').set('Authorization', `Bearer ${se}`).expect(403);
  });

  it('runs the full ZM approve → OH export → OH mark-paid lifecycle with RBAC gates', async () => {
    const se = await login('se.north@fsm.test');
    const zm = await login('zm.north@fsm.test');
    const oh = await login('ops.head@fsm.test');

    const sub = await request(app.getHttpServer())
      .post('/api/vouchers')
      .set('Authorization', `Bearer ${se}`)
      .send({ clientSubmissionId: randomUUID(), items: itemsBody() })
      .expect(201);
    const id = sub.body.voucher.voucherId as string;
    created.push(id);

    // REJECT without a reason → 400
    const noReason = await request(app.getHttpServer())
      .post(`/api/vouchers/${id}/review`)
      .set('Authorization', `Bearer ${zm}`)
      .send({ action: 'REJECT' })
      .expect(400);
    expect(noReason.body.code).toBe('REASON_REQUIRED');

    // SE cannot review (403)
    await request(app.getHttpServer())
      .post(`/api/vouchers/${id}/review`)
      .set('Authorization', `Bearer ${se}`)
      .send({ action: 'APPROVE' })
      .expect(403);

    // ZM approves
    const approve = await request(app.getHttpServer())
      .post(`/api/vouchers/${id}/review`)
      .set('Authorization', `Bearer ${zm}`)
      .send({ action: 'APPROVE' })
      .expect(200);
    expect(approve.body.status).toBe('APPROVED');

    // OH Finance export contains the approved voucher; SE/ZM cannot export
    const month = monthOf(new Date());
    await request(app.getHttpServer()).get(`/api/vouchers/export?month=${month}`).set('Authorization', `Bearer ${se}`).expect(403);
    const exp = await request(app.getHttpServer())
      .get(`/api/vouchers/export?month=${month}`)
      .set('Authorization', `Bearer ${oh}`)
      .expect(200);
    expect(exp.headers['content-type']).toContain('text/csv');
    expect(exp.headers['content-disposition']).toContain(`vouchers-finance-${month}.csv`);
    expect(exp.text).toContain(id);

    // OH marks PAID; ZM cannot
    await request(app.getHttpServer())
      .post('/api/vouchers/mark-paid')
      .set('Authorization', `Bearer ${zm}`)
      .send({ voucherIds: [id] })
      .expect(403);
    const paid = await request(app.getHttpServer())
      .post('/api/vouchers/mark-paid')
      .set('Authorization', `Bearer ${oh}`)
      .send({ voucherIds: [id], batchRef: 'FIN-TEST' })
      .expect(200);
    expect(paid.body.paid).toContain(id);

    const row = await prisma.expenseVoucher.findUniqueOrThrow({ where: { voucherId: id } });
    expect(row.status).toBe('PAID');
    expect(row.paidBatchRef).toBe('FIN-TEST');
  });
});
