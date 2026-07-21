import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import { SoftInactiveCountService, type ZoneOperatingMode } from '../reports/soft-inactive-count.service';

/**
 * `GET /api/dashboard/operating-mode` (Issue 136 slice 1) — read-only legibility of the recommender's
 * per-zone operating mode. It surfaces the SAME DEFICIT/PREVENTIVE signal the recommender already reads
 * (`SoftInactiveCountService.modeForZone`); it changes nothing and configures nothing.
 *
 * Scope mirrors the other `/api/dashboard/*` reads: a ZM is clamped to their own zone (any `zoneId`
 * query is ignored); CSM / Operations Head get every zone, or one zone via `?zoneId=`. Lives here (not
 * on `DashboardService`) so the read leans on `SoftInactiveCountService`, its single source of truth.
 *
 * The response carries the internal `mode` enum — the admin FE maps it to plain language; the enum is
 * never rendered raw (Issue 136 vocabulary rule).
 */
@Controller('dashboard/operating-mode')
@UseGuards(AuthGuard, RoleGuard)
export class OperatingModeController {
  constructor(private readonly softInactive: SoftInactiveCountService) {}

  @Get()
  @Roles('ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD')
  operatingMode(
    @CurrentUser() user: AccessTokenClaims,
    @Query('zoneId') zoneId?: string,
  ): Promise<ZoneOperatingMode[]> {
    if (user.role === 'ZONAL_MANAGER') {
      // Clamp: a ZM always sees exactly their own zone, ignoring any zoneId param.
      if (user.zone_id == null) return Promise.resolve([]);
      return this.softInactive.operatingModes(BigInt(user.zone_id));
    }
    // OH / CSM: every zone, or a single zone when a valid zoneId is supplied.
    if (zoneId !== undefined && zoneId !== '') {
      if (!/^\d+$/.test(zoneId)) {
        throw new BadRequestException({ code: 'INVALID_FILTER', hint: 'zoneId must be an integer' });
      }
      return this.softInactive.operatingModes(BigInt(zoneId));
    }
    return this.softInactive.operatingModes();
  }
}
