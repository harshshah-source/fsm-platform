import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { SettingsService } from './settings.service';

// Provider-only: SettingsController is registered in AppModule, where the guard chain
// (AuthGuard/RoleGuard → TokenService from AuthModule) resolves. AuditModule supplies the
// in-transaction AuditService used by config mutations.
@Module({
  imports: [AuditModule],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
