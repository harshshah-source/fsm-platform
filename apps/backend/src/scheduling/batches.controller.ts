import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import { DispatchTransparencyQueryService, type DispatchBatchDetail } from './dispatch-transparency-query.service';
import { OverrideService, type OverrideCommand, type OverrideOutcome } from './override.service';

const MANAGER_ROLES = ['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD'] as const;

/**
 * The `/api/batches/*` surface. The ZM override endpoint (Issue 13a, LLD §5.4) dispatches every
 * override action to the engine; each commits immediately and flips the batch to OVERRIDDEN. The
 * transparency read (Issue 123) resolves a batch BY ITS OWN ID — the run is derived, not required,
 * because most live batches have no `run_id` at all. Both are manager-roled and zone-scoped (a ZM
 * gets NOT_FOUND for an out-of-zone batch).
 */
@Controller('batches')
@UseGuards(AuthGuard, RoleGuard)
export class BatchesController {
  constructor(
    private readonly override: OverrideService,
    private readonly query: DispatchTransparencyQueryService,
  ) {}

  @Get(':batchId')
  @Roles(...MANAGER_ROLES)
  async batchDetail(
    @CurrentUser() user: AccessTokenClaims,
    @Param('batchId') batchId: string,
  ): Promise<DispatchBatchDetail> {
    let id: bigint;
    try {
      id = BigInt(batchId);
    } catch {
      throw new NotFoundException({ code: 'DISPATCH_BATCH_NOT_FOUND' });
    }
    const detail = await this.query.getBatchDetail(id, { role: user.role, zoneId: user.zone_id });
    if (!detail) throw new NotFoundException({ code: 'DISPATCH_BATCH_NOT_FOUND' });
    return detail;
  }

  @Post(':id/override')
  @HttpCode(200)
  @Roles('ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD')
  async overrideBatch(
    @CurrentUser() user: AccessTokenClaims,
    @Param('id') id: string,
    @Body() body: OverrideCommand,
  ): Promise<OverrideOutcome> {
    const outcome = await this.override.override(
      BigInt(id),
      body,
      { role: user.role, zoneId: user.zone_id },
      { userId: user.user_id, role: user.role, actedAsRole: null },
    );
    if (outcome.result === 'NOT_FOUND') throw new NotFoundException({ code: 'BATCH_NOT_FOUND' });
    if (outcome.result === 'CONFLICT_ON_SITE') {
      throw new ConflictException({
        code: 'OVERRIDE_ON_SITE_CONFLICT',
        message: 'SE holds ON_SITE on affected work — resend with confirm=true and a reason code.',
        ticketIds: outcome.ticketIds,
      });
    }
    // #249 — mirrors the ON_SITE mapping exactly, deliberately: one confirm vocabulary for every
    // override, so a client that already handles one handles the other without new machinery.
    if (outcome.result === 'CONFLICT_DEFERRED') {
      throw new ConflictException({
        code: 'CONFLICT_DEFERRED',
        message: 'Affected work is held to a future vehicle-return date — resend with confirm=true and a reason code.',
        ticketIds: outcome.ticketIds,
      });
    }
    return outcome;
  }
}
