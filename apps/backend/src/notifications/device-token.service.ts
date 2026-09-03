import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** One user's push registration (#337) — what the FCM adapter needs to address a handset. */
export interface DeviceTokenRegistration {
  userId: string;
  token: string;
  platform: string;
  deviceId: string;
}

/**
 * Push device-token registry (Issue 76, D1/D4 settled 2026-08-03). One row per user — a new
 * registration replaces the prior row rather than accumulating one per handset, matching #91's
 * one-active-device policy. Written by the mobile push client (#89, still outstanding on the mobile
 * side) and **read by `FcmChannelGateway` (#337)**, which is now a real adapter rather than a
 * deferred one: it resolves the token here and reaps it here when the provider says it is dead.
 */
@Injectable()
export class DeviceTokenService {
  constructor(private readonly prisma: PrismaService) {}

  async register(userId: string, token: string, deviceId: string): Promise<void> {
    await this.prisma.deviceToken.upsert({
      where: { userId },
      create: { userId, token, deviceId },
      update: { token, deviceId },
    });
  }

  /**
   * The user's registration, or null when they have never registered a handset (#337).
   *
   * Null is the ordinary case, not an error: an SE who has not opened the app has no token, and the
   * push channel answers UNAVAILABLE so the fallback chain continues exactly as it did before there
   * was an adapter at all.
   */
  async findForUser(userId: string): Promise<DeviceTokenRegistration | null> {
    return this.prisma.deviceToken.findUnique({
      where: { userId },
      select: { userId: true, token: true, platform: true, deviceId: true },
    });
  }

  /**
   * Reap a registration the provider has told us is dead (#337) — but only if it is still the same
   * token we sent to.
   *
   * FCM answers 404/410 when a registration is gone (uninstalled, rotated, moved project). Without
   * this, that token stays in the table and every future push to the engineer fails identically,
   * forever, while `device_tokens` goes on asserting they are reachable.
   *
   * Matching on the token as well as the user is the whole safety of it: a handset that
   * re-registered while the failing send was in flight has already replaced this row, and deleting by
   * user alone would silence an engineer who is perfectly reachable. Returns whether a row was
   * actually removed, so the caller can say which of the two happened.
   */
  async deleteStale(userId: string, token: string): Promise<boolean> {
    const { count } = await this.prisma.deviceToken.deleteMany({ where: { userId, token } });
    return count > 0;
  }

  /** Called on logout so a revoked session never leaves a live push token behind. */
  async clear(userId: string): Promise<void> {
    await this.prisma.deviceToken.deleteMany({ where: { userId } });
  }
}
