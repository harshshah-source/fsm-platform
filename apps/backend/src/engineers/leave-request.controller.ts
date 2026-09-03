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
  UseGuards,
} from '@nestjs/common';
import { AccessTokenClaims } from '../auth/token.service';
import { istWindowEnd, istWindowStart } from '../common/ist-day';
import { CurrentActor } from '../common/decorators/current-actor.decorator';
import { CurrentScope } from '../common/decorators/current-scope.decorator';
import type { ManagerScope } from '../common/manager-scope';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestActor } from '../common/request-actor';
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
 * zone-scoped manager list, and Approve / Reject / Revoke (own-zone ZM / CSM acting). Approve writes
 * the availability window in the service and Revoke (#363) writes the AVAILABLE window that gives the
 * day back; Operations Head can read the list but is not a decision-maker here (the service rejects a
 * non-ZM/CSM decision as FORBIDDEN).
 */
@Controller('leave-requests')
@UseGuards(AuthGuard, RoleGuard)
export class LeaveRequestController {
  constructor(private readonly leave: LeaveRequestService) {}

  @Post()
  @Roles('SERVICE_ENGINEER', 'ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER')
  async submit(@CurrentActor() actor: RequestActor, @Body() body: SubmitBody): Promise<LeaveOutcome> {
    if (!body.seId) throw new BadRequestException({ code: 'SE_REQUIRED' });
    if (!LEAVE_TYPES.includes(body.type)) throw new BadRequestException({ code: 'INVALID_LEAVE_TYPE' });
    // #204 / B8 — a bare `YYYY-MM-DD` (what the mobile form sends) names an **IST calendar day**, so
    // the pair becomes `[IST midnight of windowStart, IST midnight of the day after windowEnd)`; the
    // active-window predicate is end-exclusive, which is what makes the end date's own day covered.
    // Full ISO instants (admin) pass through untouched. See `common/ist-day.ts`.
    const windowStart = istWindowStart(body.windowStart);
    const windowEnd = istWindowEnd(body.windowEnd);
    if (Number.isNaN(windowStart.getTime()) || Number.isNaN(windowEnd.getTime())) {
      throw new BadRequestException({ code: 'INVALID_WINDOW' });
    }
    // `<=`, not `<`: with an end-exclusive window, an end that lands on or before the start covers no
    // instant at all. Date-only makes that reachable — `windowEnd` one day before `windowStart` resolves
    // to exactly `windowStart` — and a leave request that grants zero unavailability is not a success.
    if (windowEnd <= windowStart) throw new BadRequestException({ code: 'WINDOW_ORDER' });

    const outcome = await this.leave.submit(
      { seId: body.seId, type: body.type, windowStart, windowEnd, reason: body.reason ?? null },
      actor,
    );
    return this.mapOutcome(outcome);
  }

  @Get()
  @Roles(...MANAGER_ROLES)
  list(@CurrentScope() scope: ManagerScope): Promise<LeaveRequestRow[]> {
    return this.leave.listForZone(scope);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @Roles('ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER')
  async approve(@CurrentActor() actor: RequestActor, @Param('id') id: string): Promise<LeaveOutcome> {
    return this.mapOutcome(await this.leave.approve(id, actor));
  }

  @Post(':id/reject')
  @HttpCode(200)
  @Roles('ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER')
  async reject(
    @CurrentActor() actor: RequestActor,
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ): Promise<LeaveOutcome> {
    if (!body.reason?.trim()) throw new BadRequestException({ code: 'REASON_REQUIRED' });
    return this.mapOutcome(await this.leave.reject(id, body.reason.trim(), actor));
  }

  /**
   * #363 — an approved leave the ZM needs back. Same shape as reject, and for the same reason a
   * mandatory one: this write puts an engineer back on a day a manager had already taken them off, and
   * "why" is the only part of that a ledger cannot infer.
   */
  @Post(':id/revoke')
  @HttpCode(200)
  @Roles('ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER')
  async revoke(
    @CurrentActor() actor: RequestActor,
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ): Promise<LeaveOutcome> {
    if (!body.reason?.trim()) throw new BadRequestException({ code: 'REASON_REQUIRED' });
    return this.mapOutcome(await this.leave.revoke(id, body.reason.trim(), actor), 'LEAVE_NOT_APPROVED');
  }

  /**
   * `invalidStateCode` names the state the caller actually needed: approve/reject want a PENDING
   * request, revoke wants an APPROVED one that has not already been revoked. One code for both would
   * tell a manager the request "is not pending" when the problem is that it is.
   */
  private mapOutcome(outcome: LeaveOutcome, invalidStateCode = 'LEAVE_NOT_PENDING'): LeaveOutcome {
    if (outcome.result === 'NOT_FOUND') throw new NotFoundException({ code: 'LEAVE_REQUEST_NOT_FOUND' });
    if (outcome.result === 'FORBIDDEN') throw new ForbiddenException({ code: 'LEAVE_FORBIDDEN' });
    if (outcome.result === 'INVALID_STATE') throw new BadRequestException({ code: invalidStateCode });
    // 409, not 400: the request is well-formed and it is the SE's own diary that refuses it.
    // `conflictId` names the row holding the day so the manager can open it instead of guessing.
    if (outcome.result === 'OVERLAP') {
      throw new ConflictException({ code: 'OVERLAP', conflictId: outcome.conflictId });
    }
    return outcome;
  }
}
