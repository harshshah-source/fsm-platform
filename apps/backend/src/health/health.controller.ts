import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { HealthService, type ReadinessResult } from './health.service';

/**
 * Public liveness/readiness probes (#98 leg 4) — deliberately unauthenticated (@Public, #99), so an
 * orchestrator or load balancer can poll them. Distinct from `GET /api/integration/health`, which is
 * the OH-only AutoPlant-source view. Liveness must have no dependencies; readiness gates on the DB.
 */
@Controller('health')
@Public()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** Liveness — the process is up and serving. No DB touch, so it stays green during a DB blip. */
  @Get()
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness — can the app actually serve requests. 503 when the DB is unreachable. */
  @Get('ready')
  async ready(): Promise<ReadinessResult> {
    const result = await this.health.readiness();
    if (result.db !== 'up') {
      throw new ServiceUnavailableException(result);
    }
    return result;
  }
}
