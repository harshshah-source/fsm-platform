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
import { type VehicleUnavailReason } from '../generated/prisma/enums';
import {
  VehicleUnavailabilityService,
  type VehicleUnavailRow,
  type VuOutcome,
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
  expectedFrom: string;
  expectedTo?: string | null;
  notes?: string | null;
  gpsLat?: number | null;
  gpsLng?: number | null;
}

/**
 * Vehicle Unavailability surface (Issue 28, `/api/vehicle-unavailability`). The SE files a report
 * (pausing the primary SLA); managers read the zone list with BOTH SLA clocks (the secondary,
 * never-pausing clock is manager-only by being on this manager endpoint), confirm/edit the expected
 * date, or manually resume the SLA.
 */
@Controller('vehicle-unavailability')
@UseGuards(AuthGuard, RoleGuard)
export class VehicleUnavailabilityController {
  constructor(private readonly vu: VehicleUnavailabilityService) {}

  @Post()
  @Roles('SERVICE_ENGINEER', ...MANAGER_ROLES)
  async file(@CurrentUser() user: AccessTokenClaims, @Body() body: FileBody): Promise<VuOutcome> {
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
          expectedFrom,
          expectedTo,
          notes: body.notes ?? null,
          gpsLat: body.gpsLat ?? null,
          gpsLng: body.gpsLng ?? null,
        },
        { userId: user.user_id, role: user.role, zoneId: user.zone_id },
      ),
    );
  }

  @Get()
  @Roles(...MANAGER_ROLES)
  list(@CurrentUser() user: AccessTokenClaims): Promise<VehicleUnavailRow[]> {
    return this.vu.listForZone({ role: user.role, zoneId: user.zone_id });
  }

  @Post(':id/confirm-date')
  @HttpCode(200)
  @Roles(...MANAGER_ROLES)
  async confirmDate(
    @CurrentUser() user: AccessTokenClaims,
    @Param('id') id: string,
    @Body() body: { expectedFrom: string },
  ): Promise<VuOutcome> {
    const expectedFrom = new Date(body.expectedFrom);
    if (Number.isNaN(expectedFrom.getTime())) throw new BadRequestException({ code: 'INVALID_EXPECTED_FROM' });
    return this.map(await this.vu.confirmDate(id, expectedFrom, { userId: user.user_id, role: user.role, zoneId: user.zone_id }));
  }

  @Post(':id/resume-sla')
  @HttpCode(200)
  @Roles(...MANAGER_ROLES)
  async resume(@CurrentUser() user: AccessTokenClaims, @Param('id') id: string): Promise<VuOutcome> {
    return this.map(await this.vu.resumeSla(id, { userId: user.user_id, role: user.role, zoneId: user.zone_id }));
  }

  private map(outcome: VuOutcome): VuOutcome {
    if (outcome.result === 'NOT_FOUND') throw new NotFoundException({ code: 'VU_NOT_FOUND' });
    if (outcome.result === 'FORBIDDEN') throw new ForbiddenException({ code: 'VU_FORBIDDEN' });
    return outcome;
  }
}
