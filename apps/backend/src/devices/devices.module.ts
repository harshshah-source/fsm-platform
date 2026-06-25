import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../prisma/prisma.module';
import { DeviceService } from './device.service';

/**
 * Device master module (Issue 49). Provides `DeviceService` — the device read path and the audited
 * Operations-Head `deal_type` tag. Exported for #35 (Non-Operational marking → Recovery Ticket).
 */
@Module({
  imports: [PrismaModule, AuditModule],
  providers: [DeviceService],
  exports: [DeviceService],
})
export class DevicesModule {}
