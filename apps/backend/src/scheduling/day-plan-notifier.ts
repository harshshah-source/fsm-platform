import { Logger } from '@nestjs/common';

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
      `Day Plan updated (${event.action}) — se=${event.seId} schedule=${event.scheduleId} batch=${event.batchId}`,
    );
  }
}
