import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../app.module';
import {
  NOTIFICATION_CHANNEL_GATEWAY,
  type NotificationChannelGateway,
} from '../../notifications/notification-channel.gateway';
import { NotificationSeamBreachError, assertNotificationSeamInert } from '../../notifications/notification-seam';
import { readIngestionSchedulerConfig } from './integration-scheduler.service';

/**
 * Issue 218c — PRE-WINDOW PREFLIGHT. READ-ONLY: boots the application graph and reads two facts. It
 * writes nothing, to no database, and runs no sync.
 *
 *   npm run autoplant:window-preflight
 *
 * Run this immediately before the manual catch-up `autoplant:sync pipeline` (FIX-PLAN §7.5 step 4).
 * It replaces two by-hand verifications from 2026-08-07 that would otherwise be trusted from memory:
 *
 *  1. **The notification seam is inert.** Asserted through the REAL `AppModule` — the same graph the
 *     catch-up resolves through — so what is checked is the binding that will actually be live, not a
 *     re-reading of `notifications.module.ts`. See `notification-seam.ts` for why identity is checked
 *     before behaviour.
 *  2. **The ingestion scheduler is off** (§7.5 step 1). If it is on, the first scheduled run executes
 *     the whole catch-up unattended, at whatever hour it fires. INDEX recorded `false` on 2026-07-18
 *     and it read `false` on 2026-08-07 — this re-verifies rather than assuming, which is what the
 *     procedure asks for.
 *
 * Exit code is the contract: **0 = safe to proceed, 1 = STOP**. Both checks always run, so one
 * invocation reports every problem rather than one per fix-and-retry cycle.
 */
async function main(): Promise<void> {
  const failures: string[] = [];
  // `logger: false` keeps the boot chatter out of a report the operator has to read at 05:30 IST.
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });

  try {
    // eslint-disable-next-line no-console
    console.log('\n════════════════ #218c PRE-WINDOW PREFLIGHT (read-only) ════════════════\n');

    // 1. Notification seam.
    try {
      const gateway = app.get<NotificationChannelGateway>(NOTIFICATION_CHANNEL_GATEWAY);
      const report = assertNotificationSeamInert(gateway);
      // eslint-disable-next-line no-console
      console.log(
        `✅ notification seam INERT — ${report.gateway} returned UNAVAILABLE for all ` +
          `${report.channelsProbed.length} external channels (${report.channelsProbed.join(', ')}). ` +
          `No push/SMS/WhatsApp/email can leave the building during the window.`,
      );
    } catch (err) {
      const detail = err instanceof NotificationSeamBreachError ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`❌ NOTIFICATION SEAM BREACH\n   ${detail}`);
      failures.push('notification seam is not inert');
    }

    // 2. Scheduler master switch.
    const scheduler = readIngestionSchedulerConfig();
    if (scheduler.enabled) {
      // eslint-disable-next-line no-console
      console.error(
        `❌ INGESTION_SCHEDULER_ENABLED is "true" — a scheduled masters run (${scheduler.mastersCron}) ` +
          `would execute the entire catch-up unattended, at whatever hour it fires. Set it to false and ` +
          `restart before the window (FIX-PLAN §7.5 step 1).`,
      );
      failures.push('ingestion scheduler is enabled');
    } else {
      // eslint-disable-next-line no-console
      console.log(
        `✅ ingestion scheduler OFF — INGESTION_SCHEDULER_ENABLED is not "true", so no scheduled run can ` +
          `fire the catch-up unattended. Re-enable only after step 6.`,
      );
    }

    // eslint-disable-next-line no-console
    console.log('\n═══════════════════════════════════════════════════════════════════════');
    if (failures.length > 0) {
      // eslint-disable-next-line no-console
      console.error(`\n🛑 PREFLIGHT FAILED (${failures.length}): ${failures.join('; ')}.\n   DO NOT RUN THE CATCH-UP WINDOW.\n`);
      process.exitCode = 1;
    } else {
      // eslint-disable-next-line no-console
      console.log('\n✅ PREFLIGHT PASSED — both preconditions hold. Nothing was written.\n');
    }
  } catch (err) {
    // A preflight that cannot complete is a preflight that failed — never a silent pass.
    // eslint-disable-next-line no-console
    console.error('❌ preflight could not complete:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

void main();
