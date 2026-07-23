import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { AccessTokenClaims } from '../auth/token.service';
import { CurrentActor } from '../common/decorators/current-actor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import type { RequestActor } from '../common/request-actor';
import {
  type CreateTierOverrideInput,
  type TierOverrideView,
  TierOverridesService,
} from './tier-overrides.service';

interface CreateTierOverrideBody {
  companyId: number;
  zoneId: number;
  tier: string;
  reason: string;
  expiresAt: string;
}

/** A positive-integer route-param id, else 400 (rejects junk before `cancel`'s `BigInt`). */
function parseId(value: string): bigint {
  if (!/^\d+$/.test(value) || value === '0') throw new BadRequestException(`Invalid id: ${value}`);
  return BigInt(value);
}

/**
 * Scoped, expiring company tier overrides (`/api/org/tier-overrides`, Issue 157 S2). OH and CSM
 * act cross-zone (Q-C); a ZONAL_MANAGER is clamped to their own zone at the service layer, since
 * the zone travels in the request body/query rather than a `:zoneId`/`zone_id` params/query key.
 */
@Controller('org/tier-overrides')
@UseGuards(AuthGuard, RoleGuard)
@Roles('OPERATIONS_HEAD', 'CENTRAL_SERVICE_MANAGER', 'ZONAL_MANAGER')
export class TierOverridesAdminController {
  constructor(private readonly tierOverrides: TierOverridesService) {}

  @Post()
  create(
    @Body() body: CreateTierOverrideBody,
    @CurrentActor() actor: RequestActor,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<TierOverrideView> {
    const input: CreateTierOverrideInput = {
      companyId: body.companyId,
      zoneId: body.zoneId,
      tier: body.tier,
      reason: body.reason,
      expiresAt: body.expiresAt,
    };
    return this.tierOverrides.create(input, actor, user.zone_id);
  }

  /** Cancel an ACTIVE override (already EXPIRED/CANCELLED → 400). Same role/zone scope as create. */
  @Delete(':id')
  @HttpCode(204)
  async cancel(
    @Param('id') id: string,
    @CurrentActor() actor: RequestActor,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<void> {
    await this.tierOverrides.cancel(parseId(id), actor, user.zone_id);
  }

  /** The monthly active-overrides report read (Q1). ZM sees only their own zone. */
  @Get()
  list(
    @Query('status') status: string | undefined,
    @Query('zoneId') zoneId: string | undefined,
    @Query('month') month: string | undefined,
    @CurrentActor() actor: RequestActor,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<TierOverrideView[]> {
    return this.tierOverrides.list(
      { status, zoneId: zoneId !== undefined ? Number(zoneId) : undefined, month },
      actor,
      user.zone_id,
    );
  }
}
