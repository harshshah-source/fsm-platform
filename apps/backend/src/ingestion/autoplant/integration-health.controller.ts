import { Controller, Get, UseGuards } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuthGuard } from '../../common/guards/auth.guard';
import { RoleGuard } from '../../common/guards/role.guard';
import { AutoPlantHealthService, type IntegrationHealth } from './health.service';

/**
 * `GET /api/integration/health` (blueprint §9) — Operations-Head view of AutoPlant source
 * connectivity + master-sync/snapshot freshness. Read-only; safe to poll. All fields are plain
 * JSON (numbers/Dates) — no BigInt in the payload.
 */
@Controller('integration')
@UseGuards(AuthGuard, RoleGuard)
export class IntegrationHealthController {
  constructor(private readonly health: AutoPlantHealthService) {}

  @Get('health')
  @Roles('OPERATIONS_HEAD')
  check(): Promise<IntegrationHealth> {
    return this.health.check();
  }
}
