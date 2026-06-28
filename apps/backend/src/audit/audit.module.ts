import { Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditTrailService } from './audit-trail.service';

@Module({
  providers: [AuditService, AuditTrailService],
  exports: [AuditService, AuditTrailService],
})
export class AuditModule {}
