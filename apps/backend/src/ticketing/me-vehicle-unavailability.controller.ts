import { Controller, Get, UseGuards } from '@nestjs/common';
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import { MeVehicleUnavailRow, VehicleUnavailabilityService } from './vehicle-unavailability.service';

/** `GET /api/me/vehicle-unavailability` (#163 item 6) — the SE-readable variant of the manager-only
 *  `GET /vehicle-unavailability`. See `VehicleUnavailabilityService.bySe`'s doc comment for the
 *  withheld-field rationale (`secondarySlaSeconds` stays manager-only). */
@Controller('me/vehicle-unavailability')
@UseGuards(AuthGuard, RoleGuard)
export class MeVehicleUnavailabilityController {
  constructor(private readonly vu: VehicleUnavailabilityService) {}

  @Get()
  @Roles('SERVICE_ENGINEER')
  async list(@CurrentUser() user: AccessTokenClaims): Promise<{ items: MeVehicleUnavailRow[]; cursor: null }> {
    const items = await this.vu.bySe(user.user_id);
    return { items, cursor: null };
  }
}
