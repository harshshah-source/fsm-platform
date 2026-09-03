import { Injectable, Logger } from '@nestjs/common';
import { NotificationService } from '../notifications/notification.service';
import { DAY_PLAN_ACTION_PLANT_DEACTIVATED } from './day-plan-notification-outbox';

/** Emitted when an SE's Day Plan is dispatched (AC#4 "Day Plan is live"). */
export interface DayPlanDispatchedEvent {
  seId: string;
  scheduleId: bigint;
  zoneId: bigint;
  stops: number;
  tickets: number;
}

/** Emitted when a ZM override changes an SE's Day Plan (Issue 13a AC#4). */
export interface DayPlanOverriddenEvent {
  seId: string;
  scheduleId: bigint;
  batchId: bigint;
  action: string;
  /**
   * The plant whose stop the change is about (#345), where the action has one.
   *
   * Optional because the ZM override actions do not need it — the manager who removed a ticket is
   * telling the SE about work they were just talking about — while `PLANT_DEACTIVATED` arrives
   * unannounced, from an Operations Head the SE never spoke to, and "your Day Plan was updated" with
   * no noun leaves an engineer already driving to a yard with nothing to act on. Null on every row
   * written before #345 and on every action that names no plant.
   */
  plantName?: string | null;
}

/**
 * Dispatch-notification seam (AC#4). The notification spine (Issue 03, push→SMS→WhatsApp→email
 * fallback chain) isn't built yet, so the BatchAssignmentWorker fires "Day Plan is live" through
 * this port. Issue 03 swaps the default for the real multi-channel notifier; the dispatch contract
 * stays unchanged.
 */
export interface DayPlanNotifier {
  dayPlanDispatched(event: DayPlanDispatchedEvent): Promise<void> | void;
  dayPlanOverridden(event: DayPlanOverriddenEvent): Promise<void> | void;
}

export const DAY_PLAN_NOTIFIER = Symbol('DAY_PLAN_NOTIFIER');

/**
 * The sentence an SE reads on their phone (#345 AC2).
 *
 * A ZM override keeps the generic form on purpose — the manager who made the change is the SE's own
 * manager, usually mid-conversation, and the action word is the whole content. A deactivation is the
 * opposite: nobody told the engineer, and the only thing they need is *which* stop to drop. The
 * nameless fallback exists because a pre-#345 row carries no `plantName` and printing `undefined` at
 * an engineer is worse than the vaguer sentence.
 */
export function dayPlanOverriddenBody(event: DayPlanOverriddenEvent): string {
  if (event.action === DAY_PLAN_ACTION_PLANT_DEACTIVATED) {
    return event.plantName
      ? `${event.plantName} has been deactivated — that stop has been removed from your Day Plan.`
      : 'A plant has been deactivated — that stop has been removed from your Day Plan.';
  }
  return `Your Day Plan was updated (${event.action}).`;
}

/** Default port until the notification spine lands — logs the dispatch so it's observable. */
export class LoggingDayPlanNotifier implements DayPlanNotifier {
  private readonly logger = new Logger('DayPlanNotifier');
  dayPlanDispatched(event: DayPlanDispatchedEvent): void {
    this.logger.log(
      `Day Plan is live — se=${event.seId} schedule=${event.scheduleId} stops=${event.stops} tickets=${event.tickets}`,
    );
  }
  dayPlanOverridden(event: DayPlanOverriddenEvent): void {
    this.logger.log(
      `Day Plan updated (${event.action}) — se=${event.seId} schedule=${event.scheduleId} batch=${event.batchId}` +
        (event.plantName ? ` plant=${event.plantName}` : ''),
    );
  }
}

/**
 * #76 — adoption. Both events have exactly one recipient (the SE themselves), so no extra
 * recipient-resolution lookup is needed. No `entityType`/`entityId` is set — a dispatched/updated
 * Day Plan isn't a single ticket entity to tap-route into (#85's Notifications screen only routes
 * `entityType === 'ticket'`; anything else just marks read, which is the correct behavior here too
 * since Home *is* the Day Plan).
 */
@Injectable()
export class SpineDayPlanNotifier implements DayPlanNotifier {
  constructor(private readonly notifications: NotificationService) {}

  async dayPlanDispatched(event: DayPlanDispatchedEvent): Promise<void> {
    await this.notifications.notify({
      recipients: [{ userId: event.seId, role: 'SERVICE_ENGINEER' }],
      type: 'DAY_PLAN_DISPATCHED',
      title: 'Your Day Plan is live',
      body: 'Your Day Plan is live. Tap to start.',
      metadata: { scheduleId: String(event.scheduleId), zoneId: String(event.zoneId), stops: event.stops, tickets: event.tickets },
    });
  }

  async dayPlanOverridden(event: DayPlanOverriddenEvent): Promise<void> {
    await this.notifications.notify({
      recipients: [{ userId: event.seId, role: 'SERVICE_ENGINEER' }],
      type: 'DAY_PLAN_OVERRIDDEN',
      title: 'Day Plan updated',
      body: dayPlanOverriddenBody(event),
      metadata: {
        scheduleId: String(event.scheduleId),
        batchId: String(event.batchId),
        action: event.action,
        ...(event.plantName ? { plantName: event.plantName } : {}),
      },
    });
  }
}
