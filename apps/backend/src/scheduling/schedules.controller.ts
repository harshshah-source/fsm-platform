import {
  Body,
  ConflictException,
  Controller,
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
import { DayPlanQueryService, type DayPlanView } from './day-plan-query.service';
import { OverrideService, type AssignOutcome } from './override.service';
import {
  ZmScheduleQueryService,
  type ZmScheduleDetail,
  type ZmScheduleRow,
  type ZoneEngineerRow,
} from './zm-schedule-query.service';

const MANAGER_ROLES = ['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD'] as const;

/**
 * The `/api/schedules/*` surface. `me` (SE) returns the authenticated SE's dispatched Day Plan
 * (Issue 11). The manager-roled monitoring reads (Issue 13a) — the per-SE schedule list and the
 * ordered-stop detail with Recommender reasoning — are zone-scoped for a ZM; CSM / Operations Head
 * see all zones. `assign` is the Grouped Critical Work Queue one-click assign. Overrides go through
 * the batches controller.
 */
@Controller('schedules')
@UseGuards(AuthGuard, RoleGuard)
export class SchedulesController {
  constructor(
    private readonly dayPlan: DayPlanQueryService,
    private readonly zm: ZmScheduleQueryService,
    private readonly override: OverrideService,
  ) {}

  @Get('me')
  @Roles('SERVICE_ENGINEER')
  me(@CurrentUser() user: AccessTokenClaims): Promise<DayPlanView> {
    return this.dayPlan.getDayPlan(user.user_id);
  }

  @Post('assign')
  @HttpCode(200)
  @Roles(...MANAGER_ROLES)
  async assign(
    @CurrentUser() user: AccessTokenClaims,
    @Body() body: { ticketId: string; seId: string },
  ): Promise<AssignOutcome> {
    const outcome = await this.override.assignTicket(
      body.ticketId,
      body.seId,
      { role: user.role, zoneId: user.zone_id },
      { userId: user.user_id, role: user.role, actedAsRole: null },
    );
    if (outcome.result === 'NOT_FOUND') throw new NotFoundException({ code: 'TICKET_OR_SE_NOT_FOUND' });
    if (outcome.result === 'ALREADY_ASSIGNED') throw new ConflictException({ code: 'TICKET_ALREADY_ASSIGNED' });
    return outcome;
  }

  @Get()
  @Roles(...MANAGER_ROLES)
  list(@CurrentUser() user: AccessTokenClaims): Promise<ZmScheduleRow[]> {
    return this.zm.listSchedules({ role: user.role, zoneId: user.zone_id });
  }

  // Static route — must be declared before `:engineerId` so it is not captured as a param.
  @Get('engineers')
  @Roles(...MANAGER_ROLES)
  zoneEngineers(@CurrentUser() user: AccessTokenClaims): Promise<ZoneEngineerRow[]> {
    return this.zm.listZoneEngineers({ role: user.role, zoneId: user.zone_id });
  }

  @Get(':engineerId')
  @Roles(...MANAGER_ROLES)
  async detail(
    @CurrentUser() user: AccessTokenClaims,
    @Param('engineerId') engineerId: string,
  ): Promise<ZmScheduleDetail> {
    const detail = await this.zm.getScheduleDetail(engineerId, { role: user.role, zoneId: user.zone_id });
    if (!detail) throw new NotFoundException({ code: 'SCHEDULE_NOT_FOUND' });
    return detail;
  }
}
