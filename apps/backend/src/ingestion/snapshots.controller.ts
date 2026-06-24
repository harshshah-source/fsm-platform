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
 *  - GET  /latest — ZM / CSM / Operations Head — data-as-of + latest run status (the banner feed).
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

  @Get('latest')
  @Roles('ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD')
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
    const result = await this.worker.run();
    return { runId: result.runId.toString(), status: result.status };
  }
}
