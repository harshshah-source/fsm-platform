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
import { CurrentActor } from '../common/decorators/current-actor.decorator';
import { CurrentScope } from '../common/decorators/current-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { ManagerScope } from '../common/manager-scope';
import type { RequestActor } from '../common/request-actor';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import { VerificationService } from './verification.service';
import {
  type FraudFlagView,
  type VerificationReviewRow,
  type VerificationView,
  VerificationQueryService,
} from './verification-query.service';

const MANAGER_ROLES = ['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD'] as const;
const REVIEW_OUTCOMES = ['PARTIAL_RECOVERY', 'FAILED_VERIFICATION', 'CLOSED', 'CLOSED_AUTO_RECOVERY'];

/**
 * Verification read surface (Issue 18, LLD §17). The SE/ZM ticket view exposes the run phase, ping
 * count, fraud flag, and the derived outcome / PARTIAL_RECOVERY badge the mobile renders; the
 * fraud-flags list is the ZM Phase-1 location-mismatch view.
 */
@Controller()
@UseGuards(AuthGuard, RoleGuard)
export class VerificationController {
  constructor(
    private readonly query: VerificationQueryService,
    private readonly verification: VerificationService,
  ) {}

  @Get('verification/review')
  @Roles(...MANAGER_ROLES)
  review(
    @CurrentScope() scope: ManagerScope,
    @Query('outcome') outcome?: string,
    @Query('companyId') companyId?: string,
    @Query('zoneId') zoneId?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ): Promise<VerificationReviewRow[]> {
    return this.query.review(
      {
        outcome:
          outcome && REVIEW_OUTCOMES.includes(outcome)
            ? (outcome as 'PARTIAL_RECOVERY' | 'FAILED_VERIFICATION' | 'CLOSED' | 'CLOSED_AUTO_RECOVERY')
            : undefined,
        companyId: companyId ? BigInt(companyId) : undefined,
        zoneId: zoneId ? BigInt(zoneId) : undefined,
        dateFrom: dateFrom ? new Date(dateFrom) : undefined,
        dateTo: dateTo ? new Date(dateTo) : undefined,
      },
      scope,
    );
  }

  @Post('verification/:ticketId/escalate')
  @Roles(...MANAGER_ROLES)
  async escalate(
    @CurrentScope() scope: ManagerScope,
    @CurrentActor() actor: RequestActor,
    @Param('ticketId') ticketId: string,
    @Body() body: { reason?: string },
  ): Promise<{ result: 'OK' }> {
    if (!body.reason || !body.reason.trim()) {
      throw new BadRequestException({ code: 'ESCALATION_REASON_REQUIRED' });
    }
    const outcome = await this.verification.escalateFraud(
      ticketId,
      body.reason.trim(),
      actor,
      scope,
    );
    if (outcome === 'NOT_FOUND') throw new NotFoundException({ code: 'TICKET_NOT_FOUND' });
    if (outcome === 'NOT_FRAUD') throw new ConflictException({ code: 'NOT_FRAUD_FLAGGED' });
    return { result: 'OK' };
  }

  /**
   * #357 — reverse an escalation raised in error. ESCALATED was a one-way door; this is the way back,
   * to the state the ticket was escalated FROM. Refused (409) on anything not currently escalated,
   * which is how a closed ticket is refused.
   */
  @Post('verification/:ticketId/deescalate')
  @Roles(...MANAGER_ROLES)
  async deescalate(
    @CurrentScope() scope: ManagerScope,
    @CurrentActor() actor: RequestActor,
    @Param('ticketId') ticketId: string,
    @Body() body: { reason?: string },
  ): Promise<{ result: 'OK' }> {
    if (!body.reason || !body.reason.trim()) {
      throw new BadRequestException({ code: 'DEESCALATION_REASON_REQUIRED' });
    }
    const outcome = await this.verification.deescalate(ticketId, body.reason.trim(), actor, scope);
    if (outcome === 'NOT_FOUND') throw new NotFoundException({ code: 'TICKET_NOT_FOUND' });
    if (outcome === 'NOT_ESCALATED') throw new ConflictException({ code: 'NOT_ESCALATED' });
    return { result: 'OK' };
  }

  @Post('verification/:ticketId/mark-auto-recovery')
  @Roles(...MANAGER_ROLES)
  async markAutoRecovery(
    @CurrentScope() scope: ManagerScope,
    @CurrentActor() actor: RequestActor,
    @Param('ticketId') ticketId: string,
    @Body() body: { reason?: string },
  ): Promise<{ result: 'OK' }> {
    // #357 — mandatory, exactly as `escalate` above. A manager overruling the platform's verdict on
    // whether the work happened is the decision an auditor comes back to; it does not get to be the
    // one closure door in the module that records no why.
    if (!body.reason || !body.reason.trim()) {
      throw new BadRequestException({ code: 'AUTO_RECOVERY_REASON_REQUIRED' });
    }
    const outcome = await this.verification.markAutoRecovery(
      ticketId,
      body.reason.trim(),
      actor,
      scope,
    );
    if (outcome === 'NOT_FOUND') throw new NotFoundException({ code: 'TICKET_NOT_FOUND' });
    return { result: 'OK' };
  }

  @Get('tickets/:id/verification')
  @Roles('SERVICE_ENGINEER', ...MANAGER_ROLES)
  async forTicket(
    @CurrentScope() scope: ManagerScope,
    @CurrentUser() user: AccessTokenClaims,
    @Param('id') ticketId: string,
  ): Promise<VerificationView> {
    const view = await this.query.forTicket(ticketId, { ...scope, userId: user.user_id });
    if (!view) throw new NotFoundException({ code: 'NO_VERIFICATION_RUN' });
    return view;
  }

  /** #357 — zone-scoped, like `review` and `tickets/:id/verification`. It took no scope at all before. */
  @Get('verification/fraud-flags')
  @Roles(...MANAGER_ROLES)
  fraudFlags(@CurrentScope() scope: ManagerScope): Promise<FraudFlagView[]> {
    return this.query.fraudFlags(scope);
  }
}
