import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { Readable } from 'node:stream';
import { Prisma } from '../generated/prisma/client';
import { AuditService, auditActor } from '../audit/audit.service';
import { CurrentActor } from '../common/decorators/current-actor.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { RequestActor } from '../common/request-actor';
import { DatasetQueryService, type DatasetPage } from './dataset-query.service';
import { listDatasets, serializeDataset, type SerializedDataset } from './dataset-registry';
import { OPS_EXPLORER_ROLE_NAMES, OPS_EXPLORER_ROLES } from './ops-explorer-access';
import { OpsExplorerConfigService, OpsExplorerEnabledGuard } from './ops-explorer-enabled.guard';
import type { OpsExplorerQueryDto } from './ops-explorer.dto';
import { ReconciliationService, type ReconciliationReport } from './reconciliation.service';

/**
 * Operations Data Explorer (#217) — `/api/ops-explorer`.
 *
 * A **read-only** investigation surface: no route in this controller writes domain state. The two
 * `@Post` handlers are reads with structured bodies (a filter set does not fit sanely in a query
 * string); `@HttpCode(200)` on both says so, and a test asserts the module registers no PUT/PATCH/DELETE.
 *
 * Access is two gates, both required:
 *
 *  - `OpsExplorerEnabledGuard` — `OPS_EXPLORER_ENABLED`, else **404** for everyone including OH, so a
 *    feature that is off in production does not advertise itself.
 *  - `@Roles(...OPS_EXPLORER_ROLE_NAMES)` — the single allow-list from `ops-explorer-access.ts`. Never
 *    inline a role string on a handler here; that is the one change that would make a future
 *    `PLATFORM_DEVELOPER` a redesign instead of a one-line append.
 *
 * Both are declared at the class level so a handler added later cannot forget them.
 */
@Controller('ops-explorer')
@UseGuards(OpsExplorerEnabledGuard)
@Roles(...OPS_EXPLORER_ROLE_NAMES)
export class OpsExplorerController {
  constructor(
    private readonly datasets: DatasetQueryService,
    private readonly reconciliation: ReconciliationService,
    private readonly config: OpsExplorerConfigService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The catalog: which datasets exist, and whether this session gets the lineage layer. The admin app
   * calls this first and treats a 404 as "feature absent" rather than as an error — that is why the
   * flag check must live in a guard that 404s, not in this body.
   *
   * Audited as `OPS_EXPLORER_ACCESSED` (AC-5): this is the surface's entry point, so it is the honest
   * place to record that someone opened the tool, as opposed to auditing every keystroke of filtering.
   */
  @Get('meta')
  async meta(@CurrentActor() actor: RequestActor): Promise<{
    enabled: true;
    developerMode: boolean;
    roles: readonly string[];
    datasets: SerializedDataset[];
  }> {
    const developerMode = this.config.developerMode;
    await this.audit.record({
      ...auditActor(actor),
      action: 'OPS_EXPLORER_ACCESSED',
      entityType: 'OPS_EXPLORER',
      entityId: 'meta',
      metadata: { developerMode },
    });
    return {
      // Literal `true`: reaching this handler at all means the guard passed.
      enabled: true,
      developerMode,
      roles: OPS_EXPLORER_ROLES,
      datasets: listDatasets().map((d) => serializeDataset(d, developerMode)),
    };
  }

  /** One dataset's full column metadata — the source-popover and column-picker payload. */
  @Get('datasets/:key')
  dataset(@Param('key') key: string): SerializedDataset {
    return serializeDataset(this.datasets.requireDataset(key), this.config.developerMode);
  }

  /** A page of rows. A read; POST only because the filter set is structured. */
  @Post('datasets/:key/query')
  @HttpCode(200)
  query(@Param('key') key: string, @Body() body: OpsExplorerQueryDto): Promise<DatasetPage> {
    return this.datasets.query(key, body ?? {}, this.config.developerMode);
  }

  /**
   * Server-side CSV export of the **whole** filtered result (AC-9).
   *
   * Deliberately not #160's `TableDownloadButton`, which reads the rendered DOM. That mechanism is
   * right for an operational table — it guarantees the export equals the on-screen, zone-scoped view —
   * but it structurally cannot export row 51 of a paginated result, and this tool's entire purpose is
   * the rows you have not looked at yet. The trade is explicit: the export is re-queried, so it is a
   * fresh read rather than a snapshot of the screen.
   *
   * Audited with the applied filters, so a download is attributable to a specific question.
   */
  @Post('datasets/:key/export')
  @HttpCode(200)
  async export(
    @Param('key') key: string,
    @Body() body: OpsExplorerQueryDto,
    @CurrentActor() actor: RequestActor,
  ): Promise<StreamableFile> {
    const request = body ?? {};
    const { dataset, columns, rows } = await this.datasets.exportRows(key, request);

    await this.audit.record({
      ...auditActor(actor),
      action: 'EXPORT_DOWNLOADED',
      entityType: 'OPS_EXPLORER_EXPORT',
      entityId: dataset.key,
      // Round-tripped through JSON so the audit row records exactly what a reader will see, and so the
      // structural `DatasetFilter`/`DatasetSort` types (which Prisma's InputJsonValue cannot accept
      // directly) land as plain JSON rather than being cast into it.
      metadata: JSON.parse(
        JSON.stringify({
          rowCount: rows.length,
          columns: columns.map((c) => c.key),
          filters: request.filters ?? [],
          search: request.search ?? null,
          sort: request.sort ?? null,
        }),
      ) as Prisma.InputJsonValue,
    });

    const header = columns.map((c) => csvCell(c.label)).join(',');
    const body$ = rows.map((row) => columns.map((c) => csvCell(row[c.key])).join(','));
    // A BOM so Excel opens UTF-8 correctly on Windows — the operator's actual tool.
    const csv = `﻿${[header, ...body$].join('\n')}\n`;

    const stamp = new Date().toISOString().slice(0, 10);
    return new StreamableFile(Readable.from([csv]), {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="ops-explorer-${dataset.key}-${stamp}.csv"`,
    });
  }

  /** The KPI reconciliation panel (AC-10). Read-only, evaluated live over the whole database. */
  @Get('reconciliation')
  reconcile(): Promise<ReconciliationReport> {
    return this.reconciliation.run(this.config.developerMode);
  }
}

/** RFC-4180-ish, matching `entity-mapping-export.service.ts`'s `esc` so the two exports agree. */
function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
