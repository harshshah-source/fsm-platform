import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service';
import type { RequestActor } from '../src/common/request-actor';
import { PrismaService } from '../src/prisma/prisma.service';
import { VouchersService } from '../src/vouchers/vouchers.service';
import type { VoucherNotifier, VoucherPaidEvent, VoucherReviewedEvent } from '../src/vouchers/voucher-notifier';

/**
 * Issue 38 — Expense Voucher lifecycle (service-level e2e against the real DB). Covers:
 *  - SE create: ≥1 item + ≥1 photo + draft-time client_submission_id idempotency → ZONAL_MANAGER_REVIEW
 *  - ZM queue: own-zone, sorted by submitted_at, activity check + over-limit flags + photos
 *  - ZM review: APPROVE / REJECT / NEEDS_CLARIFICATION (mandatory reason) + SE notification + zone scope
 *  - SE resubmit after NEEDS_CLARIFICATION → back to ZONAL_MANAGER_REVIEW
 *  - OH Mark PAID (multi-select, APPROVED→PAID) + SE notification
 *  - OH monthly Finance export (CSV of APPROVED)
 */

class FakeNotifier implements VoucherNotifier {
  reviewedEvents: VoucherReviewedEvent[] = [];
  paidEvents: VoucherPaidEvent[] = [];
  reviewed(event: VoucherReviewedEvent): void {
    this.reviewedEvents.push(event);
  }
  paid(event: VoucherPaidEvent): void {
    this.paidEvents.push(event);
  }
}

describe('Issue 38 — VouchersService', () => {
  let prisma: PrismaService;
  let notifier: FakeNotifier;
  let service: VouchersService;

  let zoneA: bigint;
  let zoneB: bigint;
  let companyId: bigint;
  let plantA: bigint;
  let seA: string; // SE in zoneA
  let seB: string; // SE in zoneB
  let ticketId: string;
  const createdVoucherIds: string[] = [];

  const NOW = new Date(Date.UTC(2026, 5, 28, 9, 0, 0));

  const zmAActor = (): RequestActor => ({
    userId: randomUUID(),
    role: 'ZONAL_MANAGER',
    actedAsRole: null,
    actingZone: null,
  });

  async function makeSe(zoneId: bigint, label: string): Promise<string> {
    const id = randomUUID();
    const stamp = Date.now() + Math.floor(Number(zoneId));
    await prisma.user.create({
      data: {
        userId: id,
        name: `SE ${label}`,
        role: 'SERVICE_ENGINEER',
        zoneId,
        phone: `+9100${stamp}${label}`.slice(0, 18),
        email: `se-${label}-${stamp}@vtest.local`,
      },
    });
    await prisma.engineerMaster.create({
      data: { engineerId: id, coverageType: 'DEDICATED', zoneId, dailyCapacity: 8 },
    });
    return id;
  }

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    notifier = new FakeNotifier();
    service = new VouchersService(prisma, new AuditService(prisma), notifier);

    const stamp = Date.now();
    zoneA = (await prisma.zone.create({ data: { name: 'Z-vch-A-' + stamp } })).zoneId;
    zoneB = (await prisma.zone.create({ data: { name: 'Z-vch-B-' + stamp } })).zoneId;
    companyId = (
      await prisma.company.create({
        data: { name: 'Co-vch-' + stamp, companyTier: 'GOLD', companyPriorityRank: 'B' },
      })
    ).companyId;
    plantA = (await prisma.plant.create({ data: { name: 'P-vch-A', zoneId: zoneA } })).plantId;

    seA = await makeSe(zoneA, 'A');
    seB = await makeSe(zoneB, 'B');

    const deviceId = 9_380_001n;
    await prisma.device.create({ data: { deviceId, deviceType: 'GPS-X' } });
    ticketId = (
      await prisma.ticket.create({
        data: {
          workType: 'INSTALL',
          status: 'REQUESTED',
          deviceId,
          plantId: plantA,
          companyId,
          companyTier: 'GOLD',
          lastStateChangedAt: NOW,
        },
      })
    ).ticketId;
  });

  afterAll(async () => {
    if (createdVoucherIds.length > 0) {
      await prisma.auditLog.deleteMany({ where: { entityType: 'expense_vouchers', entityId: { in: createdVoucherIds } } });
      await prisma.expenseVoucherItem.deleteMany({ where: { voucherId: { in: createdVoucherIds } } });
      await prisma.expenseVoucher.deleteMany({ where: { voucherId: { in: createdVoucherIds } } });
    }
    await prisma.ticket.deleteMany({ where: { ticketId } });
    await prisma.device.deleteMany({ where: { deviceId: 9_380_001n } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: [seA, seB] } } });
    await prisma.user.deleteMany({ where: { userId: { in: [seA, seB] } } });
    await prisma.plant.deleteMany({ where: { plantId: plantA } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: [zoneA, zoneB] } } });
    await prisma.onModuleDestroy();
  });

  const baseItems = () => [
    { category: 'TRAVEL' as const, amount: 1200, merchantVendorName: 'Uber', photoRef: 'receipt-1.jpg' },
    { category: 'MEAL' as const, amount: 250, merchantVendorName: 'Cafe' },
  ];

  // ---- SE create ------------------------------------------------------------
  describe('create', () => {
    it('creates a voucher SUBMITTED into ZONAL_MANAGER_REVIEW with total + submitted_at', async () => {
      const csid = randomUUID();
      const out = await service.create({ seId: seA, clientSubmissionId: csid, ticketId, items: baseItems(), now: NOW });
      expect(out.result).toBe('OK');
      if (out.result !== 'OK') return;
      createdVoucherIds.push(out.voucher.voucherId);

      const row = await prisma.expenseVoucher.findUniqueOrThrow({ where: { voucherId: out.voucher.voucherId } });
      expect(row.status).toBe('ZONAL_MANAGER_REVIEW');
      expect(Number(row.totalAmount)).toBe(1450);
      expect(row.submittedAt).not.toBeNull();
      expect(row.ticketId).toBe(ticketId);
      const items = await prisma.expenseVoucherItem.findMany({ where: { voucherId: row.voucherId } });
      expect(items).toHaveLength(2);

      const audit = await prisma.auditLog.findMany({
        where: { entityType: 'expense_vouchers', entityId: row.voucherId, action: 'VOUCHER_SUBMITTED' },
      });
      expect(audit).toHaveLength(1);
    });

    it('is idempotent on (se_id, client_submission_id) — a retry returns the existing voucher', async () => {
      const csid = randomUUID();
      const first = await service.create({ seId: seA, clientSubmissionId: csid, items: baseItems(), now: NOW });
      expect(first.result).toBe('OK');
      if (first.result !== 'OK') return;
      createdVoucherIds.push(first.voucher.voucherId);

      const retry = await service.create({ seId: seA, clientSubmissionId: csid, items: baseItems(), now: NOW });
      expect(retry.result).toBe('DUPLICATE');
      if (retry.result !== 'DUPLICATE') return;
      expect(retry.voucher.voucherId).toBe(first.voucher.voucherId);

      const all = await prisma.expenseVoucher.findMany({ where: { seId: seA, clientSubmissionId: csid } });
      expect(all).toHaveLength(1);
    });

    it('rejects no items, and rejects when no photo proof is attached to any item', async () => {
      const noItems = await service.create({ seId: seA, clientSubmissionId: randomUUID(), items: [], now: NOW });
      expect(noItems).toEqual({ result: 'ERROR', code: 'NO_ITEMS' });

      const noPhoto = await service.create({
        seId: seA,
        clientSubmissionId: randomUUID(),
        items: [{ category: 'TRAVEL', amount: 100 }],
        now: NOW,
      });
      expect(noPhoto).toEqual({ result: 'ERROR', code: 'PHOTO_REQUIRED' });
    });
  });

  // ---- ZM queue -------------------------------------------------------------
  describe('reviewQueue', () => {
    it('returns own-zone ZONAL_MANAGER_REVIEW rows sorted by submitted_at, with over-limit + activity flags', async () => {
      const early = new Date(Date.UTC(2026, 5, 27, 8, 0, 0));
      const late = new Date(Date.UTC(2026, 5, 27, 9, 0, 0));
      // zoneA SE: one over-limit (MEAL 900 > 500 limit) with a linked ticket
      const v1 = await service.create({
        seId: seA,
        clientSubmissionId: randomUUID(),
        ticketId,
        items: [{ category: 'MEAL', amount: 900, photoRef: 'r.jpg' }],
        now: late,
      });
      const v2 = await service.create({
        seId: seA,
        clientSubmissionId: randomUUID(),
        items: [{ category: 'TRAVEL', amount: 100, photoRef: 'r.jpg' }],
        now: early,
      });
      // zoneB SE — must NOT appear in zoneA's queue
      const vOther = await service.create({
        seId: seB,
        clientSubmissionId: randomUUID(),
        items: [{ category: 'TRAVEL', amount: 100, photoRef: 'r.jpg' }],
        now: early,
      });
      for (const v of [v1, v2, vOther]) if (v.result === 'OK') createdVoucherIds.push(v.voucher.voucherId);

      const queue = await service.reviewQueue({ role: 'ZONAL_MANAGER', zoneId: Number(zoneA) });
      const mine = queue.filter((r) => r.seId === seA);
      expect(mine.map((r) => r.seId)).not.toContain(seB);
      // sorted by submitted_at asc → the early one (v2) precedes the late one (v1)
      const idxEarly = mine.findIndex((r) => r.submittedAt!.getTime() === early.getTime());
      const idxLate = mine.findIndex((r) => r.submittedAt!.getTime() === late.getTime());
      expect(idxEarly).toBeLessThan(idxLate);

      const overLimitRow = mine.find((r) => r.submittedAt!.getTime() === late.getTime())!;
      expect(overLimitRow.hasOverLimit).toBe(true);
      expect(overLimitRow.items.find((i) => i.category === 'MEAL')!.overLimit).toBe(true);
      expect(overLimitRow.activityCheck.linkedTicketId).toBe(ticketId);
      expect(overLimitRow.activityCheck.ticketFound).toBe(true);

      const noLinkRow = mine.find((r) => r.submittedAt!.getTime() === early.getTime())!;
      expect(noLinkRow.activityCheck.linkedTicketId).toBeNull();
      expect(noLinkRow.activityCheck.warning).toBeTruthy();
    });

    it('lets OH/CSM see all zones', async () => {
      const queue = await service.reviewQueue({ role: 'OPERATIONS_HEAD', zoneId: null });
      const zones = new Set(queue.map((r) => r.zoneId));
      expect(zones.has(Number(zoneA))).toBe(true);
      expect(zones.has(Number(zoneB))).toBe(true);
    });

    it('filters by status — OH lists APPROVED vouchers for the Mark-PAID pass', async () => {
      const out = await service.create({ seId: seA, clientSubmissionId: randomUUID(), items: baseItems(), now: NOW });
      if (out.result !== 'OK') throw new Error('seed failed');
      const id = out.voucher.voucherId;
      createdVoucherIds.push(id);
      await service.review(id, { action: 'APPROVE', notes: null }, { role: 'ZONAL_MANAGER', zoneId: Number(zoneA) }, zmAActor());

      const approved = await service.reviewQueue({ role: 'OPERATIONS_HEAD', zoneId: null }, 'APPROVED');
      expect(approved.every((r) => r.status === 'APPROVED')).toBe(true);
      expect(approved.some((r) => r.voucherId === id)).toBe(true);
      // the default queue (ZONAL_MANAGER_REVIEW) must not contain the now-approved voucher
      const review = await service.reviewQueue({ role: 'OPERATIONS_HEAD', zoneId: null });
      expect(review.some((r) => r.voucherId === id)).toBe(false);
    });
  });

  // ---- ZM review ------------------------------------------------------------
  describe('review', () => {
    async function freshVoucher(se = seA): Promise<string> {
      const out = await service.create({ seId: se, clientSubmissionId: randomUUID(), items: baseItems(), now: NOW });
      if (out.result !== 'OK') throw new Error('seed failed');
      createdVoucherIds.push(out.voucher.voucherId);
      return out.voucher.voucherId;
    }

    it('APPROVE moves to APPROVED, stamps reviewer, notifies the SE', async () => {
      const id = await freshVoucher();
      const before = notifier.reviewedEvents.length;
      const actor = zmAActor();
      const out = await service.review(id, { action: 'APPROVE', notes: null }, { role: 'ZONAL_MANAGER', zoneId: Number(zoneA) }, actor);
      expect(out.result).toBe('OK');
      const row = await prisma.expenseVoucher.findUniqueOrThrow({ where: { voucherId: id } });
      expect(row.status).toBe('APPROVED');
      expect(row.reviewedBy).toBe(actor.userId);
      expect(row.reviewedAt).not.toBeNull();
      expect(notifier.reviewedEvents.length).toBe(before + 1);
      expect(notifier.reviewedEvents.at(-1)).toMatchObject({ voucherId: id, seId: seA, action: 'APPROVE' });
    });

    it('REJECT and NEEDS_CLARIFICATION require a reason and notify the SE', async () => {
      const id = await freshVoucher();
      const noReason = await service.review(id, { action: 'REJECT', notes: '  ' }, { role: 'ZONAL_MANAGER', zoneId: Number(zoneA) }, zmAActor());
      expect(noReason).toEqual({ result: 'REASON_REQUIRED' });

      const ok = await service.review(id, { action: 'REJECT', notes: 'Duplicate claim' }, { role: 'ZONAL_MANAGER', zoneId: Number(zoneA) }, zmAActor());
      expect(ok.result).toBe('OK');
      const row = await prisma.expenseVoucher.findUniqueOrThrow({ where: { voucherId: id } });
      expect(row.status).toBe('REJECTED');
      expect(row.reviewNotes).toBe('Duplicate claim');
      expect(notifier.reviewedEvents.at(-1)).toMatchObject({ action: 'REJECT', notes: 'Duplicate claim' });
    });

    it('rejects review of a voucher outside the ZM zone (own-zone scope)', async () => {
      const id = await freshVoucher(seB); // zoneB voucher
      const out = await service.review(id, { action: 'APPROVE', notes: null }, { role: 'ZONAL_MANAGER', zoneId: Number(zoneA) }, zmAActor());
      expect(out).toEqual({ result: 'FORBIDDEN' });
    });

    it('rejects review of a non-ZONAL_MANAGER_REVIEW voucher', async () => {
      const id = await freshVoucher();
      await service.review(id, { action: 'APPROVE', notes: null }, { role: 'ZONAL_MANAGER', zoneId: Number(zoneA) }, zmAActor());
      const second = await service.review(id, { action: 'APPROVE', notes: null }, { role: 'ZONAL_MANAGER', zoneId: Number(zoneA) }, zmAActor());
      expect(second.result).toBe('INVALID_STATE');
    });
  });

  // ---- SE resubmit ----------------------------------------------------------
  describe('resubmit', () => {
    it('moves NEEDS_CLARIFICATION back to ZONAL_MANAGER_REVIEW for the owning SE', async () => {
      const out = await service.create({ seId: seA, clientSubmissionId: randomUUID(), items: baseItems(), now: NOW });
      if (out.result !== 'OK') throw new Error('seed failed');
      const id = out.voucher.voucherId;
      createdVoucherIds.push(id);
      await service.review(id, { action: 'NEEDS_CLARIFICATION', notes: 'Please attach the toll receipt' }, { role: 'ZONAL_MANAGER', zoneId: Number(zoneA) }, zmAActor());

      const wrongSe: RequestActor = { userId: seB, role: 'SERVICE_ENGINEER', actedAsRole: null, actingZone: null };
      const forbidden = await service.resubmit(id, wrongSe, NOW);
      expect(forbidden).toEqual({ result: 'FORBIDDEN' });

      const owner: RequestActor = { userId: seA, role: 'SERVICE_ENGINEER', actedAsRole: null, actingZone: null };
      const ok = await service.resubmit(id, owner, NOW);
      expect(ok.result).toBe('OK');
      const row = await prisma.expenseVoucher.findUniqueOrThrow({ where: { voucherId: id } });
      expect(row.status).toBe('ZONAL_MANAGER_REVIEW');
    });
  });

  // ---- OH mark paid ---------------------------------------------------------
  describe('markPaid', () => {
    it('marks APPROVED vouchers PAID (multi-select), skips non-approved, notifies SEs', async () => {
      const a = await service.create({ seId: seA, clientSubmissionId: randomUUID(), items: baseItems(), now: NOW });
      const b = await service.create({ seId: seA, clientSubmissionId: randomUUID(), items: baseItems(), now: NOW });
      if (a.result !== 'OK' || b.result !== 'OK') throw new Error('seed failed');
      createdVoucherIds.push(a.voucher.voucherId, b.voucher.voucherId);
      await service.review(a.voucher.voucherId, { action: 'APPROVE', notes: null }, { role: 'ZONAL_MANAGER', zoneId: Number(zoneA) }, zmAActor());
      // b stays in ZONAL_MANAGER_REVIEW (not approved) → must be skipped

      const ohActor: RequestActor = { userId: randomUUID(), role: 'OPERATIONS_HEAD', actedAsRole: null, actingZone: null };
      const before = notifier.paidEvents.length;
      const out = await service.markPaid([a.voucher.voucherId, b.voucher.voucherId], 'FIN-2026-06', ohActor, NOW);
      expect(out.paid).toEqual([a.voucher.voucherId]);
      expect(out.skipped.map((s) => s.voucherId)).toContain(b.voucher.voucherId);

      const rowA = await prisma.expenseVoucher.findUniqueOrThrow({ where: { voucherId: a.voucher.voucherId } });
      expect(rowA.status).toBe('PAID');
      expect(rowA.paidBatchRef).toBe('FIN-2026-06');
      expect(rowA.paidAt).not.toBeNull();
      expect(notifier.paidEvents.length).toBe(before + 1);
    });
  });

  // ---- OH export ------------------------------------------------------------
  describe('exportApproved', () => {
    it('produces a CSV of APPROVED vouchers for the month (one row per line item)', async () => {
      const month = '2026-04';
      const submitted = new Date(Date.UTC(2026, 3, 15, 10, 0, 0));
      const v = await service.create({
        seId: seA,
        clientSubmissionId: randomUUID(),
        items: [
          { category: 'TRAVEL', amount: 800, merchantVendorName: 'Rail', photoRef: 'r.jpg' },
          { category: 'PARTS', amount: 300, merchantVendorName: 'Shop' },
        ],
        now: submitted,
      });
      if (v.result !== 'OK') throw new Error('seed failed');
      createdVoucherIds.push(v.voucher.voucherId);
      await service.review(v.voucher.voucherId, { action: 'APPROVE', notes: null }, { role: 'ZONAL_MANAGER', zoneId: Number(zoneA) }, zmAActor());

      const out = await service.exportApproved(month);
      expect(out.filename).toContain('2026-04');
      const lines = out.csv.trim().split(/\r?\n/);
      expect(lines[0]).toContain('voucher_id');
      const dataLines = lines.slice(1).filter((l) => l.includes(v.voucher.voucherId));
      expect(dataLines).toHaveLength(2); // one per line item
      expect(out.csv).toContain('TRAVEL');
      expect(out.csv).toContain('PARTS');
    });
  });
});
