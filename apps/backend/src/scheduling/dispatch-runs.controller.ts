import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import {
  DispatchTransparencyQueryService,
  type DispatchBatchDetail,
  type DispatchRunDetail,
  type DispatchRunListRow,
  type DispatchTicketTrace,
  type DispatchZoneDetail,
} from './dispatch-transparency-query.service';
import type { ZmScope } from './zm-schedule-query.service';

const MANAGER_ROLES = ['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD'] as const;

/**
 * Batch-Assignment transparency drill-down (`/api/dispatch-runs/*`): runs list → run detail
 * (config-in-effect panel + per-zone cards) → zone batches → assignment rows → per-ticket decision
 * trace. Manager-roled; a ZONAL_MANAGER is zone-clamped at every level (list totals and run-detail
 * cards are filtered to their zone).
 *
 * Foreign-zone reads differ by route, and the docstring states each one's ACTUAL behavior rather
 * than promising a uniform rule the platform prevents:
 *   - zone detail (`/:runId/zones/:zoneId`) — the global {@link ZoneScopeGuard} (#99) rejects a ZM's
 *     cross-zone `:zoneId` with 403 ZONE_SCOPE_VIOLATION, the platform-standard zone-scope response;
 *   - batch (`/:runId/batches/:batchId`) and trace (`/:runId/tickets/:ticketId/trace`) — no `:zoneId`
 *     param, so the guard doesn't fire; the service-level zone clamp returns 404 instead.
 */
@Controller('dispatch-runs')
@UseGuards(AuthGuard, RoleGuard)
export class DispatchRunsController {
  constructor(private readonly query: DispatchTransparencyQueryService) {}

  @Get()
  @Roles(...MANAGER_ROLES)
  list(@CurrentUser() user: AccessTokenClaims, @Query('limit') limit?: string): Promise<DispatchRunListRow[]> {
    const parsed = Number(limit);
    const take = Number.isInteger(parsed) && parsed > 0 && parsed <= 100 ? parsed : 30;
    return this.query.listRuns(this.scope(user), take);
  }

  @Get(':runId')
  @Roles(...MANAGER_ROLES)
  async detail(@CurrentUser() user: AccessTokenClaims, @Param('runId') runId: string): Promise<DispatchRunDetail> {
    const detail = await this.query.getRunDetail(parseId(runId), this.scope(user));
    if (!detail) throw new NotFoundException({ code: 'DISPATCH_RUN_NOT_FOUND' });
    return detail;
  }

  @Get(':runId/zones/:zoneId')
  @Roles(...MANAGER_ROLES)
  async zoneDetail(
    @CurrentUser() user: AccessTokenClaims,
    @Param('runId') runId: string,
    @Param('zoneId') zoneId: string,
  ): Promise<DispatchZoneDetail> {
    const detail = await this.query.getZoneDetail(parseId(runId), parseId(zoneId), this.scope(user));
    if (!detail) throw new NotFoundException({ code: 'DISPATCH_RUN_ZONE_NOT_FOUND' });
    return detail;
  }

  @Get(':runId/batches/:batchId')
  @Roles(...MANAGER_ROLES)
  async batchDetail(
    @CurrentUser() user: AccessTokenClaims,
    @Param('runId') runId: string,
    @Param('batchId') batchId: string,
  ): Promise<DispatchBatchDetail> {
    const detail = await this.query.getBatchDetail(parseId(runId), parseId(batchId), this.scope(user));
    if (!detail) throw new NotFoundException({ code: 'DISPATCH_BATCH_NOT_FOUND' });
    return detail;
  }

  @Get(':runId/tickets/:ticketId/trace')
  @Roles(...MANAGER_ROLES)
  async ticketTrace(
    @CurrentUser() user: AccessTokenClaims,
    @Param('runId') runId: string,
    @Param('ticketId', new ParseUUIDPipe()) ticketId: string,
  ): Promise<DispatchTicketTrace> {
    const trace = await this.query.getTicketTrace(parseId(runId), ticketId, this.scope(user));
    if (!trace) throw new NotFoundException({ code: 'DISPATCH_TRACE_NOT_FOUND' });
    return trace;
  }

  private scope(user: AccessTokenClaims): ZmScope {
    return { role: user.role, zoneId: user.zone_id };
  }
}

/** Numeric path id → bigint; malformed ids read as absent resources (404), not 500s. */
function parseId(raw: string): bigint {
  try {
    const id = BigInt(raw);
    if (id < 0n) throw new Error('negative');
    return id;
  } catch {
    throw new NotFoundException({ code: 'DISPATCH_RUN_NOT_FOUND' });
  }
}
