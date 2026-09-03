import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { auditActor, AuditService } from '../audit/audit.service';
import { CurrentActor } from '../common/decorators/current-actor.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import { toBigIntId } from '../common/parse-id';
import type { RequestActor } from '../common/request-actor';
import { type Role } from '../generated/prisma/enums';
import {
  type CsmBackupZoneRow,
  type MarkOutcome,
  RoleBackupService,
  type UnavailabilityRow,
} from './role-backup.service';

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
  constructor(
    private readonly roles: RoleBackupService,
    private readonly audit: AuditService,
  ) {}

  @Post('role-unavailability')
  @HttpCode(201)
  @Roles('OPERATIONS_HEAD', 'CENTRAL_SERVICE_MANAGER')
  async mark(@CurrentActor() actor: RequestActor, @Body() body: MarkBody): Promise<MarkOutcome> {
    if (!ROLES.includes(body.role)) throw new BadRequestException({ code: 'INVALID_ROLE' });
    const windowStart = new Date(body.windowStart);
    if (Number.isNaN(windowStart.getTime())) throw new BadRequestException({ code: 'INVALID_WINDOW_START' });
    const windowEnd = body.windowEnd != null ? new Date(body.windowEnd) : null;
    if (windowEnd && Number.isNaN(windowEnd.getTime())) throw new BadRequestException({ code: 'INVALID_WINDOW_END' });

    const outcome = await this.roles.markUnavailable(
      { role: body.role, zoneId: body.zoneId ?? null, userId: body.userId ?? null, windowStart, windowEnd, reason: body.reason ?? null },
      actor,
    );
    if (outcome.result === 'FORBIDDEN') throw new ForbiddenException({ code: 'ROLE_MARK_FORBIDDEN' });
    return outcome;
  }

  /**
   * #339 AC4 — the windows an operator opened, so Settings can show what is currently delegated.
   * Without a read, `POST /role-unavailability` was a write-only door: an OH could open a window and
   * had no way to see it again, let alone end it.
   */
  @Get('role-unavailability')
  @Roles('OPERATIONS_HEAD', 'CENTRAL_SERVICE_MANAGER')
  list(@Query('open') open?: string): Promise<UnavailabilityRow[]> {
    return this.roles.listUnavailability({ openOnly: open === 'true' });
  }

  /**
   * #339 AC4 — end a window **now** rather than delete the row. The cascade reads these by time and
   * the audit trail reads them as history: a deleted window would erase the record of who was covering
   * a zone while decisions were being made in it.
   */
  @Delete('role-unavailability/:id')
  @Roles('OPERATIONS_HEAD', 'CENTRAL_SERVICE_MANAGER')
  async end(@Param('id') id: string, @CurrentActor() actor: RequestActor): Promise<{ result: 'OK' }> {
    const windowId = toBigIntId(id);
    if (windowId === null) throw new BadRequestException({ code: 'INVALID_UNAVAILABILITY_ID' });
    const outcome = await this.roles.endUnavailability(windowId, new Date());
    if (outcome.result === 'NOT_FOUND') throw new BadRequestException({ code: 'UNAVAILABILITY_NOT_FOUND' });
    await this.audit.record({
      ...auditActor(actor),
      action: 'ROLE_UNAVAILABILITY_ENDED',
      entityType: 'role_unavailability',
      entityId: String(windowId),
      metadata: { role: outcome.role, zoneId: outcome.zoneId },
    });
    return { result: 'OK' };
  }

  /**
   * #339 AC5 — entering and leaving acting are on the record.
   *
   * The gate has already run by the time this method is reached (`ActingContextGuard` is global), so
   * an entry can only be recorded for an acting session that was actually permitted — which is why
   * there is no re-check here and why the no-window case 403s before it arrives.
   */
  @Post('acting/enter')
  @HttpCode(201)
  @Roles('OPERATIONS_HEAD', 'CENTRAL_SERVICE_MANAGER')
  enter(@CurrentActor() actor: RequestActor): Promise<{ result: 'OK' }> {
    return this.recordActing('ACTING_STARTED', actor);
  }

  @Post('acting/exit')
  @HttpCode(201)
  @Roles('OPERATIONS_HEAD', 'CENTRAL_SERVICE_MANAGER')
  exit(@CurrentActor() actor: RequestActor): Promise<{ result: 'OK' }> {
    return this.recordActing('ACTING_ENDED', actor);
  }

  private async recordActing(action: 'ACTING_STARTED' | 'ACTING_ENDED', actor: RequestActor): Promise<{ result: 'OK' }> {
    // `acting_zone` is the whole value of the row: "who acted" is already in `actor_id`, and the
    // CSM-backup share report (Issue 27 AC#5) groups on this column.
    if (actor.actingZone === null) throw new BadRequestException({ code: 'ACTING_ZONE_REQUIRED' });
    await this.audit.record({
      ...auditActor(actor),
      action,
      entityType: 'zones',
      entityId: String(actor.actingZone),
    });
    return { result: 'OK' };
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
