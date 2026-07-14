import { Controller, Get, StreamableFile } from '@nestjs/common';
import { CurrentActor } from '../common/decorators/current-actor.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { RequestActor } from '../common/request-actor';
import { AuditService, auditActor } from '../audit/audit.service';
import { EntityMappingExportService } from './entity-mapping-export.service';

/**
 * OH raw-data exports (`/api/exports`). Operations-Head-only reconciliation downloads. Auth + the
 * OPERATIONS_HEAD role are enforced by the global guard chain (#99); each download is audited as
 * an `EXPORT_DOWNLOADED` event so pulls of the full org graph are attributable.
 */
@Controller('exports')
export class ExportsController {
  constructor(
    private readonly entityMapping: EntityMappingExportService,
    private readonly audit: AuditService,
  ) {}

  @Get('entity-mapping/summary')
  @Roles('OPERATIONS_HEAD')
  entityMappingSummary(): Promise<{ rowCount: number; dataAsOf: string | null }> {
    return this.entityMapping.summary();
  }

  @Get('entity-mapping')
  @Roles('OPERATIONS_HEAD')
  async entityMappingCsv(@CurrentActor() actor: RequestActor): Promise<StreamableFile> {
    await this.audit.record({
      ...auditActor(actor),
      action: 'EXPORT_DOWNLOADED',
      entityType: 'EXPORT',
      entityId: 'entity-mapping',
    });
    return new StreamableFile(this.entityMapping.toCsvStream(), {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="${this.entityMapping.filename()}"`,
    });
  }
}
