import { Body, ConflictException, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import { type AdvanceOutcome, SoftStateService, type SoftStateView } from './soft-state.service';

/** bigint-safe wire shape of a soft state (JSON can't carry bigint). */
function serialize(s: SoftStateView) {
  return {
    softStateId: String(s.softStateId),
    ticketId: s.ticketId,
    seId: s.seId,
    type: s.type,
    onsiteSource: s.onsiteSource,
    setAt: s.setAt,
    timeoutAt: s.timeoutAt,
    resolvedAt: s.resolvedAt,
  };
}

/**
 * SE soft-state surface (Issue 15). The mobile app drives the field-progress chain on a ticket
 * (VIEWED → ON_SITE → TROUBLESHOOT_STARTED) and stamps the SE Activity Ping. SE-only and scoped
 * server-side to the caller's own id — never an arbitrary se param. An out-of-order transition is a
 * 409; an idempotent re-tap returns the existing state.
 */
@Controller()
@UseGuards(AuthGuard, RoleGuard)
export class SoftStateController {
  constructor(private readonly softState: SoftStateService) {}

  @Post('tickets/:id/soft-state')
  @Roles('SERVICE_ENGINEER')
  async setSoftState(
    @CurrentUser() user: AccessTokenClaims,
    @Param('id') ticketId: string,
    @Body() body: { target: 'VIEWED' | 'ON_SITE' | 'TROUBLESHOOT_STARTED'; location?: { lat: number; lng: number } },
  ) {
    const outcome: AdvanceOutcome =
      body.target === 'ON_SITE'
        ? await this.softState.setOnSite({
            ticketId,
            seId: user.user_id,
            capturedLocation: body.location,
            actor: { userId: user.user_id, role: user.role },
          })
        : await this.softState.advance({ ticketId, seId: user.user_id, target: body.target });

    if (outcome.result === 'INVALID_TRANSITION') {
      throw new ConflictException({ code: 'INVALID_SOFT_STATE_TRANSITION', from: outcome.from, to: outcome.to });
    }
    return { result: outcome.result, softState: serialize(outcome.softState) };
  }

  @Post('me/activity-ping')
  @Roles('SERVICE_ENGINEER')
  async activityPing(@CurrentUser() user: AccessTokenClaims): Promise<{ ok: true }> {
    await this.softState.recordActivityPing(user.user_id);
    return { ok: true };
  }
}
