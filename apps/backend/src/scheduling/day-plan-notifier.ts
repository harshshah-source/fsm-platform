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
  /**
   * The ticket the change is about (#360), where the action has one. Producer-supplied; the outbox
   * writer turns it into {@link ticketNoDisplay} inside the producing transaction and the notifier
   * never reads it.
   */
  ticketId?: string | null;
  /**
   * `TCK-#####` for the ticket the change is about (#360) — resolved at enqueue, so the notice quotes
   * the label the ticket had when the plan changed. Null on every row written before #360 and on
   * every action that names no single ticket (REORDER, SWAP_SE, a whole-plant deactivation).
   */
  ticketNoDisplay?: string | null;
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
 * How a stop is named in a sentence: the plant, the ticket label, both, or neither (#360).
 *
 * "that stop" rather than an empty string for the nameless case — a pre-#360 row carries no nouns at
 * all, and a sentence with a hole in it reads as a bug to the engineer receiving it.
 */
function stopLabel(event: DayPlanOverriddenEvent): string {
  const plant = event.plantName?.trim() || null;
  const ticket = event.ticketNoDisplay?.trim() || null;
  if (plant && ticket) return `${plant} (${ticket})`;
  if (plant) return plant;
  if (ticket) return ticket;
  return 'that stop';
}

/**
 * The closed set of sentences a Day Plan notice can say (#360 AC3).
 *
 * Until #360 every action but `PLANT_DEACTIVATED` fell through to
 * `` `Your Day Plan was updated (${event.action}).` `` — which put a raw audit-action enum
 * (`REMOVE_TICKET`, `ASSIGN_BATCH_COMMIT`) on a field engineer's lock screen. That is not a cosmetic
 * defect: a notice an SE cannot act on teaches them that *none* of these notices are worth opening,
 * and the day-plan channel is the only one dispatch has.
 *
 * Keyed on the audit action rather than a new vocabulary because the action IS the distinction the
 * producers already make; a parallel "notice kind" enum would be one more thing to keep in step. The
 * map is total over what the producers emit today, and {@link dayPlanOverriddenBody}'s fallback keeps
 * a future action honest — vague, but never leaking itself.
 */
const OVERRIDDEN_BODY: Record<string, (stop: string) => string> = {
  REMOVE_TICKET: (s) => `Stop removed: ${s}. That work is off your Day Plan.`,
  DEFER_TICKET: (s) => `Stop postponed: ${s}. It has been moved to a later date.`,
  // Names the stop too: a reorder moves one plant batch, and "your plan changed, go look" is exactly
  // the notice an engineer already driving learns to ignore.
  REORDER: (s) => `Visit order changed: ${s} has moved in your Day Plan. Check the new order before you set off.`,
  SWAP_SE: (s) => `Stop added: ${s}. This stop has been handed to you.`,
  REASSIGN: (s) => `Stop added: ${s}. This work has been handed to you.`,
  SPLIT_BATCH: (s) => `Stop added: ${s}. Part of another engineer's stop has been handed to you.`,
  MOVE_TICKET: (s) => `Stop added: ${s}. This work has been moved onto your Day Plan.`,
  CRITICAL_ASSIGN: (s) => `Urgent stop added: ${s}. Please visit as soon as you can.`,
  MANUAL_ZM_UPDATE: (s) => `Stop added: ${s}. Your manager updated today's Day Plan.`,
  ASSIGN_BATCH_COMMIT: (s) => `Stop added: ${s}. It is on today's Day Plan.`,
};

/**
 * The sentence an SE reads on their phone (#345 AC2, rewritten by #360 AC3).
 *
 * A deactivation keeps its own wording: nobody told the engineer, they may already be driving to that
 * yard, and the only thing they need is *which* stop to drop. Everything else now names the stop too
 * — #345's argument that "the action word is the whole content" held only while the reader was
 * assumed to be mid-conversation with the manager who typed it, which is not true of the intra-day
 * queue, the assign-batch lane, or a plan changed while the SE was under a truck.
 */
export function dayPlanOverriddenBody(event: DayPlanOverriddenEvent): string {
  if (event.action === DAY_PLAN_ACTION_PLANT_DEACTIVATED) {
    return event.plantName
      ? `${event.plantName} has been deactivated — that stop has been removed from your Day Plan.`
      : 'A plant has been deactivated — that stop has been removed from your Day Plan.';
  }
  const write = OVERRIDDEN_BODY[event.action];
  if (write) return write(stopLabel(event));
  // An action nobody has written a sentence for yet. Vague on purpose, and deliberately NOT
  // interpolating `event.action` — the enum leak is the defect this function exists to close, and a
  // fallback that reintroduces it would let the next new action walk straight back through.
  return 'Your Day Plan has been updated — open the app to see what changed.';
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
        // The action stays in metadata — the operator's audit trail is not the engineer's sentence.
        action: event.action,
        ...(event.plantName ? { plantName: event.plantName } : {}),
        ...(event.ticketNoDisplay ? { ticketNoDisplay: event.ticketNoDisplay } : {}),
      },
    });
  }
}
