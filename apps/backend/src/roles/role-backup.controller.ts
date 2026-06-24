import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import { type Role } from '../generated/prisma/enums';
import { type CsmBackupZoneRow, type MarkOutcome, RoleBackupService } from './role-backup.service';

const ROLES: readonly Role[] = ['SERVICE_ENGINEER', 'ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD', 'WAREHOUSE_MANAGER'];

interface MarkBody {
  role: Role;
  zoneId?: number | null;
  userId?: string | null;
  windowStart: string;
  windowEnd?: string | null;
  reason?: string | null;
}

/**
 * Role backup cascade surface (Issue 27). `POST /api/role-unavailability` (Operations Head / CSM)
 * records a role-out window driving the cascade; `GET /api/reports/csm-approval-share` (Operations
 * Head) returns the per-zone CSM-backup share for a month so routine ZM backup is visible.
 */
@Controller()
@UseGuards(AuthGuard, RoleGuard)
export class RoleBackupController {
  constructor(private readonly roles: RoleBackupService) {}

  @Post('role-unavailability')
  @HttpCode(201)
  @Roles('OPERATIONS_HEAD', 'CENTRAL_SERVICE_MANAGER')
  async mark(@CurrentUser() user: AccessTokenClaims, @Body() body: MarkBody): Promise<MarkOutcome> {
    if (!ROLES.includes(body.role)) throw new BadRequestException({ code: 'INVALID_ROLE' });
    const windowStart = new Date(body.windowStart);
    if (Number.isNaN(windowStart.getTime())) throw new BadRequestException({ code: 'INVALID_WINDOW_START' });
    const windowEnd = body.windowEnd != null ? new Date(body.windowEnd) : null;
    if (windowEnd && Number.isNaN(windowEnd.getTime())) throw new BadRequestException({ code: 'INVALID_WINDOW_END' });

    const outcome = await this.roles.markUnavailable(
      { role: body.role, zoneId: body.zoneId ?? null, userId: body.userId ?? null, windowStart, windowEnd, reason: body.reason ?? null },
      { userId: user.user_id, role: user.role, zoneId: user.zone_id },
    );
    if (outcome.result === 'FORBIDDEN') throw new ForbiddenException({ code: 'ROLE_MARK_FORBIDDEN' });
    return outcome;
  }

  @Get('reports/csm-approval-share')
  @Roles('OPERATIONS_HEAD')
  report(@Query('month') month?: string): Promise<CsmBackupZoneRow[]> {
    const { start, end } = monthRange(month);
    return this.roles.csmBackupShareByZone(start, end);
  }
}

/** Resolve a `YYYY-MM` query (default: the current calendar month) to a [start, end) UTC range. */
function monthRange(month: string | undefined): { start: Date; end: Date } {
  const now = new Date();
  let year = now.getUTCFullYear();
  let m = now.getUTCMonth(); // 0-based
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    const [y, mm] = month.split('-').map(Number);
    year = y;
    m = mm - 1;
  }
  return { start: new Date(Date.UTC(year, m, 1)), end: new Date(Date.UTC(year, m + 1, 1)) };
}
