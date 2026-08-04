import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentActor } from '../common/decorators/current-actor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import type { RequestActor } from '../common/request-actor';
import { type SeAvailabilityStatus } from '../generated/prisma/enums';
import {
  EngineerAdminService,
  type EngineerAdminScope,
  type SeCoverageRow,
  type SeManagementRow,
} from './engineer-admin.service';
import {
  EngineersQueryService,
  type EngineerDetail,
  type EngineerListRow,
} from './engineers-query.service';
import { SeAvailabilityService, type SetAvailabilityOutcome } from './se-availability.service';

interface CreateSeBody {
  name?: string;
  phone?: string;
  email?: string;
  address?: string | null;
  zoneId?: number | string;
  coverageType?: string;
  dailyCapacity?: number | string;
}

interface UpdateSeBody extends CreateSeBody {}

interface StatusBody {
  active?: boolean;
}

interface CoverageBody {
  plantId?: number | string;
  coverageType?: string;
}

/** Coerce a body id (number | numeric string) → number, or 400. */
function reqNum(raw: number | string | undefined, field: string): number {
  const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
  if (!Number.isFinite(n)) throw new BadRequestException({ code: 'INVALID_NUMBER', field });
  return n;
}

const MANAGER_ROLES = ['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD'] as const;

/** The statuses a manager/SE may actively set (CONTEXT §SE Availability). AVAILABLE is settable too
 *  (#87/#162) — its only legal use is an SE clearing their own active SOFT_UNAVAILABLE window early
 *  (enforced in `SeAvailabilityService.setAvailability`, not here); OFFLINE is a derived activity
 *  signal, never a set value. */
const SETTABLE_STATUSES: readonly SeAvailabilityStatus[] = ['AVAILABLE', 'ON_LEAVE', 'OFF_SHIFT', 'WEEKLY_OFF', 'SOFT_UNAVAILABLE'];

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
    private readonly admin: EngineerAdminService,
  ) {}

  @Get()
  @Roles(...MANAGER_ROLES)
  list(@CurrentUser() user: AccessTokenClaims): Promise<EngineerListRow[]> {
    return this.query.listForZone({ role: user.role, zoneId: user.zone_id });
  }

  // ---- SE Management CRUD (Phase 4) — OH/CSM cross-zone, ZM home-zone-clamped, SE denied (MANAGER_ROLES).
  //      `directory` is declared BEFORE `:seId` so the static path is not captured by the uuid param route.

  /** SE Management directory: name / phone / email / address / zone / mapped plants / status, zone-scoped. */
  @Get('directory')
  @Roles(...MANAGER_ROLES)
  directory(@CurrentUser() user: AccessTokenClaims): Promise<SeManagementRow[]> {
    return this.admin.list(this.scope(user));
  }

  @Post()
  @Roles(...MANAGER_ROLES)
  create(
    @CurrentUser() user: AccessTokenClaims,
    @CurrentActor() actor: RequestActor,
    @Body() body: CreateSeBody,
  ): Promise<SeManagementRow> {
    return this.admin.createSe(
      {
        name: body.name ?? '',
        phone: body.phone ?? '',
        email: body.email ?? '',
        address: body.address ?? null,
        zoneId: reqNum(body.zoneId, 'zoneId'),
        coverageType: body.coverageType ?? '',
        dailyCapacity: reqNum(body.dailyCapacity, 'dailyCapacity'),
      },
      this.scope(user),
      actor,
    );
  }

  @Patch(':seId')
  @Roles(...MANAGER_ROLES)
  update(
    @CurrentUser() user: AccessTokenClaims,
    @CurrentActor() actor: RequestActor,
    @Param('seId', new ParseUUIDPipe()) seId: string,
    @Body() body: UpdateSeBody,
  ): Promise<SeManagementRow> {
    return this.admin.updateSe(
      seId,
      {
        name: body.name,
        phone: body.phone,
        email: body.email,
        address: body.address,
        zoneId: body.zoneId !== undefined ? reqNum(body.zoneId, 'zoneId') : undefined,
        coverageType: body.coverageType,
        dailyCapacity: body.dailyCapacity !== undefined ? reqNum(body.dailyCapacity, 'dailyCapacity') : undefined,
      },
      this.scope(user),
      actor,
    );
  }

  @Post(':seId/status')
  @Roles(...MANAGER_ROLES)
  setStatus(
    @CurrentUser() user: AccessTokenClaims,
    @CurrentActor() actor: RequestActor,
    @Param('seId', new ParseUUIDPipe()) seId: string,
    @Body() body: StatusBody,
  ): Promise<SeManagementRow> {
    if (typeof body.active !== 'boolean') throw new BadRequestException({ code: 'ACTIVE_REQUIRED' });
    return this.admin.setActive(seId, body.active, this.scope(user), actor);
  }

  @Post(':seId/coverage')
  @Roles(...MANAGER_ROLES)
  addCoverage(
    @CurrentUser() user: AccessTokenClaims,
    @CurrentActor() actor: RequestActor,
    @Param('seId', new ParseUUIDPipe()) seId: string,
    @Body() body: CoverageBody,
  ): Promise<SeCoverageRow> {
    return this.admin.addCoverage(seId, reqNum(body.plantId, 'plantId'), body.coverageType ?? '', this.scope(user), actor);
  }

  @Delete(':seId/coverage/:coverageId')
  @Roles(...MANAGER_ROLES)
  removeCoverage(
    @CurrentUser() user: AccessTokenClaims,
    @CurrentActor() actor: RequestActor,
    @Param('seId', new ParseUUIDPipe()) seId: string,
    @Param('coverageId') coverageId: string,
  ): Promise<{ id: number }> {
    return this.admin.removeCoverage(seId, reqNum(coverageId, 'coverageId'), this.scope(user), actor);
  }

  private scope(user: AccessTokenClaims): EngineerAdminScope {
    return { role: user.role, zoneId: user.zone_id, userId: user.user_id };
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
    // #87 (operator-settled 2026-07-28) — an SE-set window is always bounded, so the server's
    // auto-revert-at-to_ts story (PRD:615) actually applies; managers keep open-ended windows
    // (e.g. indefinite ON_LEAVE) for every status, self-set included.
    if (user.role === 'SERVICE_ENGINEER' && user.user_id === seId && windowEnd === null) {
      throw new BadRequestException({ code: 'WINDOW_END_REQUIRED' });
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
