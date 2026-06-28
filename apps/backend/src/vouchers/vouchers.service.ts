import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import type { ExpenseCategory, VoucherStatus } from '../generated/prisma/enums';
import { AuditService, auditActor } from '../audit/audit.service';
import type { RequestActor } from '../common/request-actor';
import { PrismaService } from '../prisma/prisma.service';
import { VOUCHER_NOTIFIER, type VoucherNotifier } from './voucher-notifier';

/**
 * Per-category soft limits (INR). Advisory only — they drive the ZM "over-limit row in red" review
 * cue (PRD §29). Not schema-enforced; a future Issue can move these to `system_settings`. Kept here
 * as the single source so the API and the admin UI agree on what counts as over-limit.
 */
export const CATEGORY_LIMITS: Record<ExpenseCategory, number> = {
  TRAVEL: 5000,
  ACCOMMODATION: 3000,
  PARTS: 10000,
  TOOLS: 5000,
  MEAL: 500,
  OTHER: 2000,
};

const MANAGER_ALL_ZONE_ROLES = new Set(['CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD']);

export interface CreateVoucherItemInput {
  category: ExpenseCategory;
  amount: number;
  merchantVendorName?: string | null;
  expenseDatetime?: Date | null;
  photoRef?: string | null;
}

export interface CreateVoucherInput {
  seId: string;
  clientSubmissionId: string;
  plantId?: bigint | null;
  ticketId?: string | null;
  vehicleId?: bigint | null;
  items: CreateVoucherItemInput[];
  now?: Date;
}

export interface VoucherView {
  voucherId: string;
  seId: string;
  clientSubmissionId: string;
  status: VoucherStatus;
  totalAmount: number;
  submittedAt: Date | null;
}

export type CreateVoucherOutcome =
  | { result: 'OK'; duplicate: false; voucher: VoucherView }
  | { result: 'DUPLICATE'; duplicate: true; voucher: VoucherView }
  | { result: 'ERROR'; code: 'NO_ITEMS' | 'PHOTO_REQUIRED' | 'INVALID_AMOUNT' | 'SE_NOT_FOUND' };

export interface VoucherItemView {
  itemId: string;
  category: ExpenseCategory;
  amount: number;
  merchantVendorName: string | null;
  expenseDatetime: Date | null;
  photoRef: string | null;
  limit: number;
  overLimit: boolean;
}

export interface VoucherActivityCheck {
  linkedTicketId: string | null;
  linkedPlantId: number | null;
  ticketFound: boolean;
  /** Set when the ZM has no automatic activity anchor to verify against. */
  warning: string | null;
}

export interface VoucherQueueRow {
  voucherId: string;
  seId: string;
  seName: string;
  zoneId: number;
  status: VoucherStatus;
  plantId: number | null;
  ticketId: string | null;
  vehicleId: number | null;
  totalAmount: number;
  submittedAt: Date | null;
  reviewNotes: string | null;
  items: VoucherItemView[];
  hasOverLimit: boolean;
  activityCheck: VoucherActivityCheck;
}

export type ReviewAction = 'APPROVE' | 'REJECT' | 'NEEDS_CLARIFICATION';

export interface ReviewInput {
  action: ReviewAction;
  notes?: string | null;
}

export type ReviewOutcome =
  | { result: 'OK'; status: VoucherStatus }
  | { result: 'NOT_FOUND' }
  | { result: 'FORBIDDEN' }
  | { result: 'INVALID_STATE'; status: VoucherStatus }
  | { result: 'REASON_REQUIRED' };

export type ResubmitOutcome =
  | { result: 'OK' }
  | { result: 'NOT_FOUND' }
  | { result: 'FORBIDDEN' }
  | { result: 'INVALID_STATE'; status: VoucherStatus };

export interface MarkPaidOutcome {
  result: 'OK';
  paid: string[];
  skipped: { voucherId: string; status: VoucherStatus | 'NOT_FOUND' }[];
}

export interface ExportResult {
  filename: string;
  csv: string;
}

const STATUS_NEEDS_REASON: ReadonlySet<ReviewAction> = new Set(['REJECT', 'NEEDS_CLARIFICATION']);

const ACTION_TO_STATUS: Record<ReviewAction, VoucherStatus> = {
  APPROVE: 'APPROVED',
  REJECT: 'REJECTED',
  NEEDS_CLARIFICATION: 'NEEDS_CLARIFICATION',
};

@Injectable()
export class VouchersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(VOUCHER_NOTIFIER) private readonly notifier: VoucherNotifier,
  ) {}

  /**
   * SE submit (POST /api/vouchers). The mobile app drafts offline with a draft-time
   * `client_submission_id`; the server lands the claim straight into the ZM review queue. Idempotent
   * on `(se_id, client_submission_id)` — a retry returns the already-created voucher untouched.
   */
  async create(input: CreateVoucherInput): Promise<CreateVoucherOutcome> {
    const now = input.now ?? new Date();

    if (input.items.length === 0) return { result: 'ERROR', code: 'NO_ITEMS' };
    if (input.items.some((i) => !Number.isFinite(i.amount) || i.amount < 0)) {
      return { result: 'ERROR', code: 'INVALID_AMOUNT' };
    }
    if (!input.items.some((i) => typeof i.photoRef === 'string' && i.photoRef.trim() !== '')) {
      return { result: 'ERROR', code: 'PHOTO_REQUIRED' };
    }

    const existing = await this.prisma.expenseVoucher.findUnique({
      where: { seId_clientSubmissionId: { seId: input.seId, clientSubmissionId: input.clientSubmissionId } },
    });
    if (existing) return { result: 'DUPLICATE', duplicate: true, voucher: this.toView(existing) };

    const se = await this.prisma.engineerMaster.findUnique({ where: { engineerId: input.seId } });
    if (!se) return { result: 'ERROR', code: 'SE_NOT_FOUND' };

    const total = input.items.reduce((sum, i) => sum + i.amount, 0);
    const voucherId = randomUUID(); // pre-generated so the audit row references the real id in-tx

    const row = await this.audit.withAudit(
      {
        actorId: input.seId,
        actorRole: 'SERVICE_ENGINEER',
        action: 'VOUCHER_SUBMITTED',
        entityType: 'expense_vouchers',
        entityId: voucherId,
        metadata: { itemCount: input.items.length, total },
      },
      (tx) =>
        tx.expenseVoucher.create({
          data: {
            voucherId,
            seId: input.seId,
            clientSubmissionId: input.clientSubmissionId,
            status: 'ZONAL_MANAGER_REVIEW',
            plantId: input.plantId ?? null,
            ticketId: input.ticketId ?? null,
            vehicleId: input.vehicleId ?? null,
            totalAmount: new Prisma.Decimal(total),
            submittedAt: now,
            items: {
              create: input.items.map((i) => ({
                category: i.category,
                amount: new Prisma.Decimal(i.amount),
                merchantVendorName: i.merchantVendorName ?? null,
                expenseDatetime: i.expenseDatetime ?? null,
                photoRef: i.photoRef ?? null,
              })),
            },
          },
        }),
    );

    return { result: 'OK', duplicate: false, voucher: this.toView(row) };
  }

  /**
   * ZM review queue (GET /api/vouchers). Status = ZONAL_MANAGER_REVIEW, sorted by submitted_at. ZM
   * sees own zone; CSM / Operations Head see all zones. Each row carries the per-item over-limit flag
   * and the activity check (the linked Ticket the ZM verifies against, or a warning when none).
   */
  async reviewQueue(
    viewer: { role: string; zoneId: number | null },
    status: VoucherStatus = 'ZONAL_MANAGER_REVIEW',
  ): Promise<VoucherQueueRow[]> {
    const allZones = MANAGER_ALL_ZONE_ROLES.has(viewer.role);
    const where: Prisma.ExpenseVoucherWhereInput = { status };
    if (!allZones) {
      where.engineer = { zoneId: viewer.zoneId == null ? -1n : BigInt(viewer.zoneId) };
    }

    const rows = await this.prisma.expenseVoucher.findMany({
      where,
      orderBy: { submittedAt: 'asc' },
      include: { items: true, engineer: { include: { user: true } } },
    });

    const ticketIds = rows.map((r) => r.ticketId).filter((t): t is string => t != null);
    const foundTickets = ticketIds.length
      ? new Set(
          (await this.prisma.ticket.findMany({ where: { ticketId: { in: ticketIds } }, select: { ticketId: true } })).map(
            (t) => t.ticketId,
          ),
        )
      : new Set<string>();

    return rows.map((r) => this.toQueueRow(r, foundTickets));
  }

  async review(
    voucherId: string,
    input: ReviewInput,
    viewer: { role: string; zoneId: number | null },
    actor: RequestActor,
  ): Promise<ReviewOutcome> {
    const notes = input.notes?.trim() ? input.notes.trim() : null;
    if (STATUS_NEEDS_REASON.has(input.action) && !notes) return { result: 'REASON_REQUIRED' };

    const voucher = await this.prisma.expenseVoucher.findUnique({
      where: { voucherId },
      include: { engineer: true },
    });
    if (!voucher) return { result: 'NOT_FOUND' };
    if (actor.userId === voucher.seId) return { result: 'FORBIDDEN' }; // SE cannot self-approve
    if (
      !MANAGER_ALL_ZONE_ROLES.has(viewer.role) &&
      viewer.zoneId != null &&
      Number(voucher.engineer.zoneId) !== viewer.zoneId
    ) {
      return { result: 'FORBIDDEN' };
    }
    if (voucher.status !== 'ZONAL_MANAGER_REVIEW') return { result: 'INVALID_STATE', status: voucher.status };

    const next = ACTION_TO_STATUS[input.action];
    const now = new Date();

    await this.audit.withAudit(
      {
        ...auditActor(actor),
        action: 'VOUCHER_REVIEWED',
        entityType: 'expense_vouchers',
        entityId: voucherId,
        metadata: { action: input.action, notes },
      },
      (tx) =>
        tx.expenseVoucher.update({
          where: { voucherId },
          data: { status: next, reviewedBy: actor.userId, reviewedAt: now, reviewNotes: notes },
        }),
    );

    await this.notifier.reviewed({ voucherId, seId: voucher.seId, action: input.action, notes });
    return { result: 'OK', status: next };
  }

  /** SE resubmit after NEEDS_CLARIFICATION → back to ZONAL_MANAGER_REVIEW (owning SE only). */
  async resubmit(voucherId: string, actor: RequestActor, now: Date = new Date()): Promise<ResubmitOutcome> {
    const voucher = await this.prisma.expenseVoucher.findUnique({ where: { voucherId } });
    if (!voucher) return { result: 'NOT_FOUND' };
    if (voucher.seId !== actor.userId) return { result: 'FORBIDDEN' };
    if (voucher.status !== 'NEEDS_CLARIFICATION') return { result: 'INVALID_STATE', status: voucher.status };

    await this.audit.withAudit(
      {
        ...auditActor(actor),
        action: 'VOUCHER_RESUBMITTED',
        entityType: 'expense_vouchers',
        entityId: voucherId,
      },
      (tx) =>
        tx.expenseVoucher.update({
          where: { voucherId },
          data: { status: 'ZONAL_MANAGER_REVIEW', submittedAt: now },
        }),
    );
    return { result: 'OK' };
  }

  /**
   * Operations-Head Mark PAID (POST /api/vouchers/mark-paid). Multi-select over APPROVED vouchers
   * after Finance confirms the monthly batch. Non-APPROVED ids are skipped (not an error). Each paid
   * SE is notified.
   */
  async markPaid(
    voucherIds: string[],
    batchRef: string | null,
    actor: RequestActor,
    now: Date = new Date(),
  ): Promise<MarkPaidOutcome> {
    const paid: string[] = [];
    const skipped: { voucherId: string; status: VoucherStatus | 'NOT_FOUND' }[] = [];

    for (const voucherId of voucherIds) {
      const voucher = await this.prisma.expenseVoucher.findUnique({ where: { voucherId } });
      if (!voucher) {
        skipped.push({ voucherId, status: 'NOT_FOUND' });
        continue;
      }
      if (voucher.status !== 'APPROVED') {
        skipped.push({ voucherId, status: voucher.status });
        continue;
      }
      await this.audit.withAudit(
        {
          ...auditActor(actor),
          action: 'VOUCHER_MARKED_PAID',
          entityType: 'expense_vouchers',
          entityId: voucherId,
          metadata: { paidBatchRef: batchRef },
        },
        (tx) =>
          tx.expenseVoucher.update({
            where: { voucherId },
            data: { status: 'PAID', paidAt: now, paidBatchRef: batchRef },
          }),
      );
      await this.notifier.paid({ voucherId, seId: voucher.seId, paidBatchRef: batchRef });
      paid.push(voucherId);
    }

    return { result: 'OK', paid, skipped };
  }

  /**
   * Operations-Head monthly Finance export (GET /api/vouchers/export?month=YYYY-MM). All APPROVED
   * vouchers whose `submitted_at` falls in the month, one CSV row per line item (voucher header
   * columns repeated) — the shape Finance imports for batch reimbursement. No PAID side effect; the
   * OH marks PAID separately after Finance confirms (CONTEXT §Expense Vouchers — no v1 integration).
   */
  async exportApproved(month: string): Promise<ExportResult> {
    const [start, end] = monthRange(month);
    const rows = await this.prisma.expenseVoucher.findMany({
      where: { status: 'APPROVED', submittedAt: { gte: start, lt: end } },
      orderBy: { submittedAt: 'asc' },
      include: { items: true, engineer: { include: { user: true } } },
    });

    const header = [
      'voucher_id',
      'se_id',
      'se_name',
      'zone_id',
      'plant_id',
      'ticket_id',
      'vehicle_id',
      'status',
      'submitted_at',
      'voucher_total',
      'category',
      'amount',
      'merchant_vendor_name',
      'expense_datetime',
    ];
    const lines: string[] = [header.join(',')];
    for (const v of rows) {
      const items = v.items.length > 0 ? v.items : [null];
      for (const item of items) {
        lines.push(
          [
            v.voucherId,
            v.seId,
            v.engineer.user.name,
            String(v.engineer.zoneId),
            v.plantId != null ? String(v.plantId) : '',
            v.ticketId ?? '',
            v.vehicleId != null ? String(v.vehicleId) : '',
            v.status,
            v.submittedAt ? v.submittedAt.toISOString() : '',
            v.totalAmount.toString(),
            item ? item.category : '',
            item ? item.amount.toString() : '',
            item?.merchantVendorName ?? '',
            item?.expenseDatetime ? item.expenseDatetime.toISOString() : '',
          ]
            .map(csvCell)
            .join(','),
        );
      }
    }

    return { filename: `vouchers-finance-${month}.csv`, csv: lines.join('\r\n') + '\r\n' };
  }

  private toView(row: {
    voucherId: string;
    seId: string;
    clientSubmissionId: string;
    status: VoucherStatus;
    totalAmount: Prisma.Decimal;
    submittedAt: Date | null;
  }): VoucherView {
    return {
      voucherId: row.voucherId,
      seId: row.seId,
      clientSubmissionId: row.clientSubmissionId,
      status: row.status,
      totalAmount: Number(row.totalAmount),
      submittedAt: row.submittedAt,
    };
  }

  private toQueueRow(
    r: Prisma.ExpenseVoucherGetPayload<{ include: { items: true; engineer: { include: { user: true } } } }>,
    foundTickets: Set<string>,
  ): VoucherQueueRow {
    const items: VoucherItemView[] = r.items.map((i) => {
      const limit = CATEGORY_LIMITS[i.category];
      const amount = Number(i.amount);
      return {
        itemId: String(i.itemId),
        category: i.category,
        amount,
        merchantVendorName: i.merchantVendorName,
        expenseDatetime: i.expenseDatetime,
        photoRef: i.photoRef,
        limit,
        overLimit: amount > limit,
      };
    });

    const activityCheck = this.activityCheck(r.ticketId, r.plantId, foundTickets);

    return {
      voucherId: r.voucherId,
      seId: r.seId,
      seName: r.engineer.user.name,
      zoneId: Number(r.engineer.zoneId),
      status: r.status,
      plantId: r.plantId != null ? Number(r.plantId) : null,
      ticketId: r.ticketId,
      vehicleId: r.vehicleId != null ? Number(r.vehicleId) : null,
      totalAmount: Number(r.totalAmount),
      submittedAt: r.submittedAt,
      reviewNotes: r.reviewNotes,
      items,
      hasOverLimit: items.some((i) => i.overLimit),
      activityCheck,
    };
  }

  private activityCheck(ticketId: string | null, plantId: bigint | null, foundTickets: Set<string>): VoucherActivityCheck {
    if (ticketId) {
      const ticketFound = foundTickets.has(ticketId);
      return {
        linkedTicketId: ticketId,
        linkedPlantId: plantId != null ? Number(plantId) : null,
        ticketFound,
        warning: ticketFound ? null : 'LINKED_TICKET_NOT_FOUND',
      };
    }
    return {
      linkedTicketId: null,
      linkedPlantId: plantId != null ? Number(plantId) : null,
      ticketFound: false,
      warning: plantId != null ? null : 'NO_ACTIVITY_LINK',
    };
  }
}

/** [start, end) for a YYYY-MM month in UTC. */
function monthRange(month: string): [Date, Date] {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new Error(`Invalid month "${month}" — expected YYYY-MM`);
  const year = Number(m[1]);
  const mon = Number(m[2]) - 1;
  return [new Date(Date.UTC(year, mon, 1)), new Date(Date.UTC(year, mon + 1, 1))];
}

/** RFC-4180-ish CSV cell: quote when the value contains a comma, quote, or newline. */
function csvCell(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}
