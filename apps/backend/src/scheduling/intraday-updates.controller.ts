import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import type { AssignOutcome, OverrideOutcome } from './override.service';
import { SameDayUpdateService, type IntradayUpdateRow } from './same-day-update.service';

const MANAGER_ROLES = ['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD'] as const;

/**
 * The `/api/intraday-updates/*` ZM manual same-day surface (Issue 31). `GET` is the Intra-day Queue
 * read (MANUAL_ZM_UPDATE rows, zone-scoped); `add` / `remove` / `reorder` apply an immediate same-day
 * change to an SE's current Day Plan (no SE Acceptance) and log it to the queue. Distinct from the
 * system-triggered CRITICAL insertion (Issue 29). Manager-roled + zone-scoped by the service.
 */
@Controller('intraday-updates')
@UseGuards(AuthGuard, RoleGuard)
export class IntradayUpdatesController {
  constructor(private readonly sameDay: SameDayUpdateService) {}

  @Get()
  @Roles(...MANAGER_ROLES)
  list(@CurrentUser() user: AccessTokenClaims): Promise<IntradayUpdateRow[]> {
    return this.sameDay.listIntradayUpdates({ role: user.role, zoneId: user.zone_id });
  }

  @Post('add')
  @HttpCode(200)
  @Roles(...MANAGER_ROLES)
  async add(
    @CurrentUser() user: AccessTokenClaims,
    @Body() body: { ticketId: string; seId: string },
  ): Promise<AssignOutcome> {
    if (!body.ticketId || !body.seId) throw new BadRequestException({ code: 'TICKET_AND_SE_REQUIRED' });
    const out = await this.sameDay.addTicket(
      body.ticketId,
      body.seId,
      { role: user.role, zoneId: user.zone_id },
      { userId: user.user_id, role: user.role, actedAsRole: null },
    );
    if (out.result === 'NOT_FOUND') throw new NotFoundException({ code: 'TICKET_OR_SE_NOT_FOUND' });
    if (out.result === 'ALREADY_ASSIGNED') throw new ConflictException({ code: 'TICKET_ALREADY_ASSIGNED' });
    return out;
  }

  @Post('remove')
  @HttpCode(200)
  @Roles(...MANAGER_ROLES)
  async remove(
    @CurrentUser() user: AccessTokenClaims,
    @Body() body: { batchId: string; ticketId: string; reasonCode: string; confirm?: boolean },
  ): Promise<OverrideOutcome> {
    if (!body.batchId || !body.ticketId) throw new BadRequestException({ code: 'BATCH_AND_TICKET_REQUIRED' });
    if (!body.reasonCode) throw new BadRequestException({ code: 'REASON_REQUIRED' });
    const out = await this.sameDay.removeTicket(
      BigInt(body.batchId),
      body.ticketId,
      body.reasonCode,
      body.confirm ?? false,
      { role: user.role, zoneId: user.zone_id },
      { userId: user.user_id, role: user.role, actedAsRole: null },
    );
    return this.mapOverride(out);
  }

  @Post('reorder')
  @HttpCode(200)
  @Roles(...MANAGER_ROLES)
  async reorder(
    @CurrentUser() user: AccessTokenClaims,
    @Body() body: { batchId: string; stopSequence: number; reasonCode: string },
  ): Promise<OverrideOutcome> {
    if (!body.batchId || body.stopSequence == null) throw new BadRequestException({ code: 'BATCH_AND_SEQUENCE_REQUIRED' });
    if (!body.reasonCode) throw new BadRequestException({ code: 'REASON_REQUIRED' });
    const out = await this.sameDay.reorder(
      BigInt(body.batchId),
      body.stopSequence,
      body.reasonCode,
      { role: user.role, zoneId: user.zone_id },
      { userId: user.user_id, role: user.role, actedAsRole: null },
    );
    return this.mapOverride(out);
  }

  private mapOverride(out: OverrideOutcome): OverrideOutcome {
    if (out.result === 'NOT_FOUND') throw new NotFoundException({ code: 'BATCH_OR_TICKET_NOT_FOUND' });
    if (out.result === 'CONFLICT_ON_SITE') {
      throw new ConflictException({
        code: 'UPDATE_ON_SITE_CONFLICT',
        message: 'SE holds ON_SITE on affected work — resend with confirm=true and a reason code.',
        ticketIds: out.ticketIds,
      });
    }
    return out;
  }
}
