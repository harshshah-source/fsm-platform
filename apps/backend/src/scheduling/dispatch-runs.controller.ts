import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import {
  DispatchTransparencyQueryService,
  type DispatchBatchDetail,
  type DispatchRunDecisions,
  type DispatchRunDetail,
  type DispatchRunListRow,
  type DispatchTicketTrace,
  type DispatchZoneDetail,
} from './dispatch-transparency-query.service';
import type { ZmScope } from './zm-schedule-query.service';

const MANAGER_ROLES = ['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD'] as const;

/**
 * Batch-Assignment transparency drill-down (`/api/dispatch-runs/*`): runs list → run detail
 * (config-in-effect panel + per-zone cards) → zone batches → per-ticket decision trace. Manager-roled;
 * a ZONAL_MANAGER is zone-clamped at every level (list totals and run-detail cards are filtered to
 * their zone).
 *
 * Batch detail is deliberately NOT here: a batch is addressed by its own id at `GET /api/batches/:id`
 * (BatchesController), because most live batches have no `run_id` and a run-scoped path left them
 * unreachable. The zone drill-down links out to that route.
 *
 * Foreign-zone reads differ by route, and the docstring states each one's ACTUAL behavior rather
 * than promising a uniform rule the platform prevents:
 *   - zone detail (`/:runId/zones/:zoneId`) — the global {@link ZoneScopeGuard} (#99) rejects a ZM's
 *     cross-zone `:zoneId` with 403 ZONE_SCOPE_VIOLATION, the platform-standard zone-scope response;
 *   - trace (`/:runId/tickets/:ticketId/trace`) — no `:zoneId` param, so the guard doesn't fire; the
 *     service-level zone clamp returns 404 instead;
 *   - decisions (`/:runId/decisions?zoneId=`) — camelCase query param, which the guard (which reads
 *     `:zoneId` / `?zone_id`) also does not see, so the service raises 403 ZONE_SCOPE_VIOLATION itself.
 *     Refusing rather than substituting the ZM's own zone: answering a question nobody asked is worse
 *     than saying no.
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

  /**
   * #284 §C — Replay's stream: every decision this run made, in the engine's own processing order.
   *
   * `?zoneId` narrows a multi-zone run; a ZM is clamped to their own and is **refused** (403) rather
   * than silently answered with their zone if they name another one. `?limit`/`?offset` page it,
   * because a real zone's morning is hundreds of decisions.
   */
  @Get(':runId/decisions')
  @Roles(...MANAGER_ROLES)
  async decisions(
    @CurrentUser() user: AccessTokenClaims,
    @Param('runId') runId: string,
    @Query('zoneId') zoneId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<DispatchRunDecisions> {
    const decisions = await this.query.getRunDecisions(parseId(runId), this.scope(user), {
      zoneId: zoneId != null && zoneId !== '' ? parseId(zoneId) : undefined,
      limit: toPositiveInt(limit),
      offset: toPositiveInt(offset),
    });
    if (!decisions) throw new NotFoundException({ code: 'DISPATCH_RUN_NOT_FOUND' });
    return decisions;
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

/** A numeric query value, or `undefined` — the service owns the bounds, so garbage simply falls back. */
function toPositiveInt(raw: string | undefined): number | undefined {
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
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
