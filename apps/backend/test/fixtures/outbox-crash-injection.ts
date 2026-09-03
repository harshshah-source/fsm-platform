import type { NotificationService } from '../../src/notifications/notification.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { NOTIFY_EVENT_TYPE } from '../../src/scheduling/day-plan-notification-outbox';
import type { DayPlanNotifier } from '../../src/scheduling/day-plan-notifier';

/**
 * The two crashes #338 converts a producer against, and the inert notifier its drains need.
 *
 * Shared rather than copied per spec: every one of the twelve producers is tested for the same two
 * properties, and a per-file copy of the proxy would let one door's rig drift from another's while
 * both kept passing. What differs between doors is the fixture and the transaction — not this.
 *
 * - {@link throwingNotifications} is the *delivery* crash. The mutation has committed; the push
 *   fails. Durability is what survives it (the row, un-claimed, retryable).
 * - {@link failingNotifyEnqueue} is the *enqueue* crash. It is what tells an in-transaction enqueue
 *   apart from a post-commit one: only the former takes its mutation down with it.
 */

export class NotifyFailed extends Error {
  constructor() {
    super('injected: the notification delivery failed');
    this.name = 'NotifyFailed';
  }
}

export class EnqueueFailed extends Error {
  constructor() {
    super('injected: the notification enqueue failed');
    this.name = 'EnqueueFailed';
  }
}

/** A notification service that cannot deliver — the crash, injected where a push would happen. */
export function throwingNotifications(): NotificationService {
  return {
    notify: async () => {
      throw new NotifyFailed();
    },
  } as unknown as NotificationService;
}

/**
 * A client on which enqueueing a *general* notice throws — on the client itself and on any
 * transaction client it hands out, so it catches the write wherever the producer puts it.
 *
 * Deliberately narrowed to `eventType === NOTIFY`: a day-plan row written in the same transaction
 * (`assignTicket` writes one) must keep working, or the rollback under test would be caused by the
 * wrong write.
 */
export function failingNotifyEnqueue(prisma: PrismaService): PrismaService {
  const wrapDelegate = (delegate: object): object =>
    new Proxy(delegate, {
      get(d, dp) {
        if (dp !== 'create') return Reflect.get(d, dp);
        return async (args: { data?: { eventType?: string } }) => {
          if (args?.data?.eventType === NOTIFY_EVENT_TYPE) throw new EnqueueFailed();
          const create = Reflect.get(d, 'create') as (a: unknown) => Promise<unknown>;
          return create.call(d, args);
        };
      },
    });

  const wrapClient = (client: object): object =>
    new Proxy(client, {
      get(target, prop, receiver) {
        if (prop === 'dayPlanNotificationOutbox') {
          return wrapDelegate(Reflect.get(target, prop, receiver) as object);
        }
        if (prop === '$transaction') {
          return (fn: unknown, ...rest: unknown[]) => {
            const real = (target as unknown as Record<string, (...a: unknown[]) => unknown>).$transaction;
            if (typeof fn !== 'function') return real.call(target, fn, ...rest);
            return real.call(target, ((tx: object) => (fn as (t: object) => unknown)(wrapClient(tx))) as never, ...rest);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

  return wrapClient(prisma) as PrismaService;
}

/** The day-plan half of a drain that only ever sees general rows. */
export const inertDayPlanNotifier: DayPlanNotifier = {
  dayPlanDispatched: async () => {},
  dayPlanOverridden: async () => {},
};
