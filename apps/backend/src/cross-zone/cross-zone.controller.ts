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
import { CurrentActor } from '../common/decorators/current-actor.decorator';
import { CurrentScope } from '../common/decorators/current-scope.decorator';
import type { ManagerScope } from '../common/manager-scope';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestActor } from '../common/request-actor';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import {
  CrossZoneEscalationRow,
  CrossZoneEscalationService,
  DecisionOutcome,
} from './cross-zone-escalation.service';
import { ApproveBody, DeferBody, DenyBody, FlagBody, SweepBody } from './cross-zone.dtos';

const ALL_MANAGERS = ['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD'] as const;
const CROSS_ZONE_DECIDERS = ['CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD'] as const;

/**
 * `/api/cross-zone/*` — the cross-zone escalation surface (Issue 32). `GET` is the queue read
 * (CSM/OH cross-zone; a ZM sees their home zone). A ZM `flag`s a Gold/Silver Ticket; the CSM/OH
 * `sweep`s auto-escalations and resolves each via `approve`/`deny`/`defer`; the home ZM `re-escalate`s a
 * denied AUTO escalation to Operations Head.
 */
@Controller('cross-zone')
@UseGuards(AuthGuard, RoleGuard)
export class CrossZoneController {
  constructor(private readonly svc: CrossZoneEscalationService) {}

  @Get()
  @Roles(...ALL_MANAGERS)
  list(@CurrentScope() scope: ManagerScope): Promise<CrossZoneEscalationRow[]> {
    return this.svc.listForScope(scope);
  }

  @Post('sweep')
  @HttpCode(200)
  @Roles(...CROSS_ZONE_DECIDERS)
  sweep(@Body() body: SweepBody): Promise<{ escalated: number }> {
    return this.svc.sweepAutoEscalations(undefined, body.zoneId != null ? BigInt(body.zoneId) : undefined);
  }

  @Post('flag')
  @HttpCode(200)
  @Roles('ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER')
  async flag(@CurrentActor() actor: RequestActor, @Body() body: FlagBody) {
    const { ticketId, reason } = body;
    if (!ticketId) throw new BadRequestException({ code: 'TICKET_REQUIRED' });
    if (!reason) throw new BadRequestException({ code: 'REASON_REQUIRED' });
    const out = await this.svc.flag(ticketId, reason, actor);
    if (out.result === 'NOT_FOUND') throw new NotFoundException({ code: 'TICKET_NOT_FOUND' });
    if (out.result === 'FORBIDDEN_SCOPE') throw new ForbiddenException({ code: 'TICKET_OUT_OF_ZONE' });
    if (out.result === 'FORBIDDEN_TIER') throw new BadRequestException({ code: 'PLATINUM_USES_AUTO_ESCALATION' });
    if (out.result === 'ALREADY_ESCALATED') throw new ConflictException({ code: 'ALREADY_ESCALATED' });
    return out;
  }

  @Post(':id/approve')
  @HttpCode(200)
  @Roles(...CROSS_ZONE_DECIDERS)
  approve(
    @CurrentActor() actor: RequestActor,
    @Param('id') id: string,
    @Body() body: ApproveBody,
  ) {
    if (body.targetZoneId == null || !body.seId) throw new BadRequestException({ code: 'TARGET_ZONE_AND_SE_REQUIRED' });
    return this.map(this.svc.approve(BigInt(id), body.targetZoneId, body.seId, actor));
  }

  @Post(':id/deny')
  @HttpCode(200)
  @Roles(...CROSS_ZONE_DECIDERS)
  deny(@CurrentActor() actor: RequestActor, @Param('id') id: string, @Body() body: DenyBody) {
    if (!body.reason) throw new BadRequestException({ code: 'REASON_REQUIRED' });
    return this.map(this.svc.deny(BigInt(id), body.reason, actor));
  }

  @Post(':id/defer')
  @HttpCode(200)
  @Roles(...CROSS_ZONE_DECIDERS)
  defer(
    @CurrentActor() actor: RequestActor,
    @Param('id') id: string,
    @Body() body: DeferBody,
  ) {
    if (!body.reviewDate || !body.reason) throw new BadRequestException({ code: 'REVIEW_DATE_AND_REASON_REQUIRED' });
    return this.map(this.svc.defer(BigInt(id), new Date(body.reviewDate), body.reason, actor));
  }

  @Post(':id/re-escalate')
  @HttpCode(200)
  @Roles('ZONAL_MANAGER')
  async reEscalate(@CurrentActor() actor: RequestActor, @Param('id') id: string) {
    const out = await this.svc.reEscalateToOps(BigInt(id), actor);
    if (out.result === 'NOT_FOUND') throw new NotFoundException({ code: 'ESCALATION_NOT_FOUND' });
    if (out.result === 'NOT_DENIED_AUTO') throw new ConflictException({ code: 'NOT_A_DENIED_AUTO_ESCALATION' });
    if (out.result === 'FORBIDDEN_SCOPE') throw new ForbiddenException({ code: 'NOT_HOME_ZONE_ZM' });
    return out;
  }

  private async map(p: Promise<DecisionOutcome>): Promise<DecisionOutcome> {
    const out = await p;
    if (out.result === 'NOT_FOUND') throw new NotFoundException({ code: 'ESCALATION_OR_SE_NOT_FOUND' });
    if (out.result === 'NOT_PENDING') throw new ConflictException({ code: 'ESCALATION_NOT_ACTIONABLE', status: out.status });
    if (out.result === 'ALREADY_ASSIGNED') throw new ConflictException({ code: 'TICKET_ALREADY_ASSIGNED' });
    if (out.result === 'FORBIDDEN_SCOPE') throw new ForbiddenException({ code: 'FORBIDDEN_SCOPE' });
    if (out.result === 'NOT_DENIED_AUTO') throw new ConflictException({ code: 'NOT_A_DENIED_AUTO_ESCALATION' });
    return out;
  }
}
