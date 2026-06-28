import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentActor } from '../common/decorators/current-actor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import type { RequestActor } from '../common/request-actor';
import type { ExpenseCategory } from '../generated/prisma/enums';
import { type CreateVoucherItemInput, type ReviewAction, VouchersService } from './vouchers.service';

const REVIEW_ROLES = ['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD'] as const;
const VALID_CATEGORIES: ReadonlySet<string> = new Set([
  'TRAVEL',
  'ACCOMMODATION',
  'PARTS',
  'TOOLS',
  'MEAL',
  'OTHER',
]);
const VALID_ACTIONS: ReadonlySet<string> = new Set(['APPROVE', 'REJECT', 'NEEDS_CLARIFICATION']);

interface CreateBody {
  clientSubmissionId?: string;
  plantId?: number | string | null;
  ticketId?: string | null;
  vehicleId?: number | string | null;
  items?: Array<{
    category?: string;
    amount?: number;
    merchantVendorName?: string | null;
    expenseDatetime?: string | null;
    photoRef?: string | null;
  }>;
}

/**
 * Expense Vouchers (Issue 38, `/api/vouchers`). SE submit (offline-drafted, idempotent), ZM review
 * queue + Approve/Reject/Needs-Clarification, SE resubmit after clarification, and the Operations-Head
 * Finance export + multi-select Mark PAID. RBAC: SE owns create/resubmit; ZM/CSM/OH review (ZM own
 * zone); OH owns export + mark-paid.
 */
@Controller('vouchers')
@UseGuards(AuthGuard, RoleGuard)
export class VouchersController {
  constructor(private readonly vouchers: VouchersService) {}

  @Post()
  @HttpCode(201)
  @Roles('SERVICE_ENGINEER')
  async create(@CurrentUser() user: AccessTokenClaims, @Body() body: CreateBody) {
    if (!body.clientSubmissionId || typeof body.clientSubmissionId !== 'string') {
      throw new BadRequestException({ code: 'CLIENT_SUBMISSION_ID_REQUIRED' });
    }
    if (!Array.isArray(body.items) || body.items.length === 0) {
      throw new BadRequestException({ code: 'NO_ITEMS' });
    }
    const items: CreateVoucherItemInput[] = body.items.map((i) => {
      if (!i.category || !VALID_CATEGORIES.has(i.category)) {
        throw new BadRequestException({ code: 'INVALID_CATEGORY', category: i.category });
      }
      if (typeof i.amount !== 'number' || !Number.isFinite(i.amount)) {
        throw new BadRequestException({ code: 'INVALID_AMOUNT' });
      }
      return {
        category: i.category as ExpenseCategory,
        amount: i.amount,
        merchantVendorName: i.merchantVendorName ?? null,
        expenseDatetime: i.expenseDatetime ? new Date(i.expenseDatetime) : null,
        photoRef: i.photoRef ?? null,
      };
    });

    const out = await this.vouchers.create({
      seId: user.user_id,
      clientSubmissionId: body.clientSubmissionId,
      plantId: toBigInt(body.plantId),
      ticketId: body.ticketId ?? null,
      vehicleId: toBigInt(body.vehicleId),
      items,
    });
    if (out.result === 'ERROR') throw new BadRequestException({ code: out.code });
    return { voucher: out.voucher, duplicate: out.duplicate };
  }

  @Get()
  @Roles(...REVIEW_ROLES)
  queue(@CurrentUser() user: AccessTokenClaims, @Query('status') status?: string) {
    // Default = the ZM review queue. Operations Head also lists APPROVED for the Mark-PAID pass.
    const resolved = status === 'APPROVED' ? 'APPROVED' : 'ZONAL_MANAGER_REVIEW';
    return this.vouchers.reviewQueue({ role: user.role, zoneId: user.zone_id }, resolved);
  }

  @Get('export')
  @Roles('OPERATIONS_HEAD')
  async export(@Query('month') month: string): Promise<StreamableFile> {
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      throw new BadRequestException({ code: 'MONTH_REQUIRED', hint: 'YYYY-MM' });
    }
    const out = await this.vouchers.exportApproved(month);
    return new StreamableFile(Buffer.from(out.csv, 'utf-8'), {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="${out.filename}"`,
    });
  }

  @Post('mark-paid')
  @HttpCode(200)
  @Roles('OPERATIONS_HEAD')
  async markPaid(
    @CurrentActor() actor: RequestActor,
    @Body() body: { voucherIds?: string[]; batchRef?: string | null },
  ) {
    if (!Array.isArray(body.voucherIds) || body.voucherIds.length === 0) {
      throw new BadRequestException({ code: 'VOUCHER_IDS_REQUIRED' });
    }
    return this.vouchers.markPaid(body.voucherIds, body.batchRef ?? null, actor);
  }

  @Post(':id/review')
  @HttpCode(200)
  @Roles(...REVIEW_ROLES)
  async review(
    @CurrentUser() user: AccessTokenClaims,
    @CurrentActor() actor: RequestActor,
    @Param('id') id: string,
    @Body() body: { action?: string; notes?: string | null },
  ) {
    if (!body.action || !VALID_ACTIONS.has(body.action)) {
      throw new BadRequestException({ code: 'INVALID_ACTION' });
    }
    const out = await this.vouchers.review(
      id,
      { action: body.action as ReviewAction, notes: body.notes ?? null },
      { role: user.role, zoneId: user.zone_id },
      actor,
    );
    if (out.result === 'NOT_FOUND') throw new NotFoundException({ code: 'VOUCHER_NOT_FOUND' });
    if (out.result === 'FORBIDDEN') throw new ForbiddenException({ code: 'VOUCHER_ZONE_FORBIDDEN' });
    if (out.result === 'REASON_REQUIRED') throw new BadRequestException({ code: 'REASON_REQUIRED' });
    if (out.result === 'INVALID_STATE') {
      throw new ConflictException({ code: 'VOUCHER_INVALID_STATE', status: out.status });
    }
    return { status: out.status };
  }

  @Post(':id/resubmit')
  @HttpCode(200)
  @Roles('SERVICE_ENGINEER')
  async resubmit(@CurrentActor() actor: RequestActor, @Param('id') id: string) {
    const out = await this.vouchers.resubmit(id, actor);
    if (out.result === 'NOT_FOUND') throw new NotFoundException({ code: 'VOUCHER_NOT_FOUND' });
    if (out.result === 'FORBIDDEN') throw new ForbiddenException({ code: 'VOUCHER_NOT_OWNER' });
    if (out.result === 'INVALID_STATE') {
      throw new ConflictException({ code: 'VOUCHER_INVALID_STATE', status: out.status });
    }
    return { status: 'ZONAL_MANAGER_REVIEW' };
  }
}

function toBigInt(value: number | string | null | undefined): bigint | null {
  if (value === null || value === undefined || value === '') return null;
  return BigInt(value);
}
