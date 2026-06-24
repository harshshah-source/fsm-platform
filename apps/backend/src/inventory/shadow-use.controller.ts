import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import { ShadowUseService, type ShadowUseOutcome } from './shadow-use.service';

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

/**
 * Shadow Use Queue (Issue 24, `/api/warehouse/shadow-use`). The Warehouse Manager reconciles
 * unreconciled SHADOW_USE inventory rows: Mark Reconciled (genuine duplicate effort) or Mark Disputed
 * (mandatory reason — escalates to the ZM and flags the Ticket). WAREHOUSE_MANAGER only.
 */
@Controller('warehouse/shadow-use')
@UseGuards(AuthGuard, RoleGuard)
export class ShadowUseController {
  constructor(private readonly shadowUse: ShadowUseService) {}

  @Get()
  @Roles('WAREHOUSE_MANAGER')
  list() {
    return this.shadowUse.queue();
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
