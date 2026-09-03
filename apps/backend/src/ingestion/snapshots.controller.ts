import { Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import { SnapshotIngestionWorker } from './snapshot-ingestion.worker';
import {
  SnapshotQueryService,
  type SnapshotLatestView,
  type SnapshotRunView,
} from './snapshot-query.service';

/**
 * The `/api/snapshots/*` HTTP surface (Issue 04 slice 7, LLD §5.1).
 *
 *  - GET  /latest — every authenticated role — data-as-of + latest run status (the banner feed).
 *  - GET  /runs   — Operations Head — paged run history.
 *  - POST /run    — Operations Head — trigger a run; 409 RUN_IN_PROGRESS if one is in flight
 *                   (surfaced verbatim from `SnapshotRunService`'s in-flight guard).
 */
@Controller('snapshots')
@UseGuards(AuthGuard, RoleGuard)
export class SnapshotsController {
  constructor(
    private readonly query: SnapshotQueryService,
    private readonly worker: SnapshotIngestionWorker,
  ) {}

  /**
   * #348 — deliberately **no `@Roles`**: authenticated, unrestricted by role.
   *
   * This route returns freshness, not data. Its whole payload is "how old is what you are looking at,
   * and is the pipeline that produces it running" — timestamps and run statuses, no device, no
   * ticket, no zone, nothing a role could be scoped to. It was ZM/CSM/OH only, which meant the global
   * banner 403'd for a Warehouse Manager and a Service Engineer and then swallowed the error, so the
   * two roles least able to notice stale telemetry for themselves were the two roles never told about
   * it. Widening it is not a data-access loosening; withholding it was the defect (AC3).
   *
   * `AuthGuard` still applies at the controller, so this is not public.
   */
  @Get('latest')
  latest(): Promise<SnapshotLatestView> {
    return this.query.latest();
  }

  @Get('runs')
  @Roles('OPERATIONS_HEAD')
  listRuns(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('status') status?: string,
  ): Promise<SnapshotRunView[]> {
    return this.query.listRuns({
      limit: limit === undefined ? undefined : Number(limit),
      offset: offset === undefined ? undefined : Number(offset),
      status,
    });
  }

  @Post('run')
  @HttpCode(200)
  @Roles('OPERATIONS_HEAD')
  async run(): Promise<{ runId: string; status: string }> {
    // Bound the page size under the AutoPlant DBA cap (< 100 rows/query); overridable via env.
    const chunkSize = Math.max(1, Math.min(99, Number(process.env.AUTOPLANT_SNAPSHOT_CHUNK_SIZE) || 90));
    const result = await this.worker.run({ chunkSize });
    return { runId: result.runId.toString(), status: result.status };
  }
}
