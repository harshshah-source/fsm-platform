import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { DeviceDepartureService } from './device-departure.service';

/**
 * FSM-owned device deployment lifecycle (Issue 128) — the device-grain twin of
 * {@link PlantDeactivationModule}. Downstream gates each express the same "active departure"
 * exclusion in their own query style (device-state recompute derives `is_departed`; the recommender
 * uses a relation filter; the dashboard a raw-SQL predicate) — all keyed on `restored_at IS NULL`.
 *
 * No AuditModule import: reconcile writes its per-device audit rows on its own transaction (see the
 * service's constructor note), so the audit inserts stay atomic with the mutations they record.
 */
@Module({
  imports: [PrismaModule],
  providers: [DeviceDepartureService],
  exports: [DeviceDepartureService],
})
export class DeviceDepartureModule {}
