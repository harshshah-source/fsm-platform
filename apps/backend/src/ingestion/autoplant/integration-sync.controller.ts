import { Controller, HttpCode, Post, Query, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { AuditService, auditActor } from '../../audit/audit.service';
import { CurrentActor } from '../../common/decorators/current-actor.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuthGuard } from '../../common/guards/auth.guard';
import { RoleGuard } from '../../common/guards/role.guard';
import type { RequestActor } from '../../common/request-actor';
import { AutoPlantMysqlClient } from './autoplant-mysql.client';
import { IntegrationSyncService, type PipelineSummary } from './integration-sync.service';

/**
 * Operations-Head **manual** triggers for the AutoPlant integration pipeline. Not the only path since
 * #97 Slice 7: the `ingestion-telemetry` and `ingestion-masters` crons drive the same service, gated
 * by `INGESTION_SCHEDULER_ENABLED` (currently `false`, so these endpoints are in practice how the
 * pipeline runs today — which is a deployment state, not an architectural one). Job names asserted in
 * `test/scheduler-wiring.e2e-spec.ts` (#229 §4).
 * `run-pipeline` drives master-sync → snapshot → device-state → auto-recovery → ticket-creation
 * end-to-end; `sync-masters` runs
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
    private readonly audit: AuditService,
  ) {}

  private assertConfigured(): void {
    if (!this.client.isConfigured()) {
      throw new ServiceUnavailableException(
        'AutoPlant is not configured — set AUTOPLANT_MYSQL_* and connect to the VPN before syncing.',
      );
    }
  }

  /**
   * #343 — record the trigger **before** the pipeline runs, and only once the configured gate has
   * passed. Two deliberate choices:
   *
   *  - *Before*, not after: a `run-pipeline` can take minutes and can throw halfway. "Who started
   *    this" must survive a run that never finished — that is precisely the run an operator comes
   *    looking for. The run tables (`master_sync_runs`, `snapshot_runs`) already record what happened;
   *    what they cannot record is who asked.
   *  - *After* the 503 gate: a refused trigger touched nothing, and a ledger that logs attempts as
   *    well as actions stops meaning "this ran".
   *
   * These two routes have no single transaction to enlist in — the pipeline is a chain of separately
   * guarded stages — so this is `record`, the standalone form of `withAudit`, not a second shape.
   */
  private trigger(actor: RequestActor, action: string, entityId: string, metadata: Record<string, unknown>): Promise<void> {
    return this.audit.record({
      ...auditActor(actor),
      action,
      entityType: 'integration_pipeline',
      entityId,
      metadata: { trigger: 'manual', ...metadata },
    });
  }

  @Post('sync-masters')
  @HttpCode(200)
  async syncMasters(@CurrentActor() actor: RequestActor): Promise<PipelineSummary['master']> {
    this.assertConfigured();
    await this.trigger(actor, 'MANUAL_SYNC_TRIGGERED', 'sync-masters', {});
    return this.sync.syncMasters();
  }

  @Post('run-pipeline')
  @HttpCode(200)
  async runPipeline(
    @CurrentActor() actor: RequestActor,
    @Query('chunkSize') chunkSize?: string,
  ): Promise<PipelineSummary> {
    this.assertConfigured();
    const size = chunkSize ? Math.max(1, Math.min(99, Number(chunkSize))) : undefined;
    // The clamped size, not the raw query string: the row should say what the pipeline actually ran
    // with, since a pass at 40 rows a query behaves differently from one at 90.
    await this.trigger(actor, 'PIPELINE_RUN_TRIGGERED', 'run-pipeline', { chunkSize: size ?? null });
    return this.sync.runPipeline({ chunkSize: size });
  }
}
