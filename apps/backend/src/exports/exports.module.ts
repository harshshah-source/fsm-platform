import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../prisma/prisma.module';
import { EntityMappingExportService } from './entity-mapping-export.service';
import { ExportsController } from './exports.controller';

/** OH raw-data exports (`/api/exports`) — see {@link ExportsController}. */
@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [ExportsController],
  providers: [EntityMappingExportService],
})
export class ExportsModule {}
