import { BadRequestException, Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentScope } from '../common/decorators/current-scope.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import type { ManagerScope } from '../common/manager-scope';
import {
  DispatchChangesTodayService,
  type DispatchChangesTodayView,
} from './dispatch-changes-today.service';
import {
  DispatchTodayQueryService,
  type CardSummary,
  type DispatchTodayView,
} from './dispatch-today-query.service';
import { CardSummariesDto } from './dto/card-summaries.dto';

const MANAGER_ROLES = ['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD'] as const;

/**
 * The Today's Dispatch cockpit's reads (#284, serving the #282-approved Crew Deck).
 *
 * Read-only by contract — the cockpit's writes go to the endpoints that already own them
 * (`POST /schedules/dispatch-run`, `POST /batches/:id/override`, the intraday manual-assign), because
 * #282 R5 forbids a second implementation of anything the engine already does.
 *
 * `@CurrentScope()` rather than a hand-rolled `scopeFor`: it is the acting-zone-aware standard, so a
 * CSM working a zone through `X-Acting-As-Zone` sees that zone's cockpit and a ZM can never widen
 * past their own.
 */
@Controller('dispatch')
@UseGuards(AuthGuard, RoleGuard)
export class DispatchTodayController {
  constructor(
    private readonly todayQuery: DispatchTodayQueryService,
    private readonly changesQuery: DispatchChangesTodayService,
  ) {}

  @Get('today')
  @Roles(...MANAGER_ROLES)
  today(@CurrentScope() scope: ManagerScope, @Query('zoneId') zoneId?: string): Promise<DispatchTodayView> {
    return this.todayQuery.today(scope, { zoneId: parseZoneId(zoneId, scope) });
  }

  @Get('changes-today')
  @Roles(...MANAGER_ROLES)
  changesToday(
    @CurrentScope() scope: ManagerScope,
    @Query('zoneId') zoneId?: string,
  ): Promise<DispatchChangesTodayView> {
    return this.changesQuery.changesToday(scope, { zoneId: parseZoneId(zoneId, scope) });
  }

  /**
   * #295 — the identity of every card visible on a **non-today** board column, in one request.
   *
   * A `POST` for a read, which this repo already does twice for the same reason (`distribute-preview`,
   * `override/preview`): the input is a list of ids that does not belong in a URL. It writes nothing,
   * takes no lock and opens no run — the service's only statements are `findMany`s.
   *
   * The alternative was widening `GET /schedules?detail=stops` with these fields. That read is
   * pan-zone and consumed by four other surfaces, so enriching it would make every one of them pay
   * for a join only the board needs.
   */
  @Post('card-summaries')
  @Roles(...MANAGER_ROLES)
  cardSummaries(
    @CurrentScope() scope: ManagerScope,
    @Body() body: CardSummariesDto,
    @Query('zoneId') zoneId?: string,
  ): Promise<{ summaries: CardSummary[] }> {
    return this.todayQuery.cardSummaries(scope, {
      zoneId: parseZoneId(zoneId, scope),
      ticketIds: body.ticketIds ?? [],
    });
  }
}

/**
 * The zone to read. A ZM has exactly one and need not name it; anyone broader must, because there is
 * no honest default — "all zones" is not a cockpit, it is a different product.
 */
function parseZoneId(raw: string | undefined, scope: ManagerScope): bigint {
  if (raw == null || raw === '') {
    if (scope.zoneId != null) return BigInt(scope.zoneId);
    throw new BadRequestException({ code: 'ZONE_REQUIRED', hint: 'zoneId is required for a multi-zone role' });
  }
  if (!/^\d+$/.test(raw)) {
    throw new BadRequestException({ code: 'INVALID_FILTER', hint: 'zoneId must be an integer' });
  }
  return BigInt(raw);
}
