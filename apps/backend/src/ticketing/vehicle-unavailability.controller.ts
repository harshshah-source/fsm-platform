import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
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
import { type VehicleUnavailReason } from '../generated/prisma/enums';
import {
  VehicleUnavailabilityService,
  type VehicleUnavailRow,
  type VuDecisionOutcome,
  type VuFileOutcome,
  type VuOutcome,
  type VuResumeOutcome,
} from './vehicle-unavailability.service';

const REASONS: readonly VehicleUnavailReason[] = [
  'VEHICLE_ON_TRIP',
  'VEHICLE_NOT_AT_PLANT',
  'DRIVER_NOT_AVAILABLE',
  'CUSTOMER_REFUSED',
  'OTHER',
];
const MANAGER_ROLES = ['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD'] as const;

interface FileBody {
  ticketId: string;
  seId: string;
  reasonCode: VehicleUnavailReason;
  transporterContacted?: boolean;
  transporterName?: string | null;
  transporterContact?: string | null;
  expectedFrom: string;
  expectedTo?: string | null;
  notes?: string | null;
  gpsLat?: number | null;
  gpsLng?: number | null;
}

/**
 * Vehicle Unavailability surface (Issue 28, `/api/vehicle-unavailability`). The SE files a report
 * (pausing the primary SLA); managers read the zone list with BOTH SLA clocks (the secondary,
 * never-pausing clock is manager-only by being on this manager endpoint), decide the return date, or
 * manually resume the SLA.
 *
 * #245 split the old `confirm-date` leg in two. `approve` accepts the SE's proposed date; `override`
 * replaces it and requires a reason. Both stamp the decision on the row and write an audit entry in
 * the same transaction — `confirm-date` did neither, which is why it is retired rather than kept as
 * an alias: a caller silently getting the unaudited behaviour is the failure mode being removed.
 *
 * Scope comes from the claims (`zone_id`) as everywhere else here; the acting identity comes from
 * `@CurrentActor` and is used only for audit attribution, so an acted-as decision is attributable.
 */
@Controller('vehicle-unavailability')
@UseGuards(AuthGuard, RoleGuard)
export class VehicleUnavailabilityController {
  constructor(private readonly vu: VehicleUnavailabilityService) {}

  @Post()
  @Roles('SERVICE_ENGINEER', ...MANAGER_ROLES)
  async file(
    @CurrentScope() scope: ManagerScope,
    @CurrentUser() user: AccessTokenClaims,
    @CurrentActor() actor: RequestActor,
    @Body() body: FileBody,
  ): Promise<Extract<VuFileOutcome, { result: 'OK' }>> {
    if (!body.ticketId || !body.seId) throw new BadRequestException({ code: 'TICKET_AND_SE_REQUIRED' });
    if (!REASONS.includes(body.reasonCode)) throw new BadRequestException({ code: 'INVALID_REASON' });
    const expectedFrom = new Date(body.expectedFrom);
    if (Number.isNaN(expectedFrom.getTime())) throw new BadRequestException({ code: 'INVALID_EXPECTED_FROM' });
    const expectedTo = body.expectedTo != null ? new Date(body.expectedTo) : null;
    if (expectedTo && Number.isNaN(expectedTo.getTime())) throw new BadRequestException({ code: 'INVALID_EXPECTED_TO' });

    return this.map(
      await this.vu.fileReport(
        {
          ticketId: body.ticketId,
          seId: body.seId,
          reasonCode: body.reasonCode,
          transporterContacted: body.transporterContacted ?? false,
          transporterName: body.transporterName ?? null,
          transporterContact: body.transporterContact ?? null,
          expectedFrom,
          expectedTo,
          notes: body.notes ?? null,
          gpsLat: body.gpsLat ?? null,
          gpsLng: body.gpsLng ?? null,
        },
        // Scope decides what the caller may touch (#341, unchanged); the actor decides how the audit
        // row is attributed (#340). Both are needed and they answer different questions — spreading
        // the actor's `zoneId` over the scope here would quietly widen a narrowed write door.
        { ...scope, userId: user.user_id, actedAsRole: actor.actedAsRole, actingZone: actor.actingZone },
      ),
    );
  }

  @Get()
  @Roles(...MANAGER_ROLES)
  list(@CurrentScope() scope: ManagerScope): Promise<VehicleUnavailRow[]> {
    return this.vu.listForZone(scope);
  }

  /**
   * The supersession chain for whichever ticket this report belongs to — every report it ever had,
   * newest first. Keyed by report id rather than ticket id so it cannot collide with the `:id` legs.
   */
  @Get(':id/history')
  @Roles(...MANAGER_ROLES)
  async history(
    @CurrentScope() scope: ManagerScope,
    @CurrentUser() user: AccessTokenClaims,
    @Param('id') id: string,
  ): Promise<VehicleUnavailRow[]> {
    const out = await this.vu.historyForReport(id, { ...scope, userId: user.user_id });
    if (out.result === 'NOT_FOUND') throw new NotFoundException({ code: 'VU_NOT_FOUND' });
    if (out.result === 'FORBIDDEN') throw new ForbiddenException({ code: 'VU_FORBIDDEN' });
    return out.rows;
  }

  /**
   * Retired by #245. Answered rather than deleted so a stale client learns *why* its write did
   * nothing, instead of reading a 404 as "wrong id" and retrying forever.
   */
  @Post(':id/confirm-date')
  @Roles(...MANAGER_ROLES)
  confirmDate(): never {
    throw new HttpException(
      {
        code: 'VU_CONFIRM_DATE_RETIRED',
        message: 'Retired by #245 — use POST /vehicle-unavailability/:id/approve or /override.',
      },
      HttpStatus.GONE,
    );
  }

  @Post(':id/approve')
  @HttpCode(200)
  @Roles(...MANAGER_ROLES)
  async approve(
    @CurrentUser() user: AccessTokenClaims,
    @CurrentActor() actor: RequestActor,
    @Param('id') id: string,
  ): Promise<VuOutcome> {
    return this.map(
      await this.vu.approve(id, actor),
    );
  }

  @Post(':id/override')
  @HttpCode(200)
  @Roles(...MANAGER_ROLES)
  async override(
    @CurrentUser() user: AccessTokenClaims,
    @CurrentActor() actor: RequestActor,
    @Param('id') id: string,
    @Body() body: { expectedFrom: string; reason: string },
  ): Promise<VuOutcome> {
    const expectedFrom = new Date(body?.expectedFrom ?? '');
    if (Number.isNaN(expectedFrom.getTime())) throw new BadRequestException({ code: 'INVALID_EXPECTED_FROM' });
    return this.map(
      await this.vu.override(
        id,
        { expectedFrom, reason: body?.reason ?? '' },
        actor,
      ),
    );
  }

  @Post(':id/resume-sla')
  @HttpCode(200)
  @Roles(...MANAGER_ROLES)
  async resume(
    @CurrentScope() scope: ManagerScope,
    @CurrentUser() user: AccessTokenClaims,
    @CurrentActor() actor: RequestActor,
    @Param('id') id: string,
  ): Promise<VuResumeOutcome> {
    return this.map(
      await this.vu.resumeSla(id, {
        ...scope,
        userId: user.user_id,
        actedAsRole: actor.actedAsRole,
        actingZone: actor.actingZone,
      }),
    );
  }

  /**
   * The one place a service outcome becomes an HTTP status. Generic so filing — whose OK variant
   * carries the derived `deferredUntil` (#246) — keeps that field instead of being widened away by a
   * shared return type.
   */
  private map<T extends VuDecisionOutcome | VuFileOutcome | VuResumeOutcome>(outcome: T): Extract<T, { result: 'OK' }> {
    if (outcome.result === 'NOT_FOUND') throw new NotFoundException({ code: 'VU_NOT_FOUND' });
    if (outcome.result === 'FORBIDDEN') throw new ForbiddenException({ code: 'VU_FORBIDDEN' });
    if (outcome.result === 'REASON_REQUIRED') throw new BadRequestException({ code: 'VU_OVERRIDE_REASON_REQUIRED' });
    // Business 409 (CONTEXT §Business 409 Conflict) — the report stopped being the live one while
    // the manager was looking at it. Distinct from a missing row, and the client should re-read.
    if (outcome.result === 'NOT_DECIDABLE') {
      throw new ConflictException({ code: 'VU_NOT_DECIDABLE', status: outcome.status });
    }
    // Narrowed by the four throws above; TS cannot see that through the generic.
    return outcome as Extract<T, { result: 'OK' }>;
  }
}
