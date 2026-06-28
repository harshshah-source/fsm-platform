import { BadRequestException, Controller, Get, NotFoundException, Param, UseGuards } from '@nestjs/common';
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import { type TicketAuditTrail, AuditTrailService } from './audit-trail.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `/api/audit-trail` — the user-facing audit-trail viewer (Issue 03). Manager roles only; a ZM is scoped
 * to tickets in their own zone (out-of-zone / unknown → 404).
 */
@Controller('audit-trail')
@UseGuards(AuthGuard, RoleGuard)
export class AuditTrailController {
  constructor(private readonly auditTrail: AuditTrailService) {}

  @Get('tickets/:ticketId')
  @Roles('ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD')
  async ticket(@CurrentUser() user: AccessTokenClaims, @Param('ticketId') ticketId: string): Promise<TicketAuditTrail> {
    if (!UUID_RE.test(ticketId)) throw new BadRequestException({ code: 'INVALID_TICKET_ID' });
    const out = await this.auditTrail.ticketTrail(ticketId, { role: user.role, zoneId: user.zone_id });
    if (out.result === 'NOT_FOUND') throw new NotFoundException({ code: 'TICKET_NOT_FOUND' });
    return out.trail;
  }
}
