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
 *
 * Issue 359 — the money-path controls layered on top of that lifecycle:
 *  - separation of duties: the reviewer of a voucher cannot also mark it paid (SAME_APPROVER skip, audited)
 *  - batch safety: every id lands in exactly one of paid / skipped / failed; a bad id never throws
 *  - ticket match: the activity check joins ticket → assignment SE + plant and warns rather than refusing
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
  let plantB: bigint;
  let seA: string; // SE in zoneA
  let seB: string; // SE in zoneB
  let ticketId: string; // at plantA, assigned to nobody
  let assignedTicketId: string; // at plantA, live batch row for seA
  let scheduleId: bigint;
  let batchId: bigint;
  const createdVoucherIds: string[] = [];

  const NOW = new Date(Date.UTC(2026, 5, 28, 9, 0, 0));

  const zmAActor = (): RequestActor => ({
    userId: randomUUID(),
    role: 'ZONAL_MANAGER',
    actedAsRole: null,
    actingZone: null,
    zoneId: null,
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
    plantB = (await prisma.plant.create({ data: { name: 'P-vch-B', zoneId: zoneA } })).plantId;

    seA = await makeSe(zoneA, 'A');
    seB = await makeSe(zoneB, 'B');

    const deviceId = '9380001';
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

    // #359 — a second ticket at plantA that IS on seA's Day Plan (live batch row), so the ticket-match
    // check has both shapes to read: assigned-to-this-SE and assigned-to-nobody.
    await prisma.device.create({ data: { deviceId: '9380002', deviceType: 'GPS-X' } });
    assignedTicketId = (
      await prisma.ticket.create({
        data: {
          workType: 'INSTALL',
          status: 'REQUESTED',
          deviceId: '9380002',
          plantId: plantA,
          companyId,
          companyTier: 'GOLD',
          lastStateChangedAt: NOW,
        },
      })
    ).ticketId;
    scheduleId = (
      await prisma.workSchedule.create({
        data: { seId: seA, zoneId: zoneA, dateFrom: NOW, dateTo: NOW },
      })
    ).scheduleId;
    batchId = (
      await prisma.plantBatchAssignment.create({
        data: { scheduleId, plantId: plantA, seId: seA, stopSequence: 1 },
      })
    ).batchId;
    await prisma.batchAssignmentTicket.create({
      data: { batchId, ticketId: assignedTicketId, sortOrder: 1 },
    });
  });

  afterAll(async () => {
    if (createdVoucherIds.length > 0) {
      await prisma.auditLog.deleteMany({ where: { entityType: 'expense_vouchers', entityId: { in: createdVoucherIds } } });
      await prisma.expenseVoucherItem.deleteMany({ where: { voucherId: { in: createdVoucherIds } } });
      await prisma.expenseVoucher.deleteMany({ where: { voucherId: { in: createdVoucherIds } } });
    }
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId } });
    await prisma.plantBatchAssignment.deleteMany({ where: { batchId } });
    await prisma.workSchedule.deleteMany({ where: { scheduleId } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: [ticketId, assignedTicketId] } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: ['9380001', '9380002'] } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: [seA, seB] } } });
    await prisma.user.deleteMany({ where: { userId: { in: [seA, seB] } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [plantA, plantB] } } });
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

    // ---- #359 ticket match --------------------------------------------------
    it('warns TICKET_NOT_ASSIGNED_TO_SE when the linked ticket was never assigned to the claiming SE', async () => {
      const out = await service.create({
        seId: seA,
        clientSubmissionId: randomUUID(),
        ticketId, // exists, but no batch row and no assignedSeId
        items: baseItems(),
        now: NOW,
      });
      if (out.result !== 'OK') throw new Error('seed failed');
      createdVoucherIds.push(out.voucher.voucherId);

      const row = (await service.reviewQueue({ role: 'ZONAL_MANAGER', zoneId: Number(zoneA) })).find(
        (r) => r.voucherId === out.voucher.voucherId,
      )!;
      expect(row.activityCheck.ticketFound).toBe(true);
      expect(row.activityCheck.warnings).toContain('TICKET_NOT_ASSIGNED_TO_SE');
      expect(row.activityCheck.warning).toBe('TICKET_NOT_ASSIGNED_TO_SE');
      expect(row.activityCheck.ticketAssignedSeId).toBeNull();
    });

    it('clears the warning when the linked ticket sits on the SE own live batch row', async () => {
      const out = await service.create({
        seId: seA,
        clientSubmissionId: randomUUID(),
        ticketId: assignedTicketId,
        plantId: plantA,
        items: baseItems(),
        now: NOW,
      });
      if (out.result !== 'OK') throw new Error('seed failed');
      createdVoucherIds.push(out.voucher.voucherId);

      const row = (await service.reviewQueue({ role: 'ZONAL_MANAGER', zoneId: Number(zoneA) })).find(
        (r) => r.voucherId === out.voucher.voucherId,
      )!;
      expect(row.activityCheck.ticketAssignedSeId).toBe(seA);
      expect(row.activityCheck.warnings).toEqual([]);
      expect(row.activityCheck.warning).toBeNull();
    });

    it('warns TICKET_PLANT_MISMATCH when the claimed plant is not the ticket plant', async () => {
      const out = await service.create({
        seId: seA,
        clientSubmissionId: randomUUID(),
        ticketId: assignedTicketId, // ticket is at plantA
        plantId: plantB, // claim says plantB
        items: baseItems(),
        now: NOW,
      });
      if (out.result !== 'OK') throw new Error('seed failed');
      createdVoucherIds.push(out.voucher.voucherId);

      const row = (await service.reviewQueue({ role: 'ZONAL_MANAGER', zoneId: Number(zoneA) })).find(
        (r) => r.voucherId === out.voucher.voucherId,
      )!;
      expect(row.activityCheck.warnings).toEqual(['TICKET_PLANT_MISMATCH']);
      expect(row.activityCheck.ticketPlantId).toBe(Number(plantA));
      expect(row.activityCheck.linkedPlantId).toBe(Number(plantB));
    });

    it('still warns LINKED_TICKET_NOT_FOUND, and never refuses the row for a warning', async () => {
      const out = await service.create({
        seId: seA,
        clientSubmissionId: randomUUID(),
        ticketId: randomUUID(), // no such ticket
        items: baseItems(),
        now: NOW,
      });
      if (out.result !== 'OK') throw new Error('seed failed');
      createdVoucherIds.push(out.voucher.voucherId);

      const row = (await service.reviewQueue({ role: 'ZONAL_MANAGER', zoneId: Number(zoneA) })).find(
        (r) => r.voucherId === out.voucher.voucherId,
      )!;
      expect(row.activityCheck.ticketFound).toBe(false);
      expect(row.activityCheck.warnings).toEqual(['LINKED_TICKET_NOT_FOUND']);
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

      const wrongSe: RequestActor = { userId: seB, role: 'SERVICE_ENGINEER', actedAsRole: null, actingZone: null, zoneId: null };
      const forbidden = await service.resubmit(id, wrongSe, NOW);
      expect(forbidden).toEqual({ result: 'FORBIDDEN' });

      const owner: RequestActor = { userId: seA, role: 'SERVICE_ENGINEER', actedAsRole: null, actingZone: null, zoneId: null };
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

      const ohActor: RequestActor = { userId: randomUUID(), role: 'OPERATIONS_HEAD', actedAsRole: null, actingZone: null, zoneId: null };
      const before = notifier.paidEvents.length;
      const out = await service.markPaid([a.voucher.voucherId, b.voucher.voucherId], 'FIN-2026-06', ohActor, NOW);
      expect(out.paid).toEqual([a.voucher.voucherId]);
      expect(out.skipped.map((s) => s.voucherId)).toContain(b.voucher.voucherId);

      const rowA = await prisma.expenseVoucher.findUniqueOrThrow({ where: { voucherId: a.voucher.voucherId } });
      expect(rowA.status).toBe('PAID');
      expect(rowA.paidBatchRef).toBe('FIN-2026-06');
      expect(rowA.paidAt).not.toBeNull();
      expect(notifier.paidEvents.length).toBe(before + 1);
      expect(out.failed).toEqual([]);
      expect(out.skipped.find((s) => s.voucherId === b.voucher.voucherId)!.reason).toBe('NOT_APPROVED');
    });

    // ---- #359 separation of duties -----------------------------------------
    it('skips SAME_APPROVER: the person who approved a voucher cannot also mark it paid, and the skip is audited', async () => {
      const v = await service.create({ seId: seA, clientSubmissionId: randomUUID(), items: baseItems(), now: NOW });
      if (v.result !== 'OK') throw new Error('seed failed');
      const id = v.voucher.voucherId;
      createdVoucherIds.push(id);

      // one Operations Head clears BOTH money gates: approve then pay
      const oh: RequestActor = { userId: randomUUID(), role: 'OPERATIONS_HEAD', actedAsRole: null, actingZone: null, zoneId: null };
      await service.review(id, { action: 'APPROVE', notes: null }, { role: 'OPERATIONS_HEAD', zoneId: null }, oh);

      const before = notifier.paidEvents.length;
      const out = await service.markPaid([id], 'FIN-2026-07', oh, NOW);
      expect(out.paid).toEqual([]);
      expect(out.skipped).toEqual([{ voucherId: id, status: 'APPROVED', reason: 'SAME_APPROVER' }]);
      expect(out.failed).toEqual([]);
      expect(notifier.paidEvents.length).toBe(before); // no payment, so no SE notice

      const row = await prisma.expenseVoucher.findUniqueOrThrow({ where: { voucherId: id } });
      expect(row.status).toBe('APPROVED'); // untouched
      expect(row.paidAt).toBeNull();

      const audit = await prisma.auditLog.findMany({
        where: { entityType: 'expense_vouchers', entityId: id, action: 'VOUCHER_MARK_PAID_SKIPPED' },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0].metadata).toMatchObject({ reason: 'SAME_APPROVER' });
      expect(audit[0].actorId).toBe(oh.userId);
    });

    it('lets a different Operations Head pay a voucher the first one approved', async () => {
      const v = await service.create({ seId: seA, clientSubmissionId: randomUUID(), items: baseItems(), now: NOW });
      if (v.result !== 'OK') throw new Error('seed failed');
      const id = v.voucher.voucherId;
      createdVoucherIds.push(id);

      const approver: RequestActor = { userId: randomUUID(), role: 'OPERATIONS_HEAD', actedAsRole: null, actingZone: null, zoneId: null };
      const payer: RequestActor = { userId: randomUUID(), role: 'OPERATIONS_HEAD', actedAsRole: null, actingZone: null, zoneId: null };
      await service.review(id, { action: 'APPROVE', notes: null }, { role: 'OPERATIONS_HEAD', zoneId: null }, approver);

      const out = await service.markPaid([id], 'FIN-2026-07', payer, NOW);
      expect(out.paid).toEqual([id]);
      expect((await prisma.expenseVoucher.findUniqueOrThrow({ where: { voucherId: id } })).status).toBe('PAID');
    });

    // ---- #359 batch safety --------------------------------------------------
    it('reports every id in exactly one of paid / skipped / failed, and one bad id does not block the batch', async () => {
      const a = await service.create({ seId: seA, clientSubmissionId: randomUUID(), items: baseItems(), now: NOW });
      const b = await service.create({ seId: seA, clientSubmissionId: randomUUID(), items: baseItems(), now: NOW });
      if (a.result !== 'OK' || b.result !== 'OK') throw new Error('seed failed');
      createdVoucherIds.push(a.voucher.voucherId, b.voucher.voucherId);
      await service.review(a.voucher.voucherId, { action: 'APPROVE', notes: null }, { role: 'ZONAL_MANAGER', zoneId: Number(zoneA) }, zmAActor());
      // b stays in ZONAL_MANAGER_REVIEW → skipped NOT_APPROVED

      const missing = randomUUID(); // well-formed, no such row → skipped NOT_FOUND
      const malformed = 'not-a-uuid'; // blows up in the DB layer → failed, not a 500
      const oh: RequestActor = { userId: randomUUID(), role: 'OPERATIONS_HEAD', actedAsRole: null, actingZone: null, zoneId: null };

      // the bad id goes FIRST: a month's batch must survive it
      const ids = [malformed, a.voucher.voucherId, b.voucher.voucherId, missing];
      const out = await service.markPaid(ids, 'FIN-2026-08', oh, NOW);

      expect(out.paid).toEqual([a.voucher.voucherId]);
      expect(out.skipped.map((s) => s.voucherId).sort()).toEqual([b.voucher.voucherId, missing].sort());
      expect(out.failed.map((f) => f.voucherId)).toEqual([malformed]);
      expect(out.failed[0].reason).toBeTruthy();

      // every id accounted for exactly once
      const reported = [...out.paid, ...out.skipped.map((s) => s.voucherId), ...out.failed.map((f) => f.voucherId)];
      expect(reported.sort()).toEqual([...ids].sort());
      expect(new Set(reported).size).toBe(ids.length);

      expect((await prisma.expenseVoucher.findUniqueOrThrow({ where: { voucherId: a.voucher.voucherId } })).status).toBe('PAID');
      expect(out.skipped.find((s) => s.voucherId === missing)!.reason).toBe('NOT_FOUND');
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
