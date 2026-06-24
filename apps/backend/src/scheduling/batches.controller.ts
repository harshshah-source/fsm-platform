import {
  Body,
  ConflictException,
  Controller,
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
import { OverrideService, type OverrideCommand, type OverrideOutcome } from './override.service';

/**
 * The `/api/batches/*` ZM override surface (Issue 13a, LLD §5.4). One endpoint dispatches every
 * override action to the engine; each commits immediately and flips the batch to OVERRIDDEN. Manager-
 * roled and zone-scoped (the engine resolves scope and returns NOT_FOUND for out-of-zone batches).
 */
@Controller('batches')
@UseGuards(AuthGuard, RoleGuard)
export class BatchesController {
  constructor(private readonly override: OverrideService) {}

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
    return outcome;
  }
}
