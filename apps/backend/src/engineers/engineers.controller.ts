import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
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
import { type SeAvailabilityStatus } from '../generated/prisma/enums';
import {
  EngineersQueryService,
  type EngineerDetail,
  type EngineerListRow,
} from './engineers-query.service';
import { SeAvailabilityService, type SetAvailabilityOutcome } from './se-availability.service';

const MANAGER_ROLES = ['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD'] as const;

/** The statuses a manager/SE may actively set (CONTEXT §SE Availability). AVAILABLE is the implicit
 *  default outside any window; OFFLINE is a derived activity signal, never a set value. */
const SETTABLE_STATUSES: readonly SeAvailabilityStatus[] = ['ON_LEAVE', 'OFF_SHIFT', 'WEEKLY_OFF', 'SOFT_UNAVAILABLE'];

interface SetAvailabilityBody {
  status: SeAvailabilityStatus;
  windowStart: string;
  windowEnd?: string | null;
  reason?: string | null;
}

/**
 * The `/api/engineers/*` SE Management surface (Issue 25). `:seId/availability` writes a time-windowed
 * availability row; authorization (ZM own-zone / SE-self / CSM acting; never Operations Head) is owned
 * by `SeAvailabilityService`. Operations Head is excluded at the role gate — it has no setter role here.
 */
@Controller('engineers')
@UseGuards(AuthGuard, RoleGuard)
export class EngineersController {
  constructor(
    private readonly availability: SeAvailabilityService,
    private readonly query: EngineersQueryService,
  ) {}

  @Get()
  @Roles(...MANAGER_ROLES)
  list(@CurrentUser() user: AccessTokenClaims): Promise<EngineerListRow[]> {
    return this.query.listForZone({ role: user.role, zoneId: user.zone_id });
  }

  @Get(':seId')
  @Roles(...MANAGER_ROLES)
  async detail(
    @CurrentUser() user: AccessTokenClaims,
    @Param('seId', new ParseUUIDPipe()) seId: string,
  ): Promise<EngineerDetail> {
    const detail = await this.query.getDetail(seId, { role: user.role, zoneId: user.zone_id });
    if (!detail) throw new NotFoundException({ code: 'SE_NOT_FOUND' });
    return detail;
  }

  @Post(':seId/availability')
  @Roles('ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'SERVICE_ENGINEER')
  async setAvailability(
    @CurrentUser() user: AccessTokenClaims,
    @Param('seId', new ParseUUIDPipe()) seId: string,
    @Body() body: SetAvailabilityBody,
  ): Promise<SetAvailabilityOutcome> {
    if (!SETTABLE_STATUSES.includes(body.status)) {
      throw new BadRequestException({ code: 'INVALID_AVAILABILITY_STATUS' });
    }
    const windowStart = new Date(body.windowStart);
    if (Number.isNaN(windowStart.getTime())) {
      throw new BadRequestException({ code: 'INVALID_WINDOW_START' });
    }
    const windowEnd = body.windowEnd != null ? new Date(body.windowEnd) : null;
    if (windowEnd && Number.isNaN(windowEnd.getTime())) {
      throw new BadRequestException({ code: 'INVALID_WINDOW_END' });
    }

    const outcome = await this.availability.setAvailability(
      { seId, status: body.status, windowStart, windowEnd, reason: body.reason ?? null },
      { userId: user.user_id, role: user.role, zoneId: user.zone_id, actedAsRole: null },
    );
    if (outcome.result === 'NOT_FOUND') throw new NotFoundException({ code: 'SE_NOT_FOUND' });
    if (outcome.result === 'FORBIDDEN') throw new ForbiddenException({ code: 'AVAILABILITY_FORBIDDEN' });
    return outcome;
  }
}
