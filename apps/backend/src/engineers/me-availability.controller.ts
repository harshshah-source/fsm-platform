import { Controller, Get, UseGuards } from '@nestjs/common';
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import { AvailabilityRow, SeAvailabilityService } from './se-availability.service';

/** `GET /api/me/availability` (#163 item 7) — the SE-readable variant of `availabilityRows` on the
 *  manager-only `GET /engineers/:seId` detail read. The SE can set their own availability
 *  (`POST /engineers/:seId/availability`, narrowed to SOFT_UNAVAILABLE) but had no way to read it
 *  back — #87's AC ("current availability state + active window shown") was unbuildable. */
@Controller('me/availability')
@UseGuards(AuthGuard, RoleGuard)
export class MeAvailabilityController {
  constructor(private readonly availability: SeAvailabilityService) {}

  @Get()
  @Roles('SERVICE_ENGINEER')
  async list(@CurrentUser() user: AccessTokenClaims): Promise<{ items: AvailabilityRow[]; cursor: null }> {
    const items = await this.availability.listWindows(user.user_id);
    return { items, cursor: null };
  }
}
