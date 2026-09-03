import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentScope } from '../common/decorators/current-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { ManagerScope } from '../common/manager-scope';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import {
  isListableStatus,
  LISTABLE_STATUSES,
  ShadowUseService,
  type ListableStatus,
  type ShadowUseOutcome,
  type ShadowUseRow,
} from './shadow-use.service';

interface DisputeBody {
  reason?: string;
}

function resolve(outcome: ShadowUseOutcome) {
  if (outcome.result === 'NOT_FOUND') throw new NotFoundException({ code: 'SHADOW_USE_NOT_FOUND' });
  if (outcome.result === 'INVALID_STATE') {
    throw new ConflictException({ code: 'SHADOW_USE_INVALID_STATE', status: outcome.status });
  }
  return { ok: true };
}

/** Roles that may READ the queue. The two writes below stay Warehouse-Manager-only (#353 AC4). */
const READ_ROLES = ['WAREHOUSE_MANAGER', 'ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD'] as const;

/**
 * Shadow Use Queue (Issue 24, `/api/warehouse/shadow-use`). The Warehouse Manager reconciles
 * unreconciled SHADOW_USE inventory rows: Mark Reconciled (genuine duplicate effort) or Mark Disputed
 * (mandatory reason — escalates to the ZM and flags the Ticket).
 *
 * #353 — the read is no longer WM-only. A dispute is *escalated to the Zonal Manager*, and until now
 * the ZM had no way to see one: the queue was worked by whoever happened to look. A manager reads
 * disputes and nothing else — the unreconciled queue is the WM's work, not theirs — and a ZM is
 * clamped to their own zone by `@CurrentScope()`. The writes are untouched.
 */
@Controller('warehouse/shadow-use')
@UseGuards(AuthGuard, RoleGuard)
export class ShadowUseController {
  constructor(private readonly shadowUse: ShadowUseService) {}

  @Get()
  @Roles(...READ_ROLES)
  list(@CurrentScope() scope: ManagerScope, @Query('status') status?: string): Promise<ShadowUseRow[]> {
    return this.shadowUse.queue({ status: readStatus(scope, status), scope });
  }

  @Post(':id/reconcile')
  @Roles('WAREHOUSE_MANAGER')
  async reconcile(@CurrentUser() user: AccessTokenClaims, @Param('id') id: string) {
    return resolve(await this.shadowUse.markReconciled(id, { userId: user.user_id, role: user.role }));
  }

  @Post(':id/dispute')
  @Roles('WAREHOUSE_MANAGER')
  async dispute(@CurrentUser() user: AccessTokenClaims, @Param('id') id: string, @Body() body: DisputeBody) {
    if (!body.reason || !body.reason.trim()) throw new BadRequestException({ code: 'DISPUTE_REASON_REQUIRED' });
    return resolve(await this.shadowUse.markDisputed(id, body.reason, { userId: user.user_id, role: user.role }));
  }
}

/**
 * The status a read is allowed to ask for. A Warehouse Manager may page through all three (the queue
 * page's status filter, reference 19); every other manager role reads DISPUTED only — the rows they
 * adjudicate — whatever they ask for. An unknown value is a 400 rather than a silent full list: a
 * typo'd filter that quietly returns the unreconciled queue is worse than an error.
 */
function readStatus(scope: ManagerScope, requested: string | undefined): ListableStatus {
  if (scope.role !== 'WAREHOUSE_MANAGER') return 'DISPUTED';
  if (requested === undefined || requested === '') return 'SHADOW_USE';
  if (!isListableStatus(requested)) {
    throw new BadRequestException({ code: 'INVALID_STATUS', allowed: LISTABLE_STATUSES });
  }
  return requested;
}
