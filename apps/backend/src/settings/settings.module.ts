import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AssignmentThresholdService } from './assignment-threshold.service';
import { SettingsService } from './settings.service';

// Provider-only: SettingsController and AssignmentThresholdController are registered in AppModule,
// where the guard chain (AuthGuard/RoleGuard → TokenService from AuthModule) resolves. AuditModule
// supplies the in-transaction AuditService used by config mutations.
@Module({
  imports: [AuditModule],
  providers: [SettingsService, AssignmentThresholdService],
  exports: [SettingsService, AssignmentThresholdService],
})
export class SettingsModule {}
