import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, ConflictException, HttpCode } from '@nestjs/common';
import { CurrentActor } from '../common/decorators/current-actor.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { RequestActor } from '../common/request-actor';
import { PlantDeactivationService } from './plant-deactivation.service';

/**
 * OH plant-deactivation admin surface (`/api/plants`, Issue 119). Operations-Head only (global guard
 * chain enforces auth + role); reason is mandatory on deactivate. Deactivate cancels the plant's open
 * tickets in the same transaction; reactivate is reversible and lets the pipeline re-create tickets.
 */
@Controller('plants')
export class PlantDeactivationController {
  constructor(private readonly service: PlantDeactivationService) {}

  @Get('deactivations')
  @Roles('OPERATIONS_HEAD')
  list() {
    return this.service.list();
  }

  @Post(':plantId/deactivate')
  @HttpCode(200)
  @Roles('OPERATIONS_HEAD')
  async deactivate(
    @Param('plantId') plantIdRaw: string,
    @Body() body: { reason?: string },
    @CurrentActor() actor: RequestActor,
  ) {
    const plantId = parsePlantId(plantIdRaw);
    const reason = body.reason?.trim();
    if (!reason) throw new BadRequestException({ code: 'REASON_REQUIRED' });

    const out = await this.service.deactivate(plantId, reason, actor);
    if (out.result === 'PLANT_NOT_FOUND') throw new NotFoundException({ code: 'PLANT_NOT_FOUND' });
    if (out.result === 'ALREADY_DEACTIVATED') throw new ConflictException({ code: 'ALREADY_DEACTIVATED' });
    return { deactivationId: out.deactivationId, cancelledTickets: out.cancelledTickets };
  }

  @Post(':plantId/reactivate')
  @HttpCode(200)
  @Roles('OPERATIONS_HEAD')
  async reactivate(
    @Param('plantId') plantIdRaw: string,
    @Body() body: { reason?: string | null },
    @CurrentActor() actor: RequestActor,
  ) {
    const plantId = parsePlantId(plantIdRaw);
    const out = await this.service.reactivate(plantId, body.reason?.trim() || null, actor);
    if (out.result === 'NOT_DEACTIVATED') throw new NotFoundException({ code: 'NOT_DEACTIVATED' });
    return { result: 'OK' };
  }
}

function parsePlantId(raw: string): bigint {
  try {
    return BigInt(raw);
  } catch {
    throw new BadRequestException({ code: 'INVALID_PLANT_ID' });
  }
}
