import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentScope } from '../common/decorators/current-scope.decorator';
import type { ManagerScope } from '../common/manager-scope';
import { toBigIntId } from '../common/parse-id';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import { SameDayUpdateService, type IntradayUpdatePage } from './same-day-update.service';

const MANAGER_ROLES = ['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD'] as const;

/**
 * The `/api/intraday-updates` surface (Issue 31) — **read-only since #356**.
 *
 * `GET` is the Intra-day Queue's MANUAL_ZM_UPDATE stream, zone-scoped by the service and bounded to a
 * page. The `add` / `remove` / `reorder` writes are deleted: #313 made `POST /batches/:id/override`
 * the single same-day write surface and nothing had called these three since — zero references in
 * `apps/admin`, and `dispatch-changes-today.service.ts` says as much in its own docstring. Keeping
 * them live would keep three separate validations, three error vocabularies and a second audit action
 * in service of no caller, and would keep offering a door that looks supported and is not. Recorded
 * decision: plan §7, "356 deletion".
 *
 * Distinct from the system-triggered CRITICAL insertion surface (`/api/intraday-insertions`, Issue 29).
 */
@Controller('intraday-updates')
@UseGuards(AuthGuard, RoleGuard)
export class IntradayUpdatesController {
  constructor(private readonly sameDay: SameDayUpdateService) {}

  @Get()
  @Roles(...MANAGER_ROLES)
  list(
    @CurrentScope() scope: ManagerScope,
    @Query() q: { take?: string; since?: string; cursor?: string },
  ): Promise<IntradayUpdatePage> {
    return this.sameDay.listIntradayUpdates(scope, {
      take: parseTake(q.take),
      since: parseSince(q.since),
      cursor: parseCursor(q.cursor),
    });
  }
}

/**
 * #356 — the same query vocabulary the insertions read takes. Spelled out here rather than shared:
 * the two controllers live in different modules, and a two-function "query-parsing library" reaching
 * across a module boundary would be a heavier coupling than the duplication it saves.
 *
 * Each malformed value is a 400 rather than a silent fallback to the default, for the reason the
 * insertions controller gives at length: a filter that appears to apply and does not is the queue
 * lying to the person deciding where engineers go.
 */
function parseTake(raw: string | undefined): number | undefined {
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new BadRequestException({ code: 'INVALID_TAKE' });
  return n;
}

function parseSince(raw: string | undefined): Date | undefined {
  if (raw == null || raw === '') return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new BadRequestException({ code: 'INVALID_SINCE' });
  return d;
}

function parseCursor(raw: string | undefined): bigint | undefined {
  if (raw == null || raw === '') return undefined;
  const id = toBigIntId(raw);
  if (id === null) throw new BadRequestException({ code: 'INVALID_CURSOR' });
  return id;
}
