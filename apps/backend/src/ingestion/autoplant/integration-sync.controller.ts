import { Controller, HttpCode, Post, Query, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuthGuard } from '../../common/guards/auth.guard';
import { RoleGuard } from '../../common/guards/role.guard';
import { AutoPlantMysqlClient } from './autoplant-mysql.client';
import { IntegrationSyncService, type PipelineSummary } from './integration-sync.service';

/**
 * Operations-Head manual triggers for the AutoPlant integration pipeline (first light — no scheduler
 * yet). `run-pipeline` drives master-sync → snapshot → device-state end-to-end; `sync-masters` runs
 * just the org sync (useful for iterating on the zone-mapping queue without re-draining telemetry).
 * Both refuse with 503 when AutoPlant is not configured, so a misconfigured env fails loudly rather
 * than silently no-opping against the empty source.
 */
@Controller('integration')
@UseGuards(AuthGuard, RoleGuard)
@Roles('OPERATIONS_HEAD')
export class IntegrationSyncController {
  constructor(
    private readonly client: AutoPlantMysqlClient,
    private readonly sync: IntegrationSyncService,
  ) {}

  private assertConfigured(): void {
    if (!this.client.isConfigured()) {
      throw new ServiceUnavailableException(
        'AutoPlant is not configured — set AUTOPLANT_MYSQL_* and connect to the VPN before syncing.',
      );
    }
  }

  @Post('sync-masters')
  @HttpCode(200)
  syncMasters(): Promise<PipelineSummary['master']> {
    this.assertConfigured();
    return this.sync.syncMasters();
  }

  @Post('run-pipeline')
  @HttpCode(200)
  runPipeline(@Query('chunkSize') chunkSize?: string): Promise<PipelineSummary> {
    this.assertConfigured();
    const size = chunkSize ? Math.max(1, Math.min(99, Number(chunkSize))) : undefined;
    return this.sync.runPipeline({ chunkSize: size });
  }
}
