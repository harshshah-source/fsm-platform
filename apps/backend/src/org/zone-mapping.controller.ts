import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentActor } from '../common/decorators/current-actor.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import type { RequestActor } from '../common/request-actor';
import {
  type PlantZoneOverrideView,
  type ReapplyResult,
  type ZoneChangeImpact,
  type ZoneMappingView,
  ZoneMappingService,
} from './zone-mapping.service';

interface MapValueBody {
  fsmZoneId: string | number;
}
interface UpsertOverrideBody {
  sourcePlantId: string | number;
  fsmZoneId: string | number;
  /** Mandatory — the override row is overwritten on re-pin, so the reason survives only in `audit_logs`. */
  reason: string;
}

/** Parse a BigInt id from a string/number, or 400. Rejects junk / non-integer / 0-and-negative ids. */
function parseBigId(value: string | number, field: string): bigint {
  const s = String(value).trim();
  if (!/^\d+$/.test(s) || s === '0') throw new BadRequestException(`Invalid ${field}: ${value}`);
  return BigInt(s);
}

/**
 * Operations-Head-owned zone-mapping admin surface (R6 translation layer). The value→zone crosswalk and
 * the per-plant overrides both live as data here; nothing about zones is hardcoded. Edits are effective
 * on already-synced plants only after `POST /reapply` (master-sync is insert-only on `plants.zone_id`).
 */
@Controller('org')
@UseGuards(AuthGuard, RoleGuard)
@Roles('OPERATIONS_HEAD')
export class ZoneMappingAdminController {
  constructor(private readonly zoneMappings: ZoneMappingService) {}

  @Get('zone-mappings')
  list(@Query('status') status?: string): Promise<ZoneMappingView[]> {
    return this.zoneMappings.listMappings(status);
  }

  /** The admin work queue of unmapped values auto-discovered during sync. */
  @Get('zone-mappings/pending')
  listPending(): Promise<ZoneMappingView[]> {
    return this.zoneMappings.listPending();
  }

  @Post('zone-mappings/:id/map')
  map(
    @Param('id') id: string,
    @Body() body: MapValueBody,
    @CurrentActor() actor: RequestActor,
  ): Promise<ZoneMappingView> {
    return this.zoneMappings.mapValue(parseBigId(id, 'id'), parseBigId(body.fsmZoneId, 'fsmZoneId'), actor);
  }

  @Post('zone-mappings/:id/ignore')
  ignore(@Param('id') id: string, @CurrentActor() actor: RequestActor): Promise<ZoneMappingView> {
    return this.zoneMappings.ignoreValue(parseBigId(id, 'id'), actor);
  }

  /** Recompute plants.zone_id from the current mappings + overrides (the FSM-owned effect of an edit). */
  @Post('zone-mappings/reapply')
  @HttpCode(200)
  reapply(@CurrentActor() actor: RequestActor): Promise<ReapplyResult> {
    return this.zoneMappings.reapply(actor);
  }

  @Get('plant-zone-overrides')
  listOverrides(): Promise<PlantZoneOverrideView[]> {
    return this.zoneMappings.listOverrides();
  }

  /** Pin a plant to a zone. `reason` is mandatory (400 without one); effective on `reapply`. */
  @Put('plant-zone-overrides')
  upsertOverride(
    @Body() body: UpsertOverrideBody,
    @CurrentActor() actor: RequestActor,
  ): Promise<PlantZoneOverrideView> {
    return this.zoneMappings.upsertOverride(
      parseBigId(body.sourcePlantId, 'sourcePlantId'),
      parseBigId(body.fsmZoneId, 'fsmZoneId'),
      body.reason,
      actor,
    );
  }

  /** What a pending zone change will affect — shown before the admin confirms it (#158 AC-6). */
  @Get('plant-zone-overrides/:sourcePlantId/impact')
  zoneChangeImpact(@Param('sourcePlantId') sourcePlantId: string): Promise<ZoneChangeImpact> {
    return this.zoneMappings.zoneChangeImpact(parseBigId(sourcePlantId, 'sourcePlantId'));
  }

  @Delete('plant-zone-overrides/:sourcePlantId')
  @HttpCode(204)
  async deleteOverride(
    @Param('sourcePlantId') sourcePlantId: string,
    @CurrentActor() actor: RequestActor,
  ): Promise<void> {
    await this.zoneMappings.deleteOverride(parseBigId(sourcePlantId, 'sourcePlantId'), actor);
  }
}
