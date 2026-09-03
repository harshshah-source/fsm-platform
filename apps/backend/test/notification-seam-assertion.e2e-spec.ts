import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import {
  LoggingChannelGateway,
  NOTIFICATION_CHANNEL_GATEWAY,
  type ChannelDeliveryOutcome,
  type ChannelSendInput,
  type NotificationChannelGateway,
} from '../src/notifications/notification-channel.gateway';
import {
  EXTERNAL_CHANNELS,
  NotificationSeamBreachError,
  assertNotificationSeamInert,
} from '../src/notifications/notification-seam';

/**
 * Issue 218c — the pre-window notification-seam gate, **re-pointed by #337**.
 *
 * The catch-up window force-closes ~4,383 tickets and creates ~1,100 more in one transaction. The
 * only thing standing between that and a mass external send used to be one line —
 * `notifications.module.ts` binding `NOTIFICATION_CHANNEL_GATEWAY` to `LoggingChannelGateway`, which
 * returns `UNAVAILABLE` for every channel. That was verified **by hand** on 2026-08-07, and a hand
 * verification expires the moment someone lands the real adapters. The operator's Stage-2 decision
 * was to assert it programmatically, at window time, failing loudly.
 *
 * #337 landed the FCM adapter, so "the binding must be `LoggingChannelGateway`" is no longer the
 * property worth defending — it would fail the window for the mere existence of a real adapter class,
 * and, worse, it would go on passing for any *other* real provider that happened to subclass the
 * inert one. The property that actually protects the window is **no real provider unless somebody
 * explicitly configured one**, and it is checked in three layers, in this order:
 *
 *   1. configuration — `PUSH_PROVIDER` names a real provider → breach, nothing is constructed or called;
 *   2. self-declaration — the bound gateway does not declare itself inert → breach, **without probing**;
 *   3. behaviour — only the gateway that declares itself inert is called, and on every external channel.
 *
 * The ordering is the safety property, not a style choice. Probing an unknown adapter to find out
 * whether it sends is itself the send this gate exists to prevent, so `refuses to probe` pins it with
 * a gateway that counts its own invocations.
 */
describe('Issue 218c / #337 — notification seam assertion (pre-window gate)', () => {
  describe('against the real AppModule graph', () => {
    let moduleRef: TestingModule;

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    });

    afterAll(async () => {
      await moduleRef.close();
    });

    it('passes today: no push provider is configured and the bound gateway is inert on every channel', () => {
      const gateway = moduleRef.get<NotificationChannelGateway>(NOTIFICATION_CHANNEL_GATEWAY);

      const report = assertNotificationSeamInert(gateway);

      expect(report.gateway).toBe('LoggingChannelGateway');
      expect(report.pushProvider).toBe('logging');
      // Every external channel probed, not a sample — the window's exposure is all of them.
      expect(report.channelsProbed).toEqual([...EXTERNAL_CHANNELS]);
      expect(report.results.every((r) => r === 'UNAVAILABLE')).toBe(true);
    });
  });

  describe('#337 AC3 — no real provider unless explicitly configured', () => {
    it('fails when PUSH_PROVIDER names a real provider, whatever is bound', () => {
      // The configuration is checked before anything is constructed or called: a process configured
      // for live push must not run the window even if the object it happens to hold looks inert.
      expect(() => assertNotificationSeamInert(new LoggingChannelGateway(), { PUSH_PROVIDER: 'fcm' })).toThrow(
        NotificationSeamBreachError,
      );
      expect(() => assertNotificationSeamInert(new LoggingChannelGateway(), { PUSH_PROVIDER: 'fcm' })).toThrow(
        /PUSH_PROVIDER/,
      );
    });

    it('passes when PUSH_PROVIDER is explicitly the inert default', () => {
      const report = assertNotificationSeamInert(new LoggingChannelGateway(), { PUSH_PROVIDER: 'logging' });
      expect(report.pushProvider).toBe('logging');
    });

    it('an unreadable PUSH_PROVIDER value is a breach, not a fallback to inert', () => {
      expect(() => assertNotificationSeamInert(new LoggingChannelGateway(), { PUSH_PROVIDER: 'firebase' })).toThrow(
        NotificationSeamBreachError,
      );
    });
  });

  describe('when real adapters have landed', () => {
    /** What a landed adapter looks like to this check: it declares that it reaches the outside. */
    class RealChannelGateway implements NotificationChannelGateway {
      readonly sendsExternally = true;
      deliver(_input: ChannelSendInput): ChannelDeliveryOutcome {
        return 'SENT';
      }
    }

    it('fails loudly when the bound gateway declares that it can send', () => {
      expect(() => assertNotificationSeamInert(new RealChannelGateway())).toThrow(NotificationSeamBreachError);
    });

    it('refuses to probe a gateway that has not declared itself inert — the check must not become the send', () => {
      let touched = 0;
      // No `sendsExternally` at all: an adapter that never thought about this question is treated as
      // one that sends. Silence is not a claim of inertness.
      const unknown: NotificationChannelGateway = {
        deliver() {
          touched += 1;
          return 'SENT';
        },
      };

      expect(() => assertNotificationSeamInert(unknown)).toThrow(NotificationSeamBreachError);
      expect(touched).toBe(0);
    });

    it('names the offending gateway so the operator can see what landed', () => {
      expect(() => assertNotificationSeamInert(new RealChannelGateway())).toThrow(/RealChannelGateway/);
    });
  });

  describe('when the inert gateway has been altered in place', () => {
    it('fails when a self-declared-inert gateway stops returning UNAVAILABLE', () => {
      // The declaration alone is not enough, which is why the check probes as well: subclassing
      // inherits `sendsExternally = false` while replacing the send.
      class LeakyGateway extends LoggingChannelGateway {
        override deliver(): ChannelDeliveryOutcome {
          return 'SENT';
        }
      }

      expect(() => assertNotificationSeamInert(new LeakyGateway())).toThrow(NotificationSeamBreachError);
    });

    it('fails on a detailed outcome that is not UNAVAILABLE, not only on the bare string', () => {
      // #337 widened `deliver` to an optional detail object (provider message id / error). A probe
      // that only compared against the string would read `{ status: 'SENT' }` as "not UNAVAILABLE"
      // by accident rather than on purpose — pin that it is on purpose.
      class DetailedLeakyGateway extends LoggingChannelGateway {
        override deliver(): ChannelDeliveryOutcome {
          return { status: 'SENT', providerMessageId: 'projects/p/messages/1' };
        }
      }

      expect(() => assertNotificationSeamInert(new DetailedLeakyGateway())).toThrow(NotificationSeamBreachError);
    });
  });
});
