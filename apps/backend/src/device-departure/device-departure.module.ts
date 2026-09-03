import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
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
  // #361 — for `NotificationService`: the auto-close notice resolves each affected zone's manager
  // inside the reconcile transaction and is delivered post-commit off the committed outbox row.
  imports: [PrismaModule, NotificationsModule],
  providers: [DeviceDepartureService],
  exports: [DeviceDepartureService],
})
export class DeviceDepartureModule {}
