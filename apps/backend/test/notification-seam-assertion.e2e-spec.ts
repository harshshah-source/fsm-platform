import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import {
  LoggingChannelGateway,
  NOTIFICATION_CHANNEL_GATEWAY,
  type ChannelDeliveryResult,
  type ChannelSendInput,
  type NotificationChannelGateway,
} from '../src/notifications/notification-channel.gateway';
import {
  EXTERNAL_CHANNELS,
  NotificationSeamBreachError,
  assertNotificationSeamInert,
} from '../src/notifications/notification-seam';

/**
 * Issue 218c — the pre-window notification-seam gate.
 *
 * The catch-up window force-closes ~4,383 tickets and creates ~1,100 more in one transaction. The
 * only thing standing between that and a mass external send is one line —
 * `notifications.module.ts:18` binding `NOTIFICATION_CHANNEL_GATEWAY` to `LoggingChannelGateway`,
 * which returns `UNAVAILABLE` for every channel. That was verified **by hand** on 2026-08-07, and a
 * hand verification expires the moment someone lands the real FCM/WhatsApp adapters. The operator's
 * Stage-2 decision was explicit: assert it programmatically, at window time, failing loudly.
 *
 * The ordering below is the safety property, not a style choice. A gateway that is NOT the known-inert
 * binding must be rejected **without being called** — probing an unknown adapter to find out whether
 * it sends is itself the send we are trying to prevent. So identity is checked first and behaviour
 * only afterwards, and `refuses to probe` pins that with a gateway that throws if touched.
 */
describe('Issue 218c — notification seam assertion (pre-window gate)', () => {
  describe('against the real AppModule graph', () => {
    let moduleRef: TestingModule;

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    });

    afterAll(async () => {
      await moduleRef.close();
    });

    it('passes today: the bound gateway is inert on every external channel', () => {
      const gateway = moduleRef.get<NotificationChannelGateway>(NOTIFICATION_CHANNEL_GATEWAY);

      const report = assertNotificationSeamInert(gateway);

      expect(report.gateway).toBe('LoggingChannelGateway');
      // Every external channel probed, not a sample — the window's exposure is all of them.
      expect(report.channelsProbed).toEqual([...EXTERNAL_CHANNELS]);
      expect(report.results.every((r) => r === 'UNAVAILABLE')).toBe(true);
    });
  });

  describe('when real adapters have landed', () => {
    /** What a landed FCM adapter looks like to this check: a different class that actually sends. */
    class FcmChannelGateway implements NotificationChannelGateway {
      deliver(_input: ChannelSendInput): ChannelDeliveryResult {
        return 'SENT';
      }
    }

    it('fails loudly when the bound gateway is no longer the inert one', () => {
      expect(() => assertNotificationSeamInert(new FcmChannelGateway())).toThrow(NotificationSeamBreachError);
    });

    it('refuses to probe an unrecognised gateway — the check must not become the send', () => {
      let touched = 0;
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
      expect(() => assertNotificationSeamInert(new FcmChannelGateway())).toThrow(/FcmChannelGateway/);
    });
  });

  describe('when the inert gateway has been altered in place', () => {
    it('fails when the known binding stops returning UNAVAILABLE', () => {
      // Identity alone is not enough, which is why the check probes as well: subclassing keeps the
      // `instanceof` identity intact while replacing the send.
      class LeakyGateway extends LoggingChannelGateway {
        override deliver(): ChannelDeliveryResult {
          return 'SENT';
        }
      }

      expect(() => assertNotificationSeamInert(new LeakyGateway())).toThrow(NotificationSeamBreachError);
    });
  });
});
