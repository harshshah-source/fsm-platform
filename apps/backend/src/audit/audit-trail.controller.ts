import { BadRequestException, Controller, Get, NotFoundException, Param, Query, UseGuards } from '@nestjs/common';
import { CurrentScope } from '../common/decorators/current-scope.decorator';
import type { ManagerScope } from '../common/manager-scope';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import { type AuditSearchPage, type TicketAuditTrail, AuditTrailService } from './audit-trail.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The ledger never returns an unbounded page; #342 AC5. */
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/** Reject an over-long free-text filter before it reaches the database. */
const MAX_FILTER_LEN = 200;

/**
 * `/api/audit-trail` — the user-facing audit-trail viewer (Issue 03, widened by #342). Manager roles
 * only. `GET /audit-trail/tickets/:id` is the per-ticket chain (a ZM is scoped to tickets in their own
 * zone; out-of-zone / unknown → 404); `GET /audit-trail` is the searchable ledger behind the Audit
 * Trail page, zone-clamped through the same `@CurrentScope()` so acting narrows it identically.
 */
@Controller('audit-trail')
@UseGuards(AuthGuard, RoleGuard)
export class AuditTrailController {
  constructor(private readonly auditTrail: AuditTrailService) {}

  @Get()
  @Roles('ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD')
  async search(
    @CurrentScope() scope: ManagerScope,
    @Query('actorUserId') actorUserId?: string,
    @Query('actedAsRole') actedAsRole?: string,
    @Query('zoneId') zoneId?: string,
    @Query('action') action?: string,
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<AuditSearchPage> {
    return this.auditTrail.search(
      {
        actorUserId: text(actorUserId, 'ACTOR_USER_ID'),
        actedAsRole: text(actedAsRole, 'ACTED_AS_ROLE'),
        action: text(action, 'ACTION'),
        entityType: text(entityType, 'ENTITY_TYPE'),
        entityId: text(entityId, 'ENTITY_ID'),
        zoneId: integer(zoneId, 'ZONE_ID'),
        from: instant(from, 'FROM'),
        to: instant(to, 'TO'),
        cursor: keysetCursor(cursor),
        limit: pageLimit(limit),
      },
      scope,
    );
  }

  @Get('tickets/:ticketId')
  @Roles('ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD')
  async ticket(@CurrentScope() scope: ManagerScope, @Param('ticketId') ticketId: string): Promise<TicketAuditTrail> {
    if (!UUID_RE.test(ticketId)) throw new BadRequestException({ code: 'INVALID_TICKET_ID' });
    const out = await this.auditTrail.ticketTrail(ticketId, scope);
    if (out.result === 'NOT_FOUND') throw new NotFoundException({ code: 'TICKET_NOT_FOUND' });
    return out.trail;
  }
}

/** An absent or blank query param is "no filter", not an empty-string filter. */
function text(raw: string | undefined, code: string): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (value.length > MAX_FILTER_LEN) throw new BadRequestException({ code: `INVALID_${code}` });
  return value;
}

function integer(raw: string | undefined, code: string): number | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (!/^\d{1,18}$/.test(value)) throw new BadRequestException({ code: `INVALID_${code}` });
  return Number(value);
}

function instant(raw: string | undefined, code: string): Date | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) throw new BadRequestException({ code: `INVALID_${code}` });
  return at;
}

/** The cursor is deliberately just the previous page's last `audit_logs.id`. */
function keysetCursor(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (!/^\d{1,18}$/.test(value)) throw new BadRequestException({ code: 'INVALID_CURSOR' });
  return value;
}

function pageLimit(raw: string | undefined): number {
  const value = raw?.trim();
  if (!value) return DEFAULT_LIMIT;
  if (!/^\d{1,4}$/.test(value)) throw new BadRequestException({ code: 'INVALID_LIMIT' });
  const limit = Number(value);
  if (limit < 1 || limit > MAX_LIMIT) throw new BadRequestException({ code: 'INVALID_LIMIT' });
  return limit;
}
