import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../prisma/prisma.module';
import { DeviceDetailService } from './device-detail.service';
import { DeviceService } from './device.service';

/**
 * Device master module (Issue 49, 44). Provides `DeviceService` — the device read path and the audited
 * Operations-Head `deal_type` tag (exported for #35) — and `DeviceDetailService` — the Device Detail
 * per-cycle list + Lifetime Downtime Trend (Issue 44).
 */
@Module({
  imports: [PrismaModule, AuditModule],
  providers: [DeviceService, DeviceDetailService],
  exports: [DeviceService, DeviceDetailService],
})
export class DevicesModule {}
