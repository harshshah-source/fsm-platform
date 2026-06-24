import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
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
import { type LeaveRequestType } from '../generated/prisma/enums';
import {
  LeaveRequestService,
  type LeaveOutcome,
  type LeaveRequestRow,
} from './leave-request.service';

const LEAVE_TYPES: readonly LeaveRequestType[] = ['ON_LEAVE', 'WEEKLY_OFF'];
const MANAGER_ROLES = ['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD'] as const;

interface SubmitBody {
  seId: string;
  type: LeaveRequestType;
  windowStart: string;
  windowEnd: string;
  reason?: string | null;
}

/**
 * Leave Request surface (Issue 26, `/api/leave-requests`). Submit (SE-self or own-zone ZM), the
 * zone-scoped manager list, and Approve / Reject (own-zone ZM / CSM acting). Approve writes the
 * availability window in the service; Operations Head can read the list but is not a decision-maker
 * here (the service rejects a non-ZM/CSM approve/reject as FORBIDDEN).
 */
@Controller('leave-requests')
@UseGuards(AuthGuard, RoleGuard)
export class LeaveRequestController {
  constructor(private readonly leave: LeaveRequestService) {}

  @Post()
  @Roles('SERVICE_ENGINEER', 'ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER')
  async submit(@CurrentUser() user: AccessTokenClaims, @Body() body: SubmitBody): Promise<LeaveOutcome> {
    if (!body.seId) throw new BadRequestException({ code: 'SE_REQUIRED' });
    if (!LEAVE_TYPES.includes(body.type)) throw new BadRequestException({ code: 'INVALID_LEAVE_TYPE' });
    const windowStart = new Date(body.windowStart);
    const windowEnd = new Date(body.windowEnd);
    if (Number.isNaN(windowStart.getTime()) || Number.isNaN(windowEnd.getTime())) {
      throw new BadRequestException({ code: 'INVALID_WINDOW' });
    }
    if (windowEnd < windowStart) throw new BadRequestException({ code: 'WINDOW_ORDER' });

    const outcome = await this.leave.submit(
      { seId: body.seId, type: body.type, windowStart, windowEnd, reason: body.reason ?? null },
      { userId: user.user_id, role: user.role, zoneId: user.zone_id, actedAsRole: null },
    );
    return this.mapOutcome(outcome);
  }

  @Get()
  @Roles(...MANAGER_ROLES)
  list(@CurrentUser() user: AccessTokenClaims): Promise<LeaveRequestRow[]> {
    return this.leave.listForZone({ role: user.role, zoneId: user.zone_id });
  }

  @Post(':id/approve')
  @HttpCode(200)
  @Roles('ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER')
  async approve(@CurrentUser() user: AccessTokenClaims, @Param('id') id: string): Promise<LeaveOutcome> {
    return this.mapOutcome(
      await this.leave.approve(id, { userId: user.user_id, role: user.role, zoneId: user.zone_id, actedAsRole: null }),
    );
  }

  @Post(':id/reject')
  @HttpCode(200)
  @Roles('ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER')
  async reject(
    @CurrentUser() user: AccessTokenClaims,
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ): Promise<LeaveOutcome> {
    if (!body.reason?.trim()) throw new BadRequestException({ code: 'REASON_REQUIRED' });
    return this.mapOutcome(
      await this.leave.reject(id, body.reason.trim(), {
        userId: user.user_id,
        role: user.role,
        zoneId: user.zone_id,
        actedAsRole: null,
      }),
    );
  }

  private mapOutcome(outcome: LeaveOutcome): LeaveOutcome {
    if (outcome.result === 'NOT_FOUND') throw new NotFoundException({ code: 'LEAVE_REQUEST_NOT_FOUND' });
    if (outcome.result === 'FORBIDDEN') throw new ForbiddenException({ code: 'LEAVE_FORBIDDEN' });
    if (outcome.result === 'INVALID_STATE') throw new BadRequestException({ code: 'LEAVE_NOT_PENDING' });
    return outcome;
  }
}
