import { Injectable } from '@nestjs/common';
import type { ExpenseCategory, VoucherStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { CATEGORY_LIMITS } from './vouchers.service';

const DEFAULT_LIMIT = 50;
/** "Awaiting a decision or SE action" — a judgment call, not a schema concept: the image
 *  (`docs/ui/mobile/vouchers.png`) shows two visually distinct pills ("Pending"/"Manager Review") that
 *  both map onto this bucket; the raw `status` is still returned per-row so a client can tell them
 *  apart if it wants to. `SUBMITTED`/`DRAFT` are dead states in the current create flow (`create()`
 *  always lands a voucher straight into `ZONAL_MANAGER_REVIEW`) but included for schema completeness. */
const PENDING_STATUSES: ReadonlySet<VoucherStatus> = new Set(['SUBMITTED', 'ZONAL_MANAGER_REVIEW', 'NEEDS_CLARIFICATION']);
/** `PAID` counts as approved from the SE's own point of view — it is a downstream state of an
 *  approval, not a separate outcome the SE needs distinguished on this screen. */
const APPROVED_STATUSES: ReadonlySet<VoucherStatus> = new Set(['APPROVED', 'PAID']);

export interface MeVoucherItemView {
  itemId: string;
  category: ExpenseCategory;
  amount: number;
  merchantVendorName: string | null;
  expenseDatetime: string | null;
  photoRef: string | null;
  limit: number;
  overLimit: boolean;
}

export interface MeVoucherRow {
  voucherId: string;
  status: VoucherStatus;
  plantId: number | null;
  plantName: string | null;
  ticketId: string | null;
  vehicleId: number | null;
  totalAmount: number;
  submittedAt: string | null;
  reviewNotes: string | null;
  reviewerName: string | null;
  items: MeVoucherItemView[];
  createdAt: string;
}

export interface MeVouchersSummary {
  claimedTotal: number;
  pendingCount: number;
  approvedCount: number;
}

export interface MeVouchersView {
  items: MeVoucherRow[];
  cursor: null;
  summary: MeVouchersSummary;
}

/**
 * #163 item 1 — `GET /api/me/vouchers`, the SE-readable variant of `VouchersService.reviewQueue`
 * (manager-only, `GET /vouchers`). Keyed on the caller's own `seId`, never another SE's. Unlike the
 * manager queue (status-filtered to the active review bucket), this returns every status — an SE
 * needs to see APPROVED/REJECTED/PAID history, not just what is currently in front of a reviewer.
 *
 * `summary` is computed over the caller's FULL voucher set, independent of `items`' bound — the KPI
 * tiles must stay correct even once #165 adds real pagination here (`cursor` is `null` today, same
 * "envelope now, real cursor later" convention #161 item 2 established).
 */
@Injectable()
export class MeVouchersService {
  constructor(private readonly prisma: PrismaService) {}

  async getMyVouchers(seId: string, limit: number = DEFAULT_LIMIT): Promise<MeVouchersView> {
    const [rows, summaryRows] = await Promise.all([
      this.prisma.expenseVoucher.findMany({
        where: { seId },
        orderBy: { createdAt: 'desc' },
        take: limit,
        include: { items: true },
      }),
      this.prisma.expenseVoucher.findMany({ where: { seId }, select: { status: true, totalAmount: true } }),
    ]);

    // `ExpenseVoucher.plantId` is a bare FK with no Prisma relation to `Plant` (same schema gap as
    // `Ticket`→`Plant` elsewhere) — resolved with a separate lookup rather than an `include`.
    const plantIds = [...new Set(rows.map((r) => r.plantId).filter((id): id is bigint => id != null))];
    const plants = plantIds.length
      ? await this.prisma.plant.findMany({ where: { plantId: { in: plantIds } }, select: { plantId: true, name: true } })
      : [];
    const plantNameById = new Map(plants.map((p) => [p.plantId, p.name]));

    const reviewerIds = [...new Set(rows.map((r) => r.reviewedBy).filter((id): id is string => id != null))];
    const reviewers = reviewerIds.length
      ? await this.prisma.user.findMany({ where: { userId: { in: reviewerIds } }, select: { userId: true, name: true } })
      : [];
    const reviewerNameById = new Map(reviewers.map((r) => [r.userId, r.name]));

    const items: MeVoucherRow[] = rows.map((r) => ({
      voucherId: r.voucherId,
      status: r.status,
      plantId: r.plantId != null ? Number(r.plantId) : null,
      plantName: r.plantId != null ? (plantNameById.get(r.plantId) ?? null) : null,
      ticketId: r.ticketId,
      vehicleId: r.vehicleId != null ? Number(r.vehicleId) : null,
      totalAmount: Number(r.totalAmount),
      submittedAt: r.submittedAt ? r.submittedAt.toISOString() : null,
      reviewNotes: r.reviewNotes,
      reviewerName: r.reviewedBy ? (reviewerNameById.get(r.reviewedBy) ?? null) : null,
      createdAt: r.createdAt.toISOString(),
      items: r.items.map((i) => {
        const limit = CATEGORY_LIMITS[i.category];
        const amount = Number(i.amount);
        return {
          itemId: String(i.itemId),
          category: i.category,
          amount,
          merchantVendorName: i.merchantVendorName,
          expenseDatetime: i.expenseDatetime ? i.expenseDatetime.toISOString() : null,
          photoRef: i.photoRef,
          limit,
          overLimit: amount > limit,
        };
      }),
    }));

    const summary: MeVouchersSummary = summaryRows.reduce(
      (acc, r) => {
        acc.claimedTotal += Number(r.totalAmount);
        if (PENDING_STATUSES.has(r.status)) acc.pendingCount++;
        if (APPROVED_STATUSES.has(r.status)) acc.approvedCount++;
        return acc;
      },
      { claimedTotal: 0, pendingCount: 0, approvedCount: 0 },
    );

    return { items, cursor: null, summary };
  }
}
