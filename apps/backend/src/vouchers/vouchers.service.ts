import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import type { ExpenseCategory, VoucherStatus } from '../generated/prisma/enums';
import { AuditService, auditActor } from '../audit/audit.service';
import type { RequestActor } from '../common/request-actor';
import { NotificationService } from '../notifications/notification.service';
import { PrismaService } from '../prisma/prisma.service';
import { drainProducerRows, queueNotification } from '../scheduling/day-plan-notification-outbox';
import { NotificationVoucherNotifier } from './notification-voucher-notifier';
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

/**
 * Review signals on the activity anchor (#359). Every one of these is a *cue for the reviewer*, never
 * a refusal: a voucher whose ticket does not line up is still reviewable — a mis-keyed ticket id is a
 * clerical slip, and the ZM is the one who can tell that from a false claim. Ordered by how strongly
 * the row needs a second look; `warning` carries the first of them.
 */
export type VoucherActivityWarning =
  | 'NO_ACTIVITY_LINK'
  | 'LINKED_TICKET_NOT_FOUND'
  | 'TICKET_NOT_ASSIGNED_TO_SE'
  | 'TICKET_PLANT_MISMATCH';

export interface VoucherActivityCheck {
  linkedTicketId: string | null;
  linkedPlantId: number | null;
  ticketFound: boolean;
  /** The SE the linked ticket is actually assigned to (live batch row first, else the ticket's own assignee). */
  ticketAssignedSeId: string | null;
  /** The plant the linked ticket belongs to — what `linkedPlantId` is checked against. */
  ticketPlantId: number | null;
  /**
   * The headline signal, kept as the single-code field the review queue has always rendered.
   * Always `warnings[0] ?? null`.
   */
  warning: VoucherActivityWarning | null;
  /** Every signal on this row, most serious first. Empty = the claim matches its activity record. */
  warnings: VoucherActivityWarning[];
}

/** What a ticket says about who worked it and where — the facts the ticket match is made against. */
interface TicketMatchFacts {
  plantId: bigint;
  /** Every SE the ticket is live-assigned to: live batch rows plus the ticket's own `assignedSeId`. */
  assignedSeIds: string[];
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

/**
 * Why an id in a mark-PAID batch was not paid (#359). All three are ordinary, expected outcomes of a
 * month's batch — none is an error:
 *  - `NOT_FOUND` — no such voucher.
 *  - `NOT_APPROVED` — the voucher has not cleared the review gate (or is already PAID).
 *  - `SAME_APPROVER` — the actor is the person who approved it. Separation of duties: two money gates,
 *    two people. This is the control the slice exists for, so it is the one skip that is audited.
 */
export type MarkPaidSkipReason = 'NOT_FOUND' | 'NOT_APPROVED' | 'SAME_APPROVER';

/**
 * The result of one mark-PAID batch (#359). Every submitted id lands in exactly one of the three
 * arrays, so the caller can render the batch honestly: `paid` moved, `skipped` was declined by a rule,
 * `failed` hit an infrastructure error and may be retried.
 */
export interface MarkPaidOutcome {
  result: 'OK';
  paid: string[];
  skipped: { voucherId: string; status: VoucherStatus | 'NOT_FOUND'; reason: MarkPaidSkipReason }[];
  failed: { voucherId: string; reason: string }[];
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
  // #361 — `notifier` builds the notice, `notifications` delivers the row the transaction committed.
  // Both are defaulted so the four hand-constructions of this service (`voucher-service.e2e-spec.ts`
  // and its neighbours) keep compiling; DI supplies the container's bindings in the running app.
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(VOUCHER_NOTIFIER) private readonly notifier: VoucherNotifier = new NotificationVoucherNotifier(),
    private readonly notifications: NotificationService = new NotificationService(prisma),
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

    // One batched read for the whole page, not one per row: the ticket-match check needs each linked
    // ticket's plant and its live assignment, and the queue is rendered for a screenful of vouchers.
    const facts = await this.ticketMatchFacts(rows.map((r) => r.ticketId));

    return rows.map((r) => this.toQueueRow(r, facts));
  }

  /**
   * The activity anchor's own facts, keyed by ticket id: which plant the ticket is at, and which SEs
   * it is live-assigned to. "Live-assigned" = a `batch_assignment_tickets` row that has not been
   * removed (a removed row is history — the SE no longer owns that stop), plus the ticket's own
   * `assignedSeId`, which is how RECOVERY work is assigned without a batch. A ticket absent from the
   * map does not exist.
   */
  private async ticketMatchFacts(ticketIds: (string | null)[]): Promise<Map<string, TicketMatchFacts>> {
    const ids = [...new Set(ticketIds.filter((t): t is string => t != null))];
    if (ids.length === 0) return new Map();

    const tickets = await this.prisma.ticket.findMany({
      where: { ticketId: { in: ids } },
      select: {
        ticketId: true,
        plantId: true,
        assignedSeId: true,
        batchTickets: { where: { removedAt: null }, select: { batch: { select: { seId: true } } } },
      },
    });

    return new Map(
      tickets.map((t) => [
        t.ticketId,
        {
          plantId: t.plantId,
          assignedSeIds: [
            ...new Set([...t.batchTickets.map((bt) => bt.batch.seId), ...(t.assignedSeId ? [t.assignedSeId] : [])]),
          ],
        },
      ]),
    );
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

    // #361 — the SE's notice is written INSIDE the review transaction, beside the status change and
    // its audit row. Not after it: this is the site the Voucher Review page has been promising for a
    // year ("the SE is notified"), and a decision that commits while its notice is lost to a crash —
    // or a notice whose failure throws back through a review that already happened — is exactly the
    // pair of failures #338 removed from every other producer.
    const queued = await this.audit.withAudit(
      {
        ...auditActor(actor),
        action: 'VOUCHER_REVIEWED',
        entityType: 'expense_vouchers',
        entityId: voucherId,
        metadata: { action: input.action, notes },
      },
      async (tx) => {
        await tx.expenseVoucher.update({
          where: { voucherId },
          data: { status: next, reviewedBy: actor.userId, reviewedAt: now, reviewNotes: notes },
        });
        return queueNotification(
          tx,
          this.notifier.reviewed({ voucherId, seId: voucher.seId, action: input.action, notes }),
        );
      },
    );

    await drainProducerRows(this.prisma, { notify: this.notifications }, [queued], now);
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
   * after Finance confirms the monthly batch. Each paid SE is notified.
   *
   * **Separation of duties (#359).** A voucher the actor reviewed themselves is skipped with
   * `SAME_APPROVER`: approving and paying are two money gates and one person may not clear both.
   * REVIEW_ROLES deliberately still includes the Operations Head — an OH reviewing a voucher is
   * legitimate; an OH reviewing *and paying the same voucher* is not, and that is the narrower rule
   * enforced here, on the voucher, rather than by taking the review door away from the role.
   *
   * **Per-row isolation, not one batch transaction (#359).** Each voucher is paid in its own audited
   * transaction inside its own try/catch, and a row that blows up lands in `failed[]` while the rest of
   * the batch proceeds. Wrapping the batch in a single `$transaction` was the alternative and was
   * rejected: this is a month's reimbursement run, and one unpayable id (a mis-pasted uuid, a row
   * locked by a concurrent write) must not hold back everyone else's money. The trade is that a batch
   * can end partially applied — which is exactly why every id is reported in `paid` / `skipped` /
   * `failed` and nothing is left to be inferred from a 500.
   */
  async markPaid(
    voucherIds: string[],
    batchRef: string | null,
    actor: RequestActor,
    now: Date = new Date(),
  ): Promise<MarkPaidOutcome> {
    const paid: string[] = [];
    const skipped: MarkPaidOutcome['skipped'] = [];
    const failed: MarkPaidOutcome['failed'] = [];

    for (const voucherId of voucherIds) {
      let queuedNotice: bigint;
      try {
        const voucher = await this.prisma.expenseVoucher.findUnique({ where: { voucherId } });
        if (!voucher) {
          skipped.push({ voucherId, status: 'NOT_FOUND', reason: 'NOT_FOUND' });
          continue;
        }
        if (voucher.status !== 'APPROVED') {
          skipped.push({ voucherId, status: voucher.status, reason: 'NOT_APPROVED' });
          continue;
        }
        if (voucher.reviewedBy === actor.userId) {
          // Audited: a self-payment attempt is the control event, so it leaves a trail even though
          // nothing changed. The other two skips are ordinary batch noise and are not audited.
          await this.audit.record({
            ...auditActor(actor),
            action: 'VOUCHER_MARK_PAID_SKIPPED',
            entityType: 'expense_vouchers',
            entityId: voucherId,
            metadata: { reason: 'SAME_APPROVER', reviewedBy: voucher.reviewedBy, paidBatchRef: batchRef },
          });
          skipped.push({ voucherId, status: voucher.status, reason: 'SAME_APPROVER' });
          continue;
        }

        // #361 — the notice rides the payment's own transaction, per row. The per-row isolation above
        // is preserved exactly: an enqueue that fails rolls back only THIS voucher's payment, which is
        // the same blast radius the row already had, and the rest of the batch proceeds.
        queuedNotice = await this.audit.withAudit(
          {
            ...auditActor(actor),
            action: 'VOUCHER_MARKED_PAID',
            entityType: 'expense_vouchers',
            entityId: voucherId,
            metadata: { paidBatchRef: batchRef },
          },
          async (tx) => {
            await tx.expenseVoucher.update({
              where: { voucherId },
              data: { status: 'PAID', paidAt: now, paidBatchRef: batchRef },
            });
            return queueNotification(tx, this.notifier.paid({ voucherId, seId: voucher.seId, paidBatchRef: batchRef }));
          },
        );
      } catch (err) {
        failed.push({ voucherId, reason: errorReason(err) });
        continue;
      }

      paid.push(voucherId);
      // The payment has committed and its notice is durable. Delivery is attempted now and cannot
      // re-report the row as failed — `drainProducerRows` swallows a delivery failure and un-claims
      // the row for the retry sweep. The money moved either way.
      await drainProducerRows(this.prisma, { notify: this.notifications }, [queuedNotice], now);
    }

    return { result: 'OK', paid, skipped, failed };
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
    facts: Map<string, TicketMatchFacts>,
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

    const activityCheck = this.activityCheck(r.seId, r.ticketId, r.plantId, facts);

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

  /**
   * The ZM's verification cue: does this claim line up with the work record it names? Three questions,
   * in order — does the ticket exist, was it this SE's work, and was it at the plant claimed. Each
   * failure is a *warning*, never a refusal (#359): the reviewer decides what a mismatch means, and
   * blocking submission would only push the claim onto an untracked channel.
   */
  private activityCheck(
    seId: string,
    ticketId: string | null,
    plantId: bigint | null,
    facts: Map<string, TicketMatchFacts>,
  ): VoucherActivityCheck {
    const linkedPlantId = plantId != null ? Number(plantId) : null;

    if (!ticketId) {
      // No ticket at all: a bare plant is still an anchor the ZM can verify; nothing at all is not.
      return {
        linkedTicketId: null,
        linkedPlantId,
        ticketFound: false,
        ticketAssignedSeId: null,
        ticketPlantId: null,
        warning: plantId != null ? null : 'NO_ACTIVITY_LINK',
        warnings: plantId != null ? [] : ['NO_ACTIVITY_LINK'],
      };
    }

    const ticket = facts.get(ticketId);
    if (!ticket) {
      return {
        linkedTicketId: ticketId,
        linkedPlantId,
        ticketFound: false,
        ticketAssignedSeId: null,
        ticketPlantId: null,
        warning: 'LINKED_TICKET_NOT_FOUND',
        warnings: ['LINKED_TICKET_NOT_FOUND'],
      };
    }

    const warnings: VoucherActivityWarning[] = [];
    if (!ticket.assignedSeIds.includes(seId)) warnings.push('TICKET_NOT_ASSIGNED_TO_SE');
    if (linkedPlantId != null && linkedPlantId !== Number(ticket.plantId)) warnings.push('TICKET_PLANT_MISMATCH');

    return {
      linkedTicketId: ticketId,
      linkedPlantId,
      ticketFound: true,
      // The claiming SE first when they are on it, so the queue shows "yes, this SE" rather than an
      // arbitrary co-assignee on a shared stop.
      ticketAssignedSeId: ticket.assignedSeIds.includes(seId) ? seId : (ticket.assignedSeIds[0] ?? null),
      ticketPlantId: Number(ticket.plantId),
      warning: warnings[0] ?? null,
      warnings,
    };
  }
}

/**
 * A short, safe reason string for a `failed[]` row — never the raw error object. Prisma frames its
 * message with the failing invocation and puts the actual cause on the last line, which is the part an
 * Operations Head can act on ("invalid input syntax for type uuid"), so that line is what is kept,
 * prefixed with the error code when there is one.
 */
function errorReason(err: unknown): string {
  const code = err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string'
    ? (err as { code: string }).code
    : null;
  const message = err instanceof Error ? err.message : String(err);
  const detail = message.split('\n').map((l) => l.trim()).filter((l) => l !== '').at(-1) ?? 'UNKNOWN_ERROR';
  return (code ? `${code}: ${detail}` : detail).slice(0, 200);
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
