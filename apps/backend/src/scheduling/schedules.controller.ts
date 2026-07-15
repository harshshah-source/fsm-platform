import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import { BadRequestException } from '@nestjs/common';
import { DayPlanQueryService, type DayPlanView } from './day-plan-query.service';
import { DispatchRunService, type DispatchRunSummary } from './dispatch-run.service';
import { OverrideService, type AssignOutcome, type PlantAssignSummary } from './override.service';
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
    private readonly dispatchRun: DispatchRunService,
  ) {}

  /**
   * Issue 113 — manual override for the daily Recommender → Day-Plan dispatch run: force a run now
   * without waiting for the cron. Reuses the exact `runForActiveZones` path the scheduler tick drives.
   */
  @Post('dispatch-run')
  @HttpCode(200)
  @Roles('OPERATIONS_HEAD', 'CENTRAL_SERVICE_MANAGER')
  dispatchRunNow(@CurrentUser() user: AccessTokenClaims): Promise<DispatchRunSummary> {
    // MANUAL + actor land on the dispatch_runs ledger row and its audit bracket.
    return this.dispatchRun.runForActiveZones(new Date(), {
      trigger: 'MANUAL',
      actorUserId: user.user_id,
      actorRole: user.role,
    });
  }

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

  /**
   * Manual multi-plant SE assignment (Issue 122b, driven from the Device Detail page): assigns every
   * OPEN + UNASSIGNED ticket at the selected plants to the SE via the same assignTicket primitive.
   */
  @Post('assign-plants')
  @HttpCode(200)
  @Roles(...MANAGER_ROLES)
  async assignPlants(
    @CurrentUser() user: AccessTokenClaims,
    @Body() body: { seId: string; plantIds: string[] },
  ): Promise<PlantAssignSummary> {
    if (!body?.seId || !Array.isArray(body.plantIds) || body.plantIds.length === 0)
      throw new BadRequestException({ code: 'SE_AND_PLANTS_REQUIRED' });
    const outcome = await this.override.assignPlants(
      body.plantIds.map(String),
      body.seId,
      { role: user.role, zoneId: user.zone_id },
      { userId: user.user_id, role: user.role, actedAsRole: null },
    );
    if ('result' in outcome) throw new NotFoundException({ code: 'SE_NOT_FOUND' });
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
    @Param('engineerId', new ParseUUIDPipe()) engineerId: string,
  ): Promise<ZmScheduleDetail> {
    const detail = await this.zm.getScheduleDetail(engineerId, { role: user.role, zoneId: user.zone_id });
    if (!detail) throw new NotFoundException({ code: 'SCHEDULE_NOT_FOUND' });
    return detail;
  }
}
