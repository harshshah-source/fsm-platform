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
  type CriticalAssignOutcome,
  IntradayInsertionRow,
  IntradayInsertionService,
} from './intraday-insertion.service';

const MANAGER_ROLES = ['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD'] as const;

/**
 * `/api/intraday-insertions/*` — the system-triggered intra-day CRITICAL insertion surface (Issues
 * 29/30, retired to direct-assignment by #268 / #258 Q3). `GET` is the Intra-day Queue read
 * (zone-scoped). `fire` is the manual trigger for the qualifying-event sweep (mirrors the manual
 * trigger every other business sweep has — `POST /api/schedules/dispatch-run`,
 * `POST /api/integration/run-pipeline`); managers resolve an escalation via `available-ses` +
 * `manual-assign`. Distinct from the ZM manual same-day `/intraday-updates` (Issue 31).
 *
 * `accept`, `decline` and `sweep-timeouts` are gone with the offer machinery they served — a CRITICAL
 * ticket is assigned directly, with no SE veto and no acceptance window to time out.
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

  /** Qualifying-event sweep — direct-assign newly-CRITICAL tickets in a zone, or escalate. */
  @Post('fire')
  @HttpCode(200)
  @Roles(...MANAGER_ROLES)
  async fire(
    @CurrentUser() user: AccessTokenClaims,
    @Body() body: { zoneId?: number | string },
  ): Promise<CriticalAssignOutcome> {
    const zoneId = user.role === 'ZONAL_MANAGER' ? user.zone_id : body.zoneId;
    if (zoneId == null) throw new BadRequestException({ code: 'ZONE_REQUIRED' });
    return this.svc.assignCriticalForZone(BigInt(zoneId));
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
    @Body() body: { seId: string; confirm?: boolean; reasonCode?: string },
  ) {
    if (!body.seId) throw new BadRequestException({ code: 'SE_REQUIRED' });
    const out = await this.svc.manualAssign(
      BigInt(id),
      body.seId,
      { userId: user.user_id, role: user.role, actedAsRole: null },
      { role: user.role, zoneId: user.zone_id },
      undefined,
      // #265 item 4 — the ZM's deferral decision reaches the primitive, so #249's existing confirm
      // flow is reachable from the escalation queue instead of dead-ending in a 404.
      { confirm: body.confirm, reasonCode: body.reasonCode },
    );
    if (out.result === 'NOT_FOUND') throw new NotFoundException({ code: 'INSERTION_OR_SE_NOT_FOUND' });
    if (out.result === 'ALREADY_ASSIGNED') throw new ConflictException({ code: 'TICKET_ALREADY_ASSIGNED' });
    // Mirrors the `/schedules/assign` mapping for the identical outcomes, so one ticket held to a
    // future date answers the same way whichever door the manager came through.
    if (out.result === 'CONFLICT_DEFERRED') {
      throw new ConflictException({
        code: 'CONFLICT_DEFERRED',
        message: 'Ticket is held to a future vehicle-return date — resend with confirm=true and a reason.',
        ticketId: out.ticketId,
        deferredUntil: out.deferredUntil,
        vuReport: out.vuReport,
      });
    }
    if (out.result === 'REASON_REQUIRED') {
      throw new BadRequestException({ code: 'DEFERRAL_OVERRIDE_REASON_REQUIRED' });
    }
    return out;
  }
}
