import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { RoleBackupService } from './role-backup.service';

/**
 * Role backup cascade (Issue 27). `RoleBackupService` resolves who currently holds a zone's ZM duty
 * (ZM → CSM → Operations Head) from `role_unavailability`, and reports per-zone CSM backup share.
 * Controller registered in AppModule.
 */
@Module({
  imports: [PrismaModule],
  providers: [RoleBackupService],
  exports: [RoleBackupService],
})
export class RoleBackupModule {}
