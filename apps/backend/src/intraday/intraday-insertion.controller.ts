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
import { CurrentActor } from '../common/decorators/current-actor.decorator';
import { CurrentScope } from '../common/decorators/current-scope.decorator';
import type { ManagerScope } from '../common/manager-scope';
import type { RequestActor } from '../common/request-actor';
import { toBigIntId } from '../common/parse-id';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import type { CandidateRow } from '../scheduling/candidate-query.service';
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
  list(@CurrentScope() scope: ManagerScope): Promise<IntradayInsertionRow[]> {
    return this.svc.listForScope(scope);
  }

  /** Qualifying-event sweep — direct-assign newly-CRITICAL tickets in a zone, or escalate. */
  @Post('fire')
  @HttpCode(200)
  @Roles(...MANAGER_ROLES)
  async fire(
    @CurrentScope() scope: ManagerScope,
    @Body() body: { zoneId?: number | string },
  ): Promise<CriticalAssignOutcome> {
    // #341 — a caller who is clamped to a zone sweeps that zone, and `body.zoneId` cannot widen it.
    // That was already true for a ZM (their claims zone won); it is now equally true for a CSM or
    // Operations Head **acting** in a zone, because `resolveManagerScope` collapses them to it. An
    // unclamped manager still names the zone in the body, which is the only way they could.
    const raw = scope.zoneId ?? body.zoneId;
    if (raw == null) throw new BadRequestException({ code: 'ZONE_REQUIRED' });
    // #310 (CB-9) — a 400 and not a 404: the zone is the sweep's *argument*, not a resource this route
    // fetches, so a caller who names it wrong has made a malformed request, not asked for a missing one.
    const zoneId = toBigIntId(raw);
    if (zoneId === null) throw new BadRequestException({ code: 'INVALID_ZONE_ID' });
    return this.svc.assignCriticalForZone(zoneId);
  }

  /**
   * AVAILABLE SEs for the ZM manual-assignment modal (Issue 30 — availability only, never ping age),
   * as #274's candidate row (#277) — never a bare UUID.
   */
  @Get(':id/available-ses')
  @Roles(...MANAGER_ROLES)
  availableSes(@CurrentScope() scope: ManagerScope, @Param('id') id: string): Promise<CandidateRow[]> {
    const insertionId = toBigIntId(id);
    if (insertionId === null) throw new NotFoundException({ code: 'INSERTION_NOT_FOUND' });
    return this.svc.availableSesForManualAssign(insertionId, scope);
  }

  @Post(':id/manual-assign')
  @HttpCode(200)
  @Roles(...MANAGER_ROLES)
  async manualAssign(
    @CurrentScope() scope: ManagerScope,
    @CurrentActor() actor: RequestActor,
    @Param('id') id: string,
    @Body() body: { seId: string; confirm?: boolean; reasonCode?: string },
  ) {
    if (!body.seId) throw new BadRequestException({ code: 'SE_REQUIRED' });
    const insertionId = toBigIntId(id);
    if (insertionId === null) throw new NotFoundException({ code: 'INSERTION_OR_SE_NOT_FOUND' });
    const out = await this.svc.manualAssign(
      insertionId,
      body.seId,
      actor,
      scope,
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
