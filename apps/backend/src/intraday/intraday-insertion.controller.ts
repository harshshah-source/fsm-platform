import {
  BadRequestException,
  Body,
  Controller,
  ConflictException,
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
import {
  IntradayInsertionRow,
  IntradayInsertionService,
} from './intraday-insertion.service';

const MANAGER_ROLES = ['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD'] as const;

/**
 * `/api/intraday-insertions/*` — the system-triggered intra-day CRITICAL insertion + SE Acceptance
 * surface (Issues 29/30). `GET` is the Intra-day Queue read (zone-scoped). The SE acts on an offer with
 * `accept` / `decline`; managers trigger the qualifying-event `fire` + the 10-min `sweep-timeouts` (the
 * on-demand worker seam, mirroring the reports recompute posture) and resolve an escalation via
 * `available-ses` + `manual-assign`. Distinct from the ZM manual same-day `/intraday-updates` (Issue 31).
 */
@Controller('intraday-insertions')
@UseGuards(AuthGuard, RoleGuard)
export class IntradayInsertionController {
  constructor(private readonly svc: IntradayInsertionService) {}

  @Get()
  @Roles(...MANAGER_ROLES)
  list(@CurrentUser() user: AccessTokenClaims): Promise<IntradayInsertionRow[]> {
    return this.svc.listForScope({ role: user.role, zoneId: user.zone_id });
  }

  /** Qualifying-event sweep — offer newly-CRITICAL tickets in a zone to their best available candidate. */
  @Post('fire')
  @HttpCode(200)
  @Roles(...MANAGER_ROLES)
  async fire(
    @CurrentUser() user: AccessTokenClaims,
    @Body() body: { zoneId?: number | string },
  ): Promise<{ offered: number; skipped: number }> {
    const zoneId = user.role === 'ZONAL_MANAGER' ? user.zone_id : body.zoneId;
    if (zoneId == null) throw new BadRequestException({ code: 'ZONE_REQUIRED' });
    return this.svc.fireForZone(BigInt(zoneId));
  }

  /** Acceptance-timeout sweep — reroute every offer past its 10-min deadline (worker seam). */
  @Post('sweep-timeouts')
  @HttpCode(200)
  @Roles('OPERATIONS_HEAD', 'CENTRAL_SERVICE_MANAGER')
  sweepTimeouts(): Promise<{ timedOut: number; rerouted: number; escalated: number }> {
    return this.svc.sweepTimeouts();
  }

  @Post(':id/accept')
  @HttpCode(200)
  @Roles('SERVICE_ENGINEER')
  async accept(@CurrentUser() user: AccessTokenClaims, @Param('id') id: string) {
    const out = await this.svc.accept(BigInt(id), user.user_id);
    if (out.result === 'NOT_FOUND') throw new NotFoundException({ code: 'INSERTION_NOT_FOUND' });
    if (out.result === 'NOT_OFFERED') throw new ConflictException({ code: 'NOT_OFFERED_TO_YOU' });
    if (out.result === 'NOT_PENDING') throw new ConflictException({ code: 'INSERTION_NOT_PENDING', status: out.status });
    return out;
  }

  @Post(':id/decline')
  @HttpCode(200)
  @Roles('SERVICE_ENGINEER')
  async decline(
    @CurrentUser() user: AccessTokenClaims,
    @Param('id') id: string,
    @Body() body: { reasonCode: string },
  ) {
    if (!body.reasonCode) throw new BadRequestException({ code: 'REASON_REQUIRED' });
    const out = await this.svc.decline(BigInt(id), user.user_id, body.reasonCode);
    if (out.result === 'INVALID_REASON') throw new BadRequestException({ code: 'INVALID_REASON_CODE' });
    if (out.result === 'NOT_FOUND') throw new NotFoundException({ code: 'INSERTION_NOT_FOUND' });
    if (out.result === 'NOT_OFFERED') throw new ConflictException({ code: 'NOT_OFFERED_TO_YOU' });
    if (out.result === 'NOT_PENDING') throw new ConflictException({ code: 'INSERTION_NOT_PENDING', status: out.status });
    return out;
  }

  /** AVAILABLE SEs for the ZM manual-assignment modal (Issue 30 — availability only, never ping age). */
  @Get(':id/available-ses')
  @Roles(...MANAGER_ROLES)
  availableSes(@Param('id') id: string): Promise<string[]> {
    return this.svc.availableSesForManualAssign(BigInt(id));
  }

  @Post(':id/manual-assign')
  @HttpCode(200)
  @Roles(...MANAGER_ROLES)
  async manualAssign(
    @CurrentUser() user: AccessTokenClaims,
    @Param('id') id: string,
    @Body() body: { seId: string },
  ) {
    if (!body.seId) throw new BadRequestException({ code: 'SE_REQUIRED' });
    const out = await this.svc.manualAssign(
      BigInt(id),
      body.seId,
      { userId: user.user_id, role: user.role, actedAsRole: null },
      { role: user.role, zoneId: user.zone_id },
    );
    if (out.result === 'NOT_FOUND') throw new NotFoundException({ code: 'INSERTION_OR_SE_NOT_FOUND' });
    if (out.result === 'ALREADY_ASSIGNED') throw new ConflictException({ code: 'TICKET_ALREADY_ASSIGNED' });
    return out;
  }
}
