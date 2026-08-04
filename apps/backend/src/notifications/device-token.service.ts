import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Push device-token registry (Issue 76, D1/D4 settled 2026-08-03). One row per user — a new
 * registration replaces the prior row rather than accumulating one per handset, matching #91's
 * one-active-device policy. Consumed by the mobile push client (#89) once it exists; the real
 * FCM/APNs send is a separate, HITL-gated adapter (`NotificationChannelGateway`).
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

  /** Called on logout so a revoked session never leaves a live push token behind. */
  async clear(userId: string): Promise<void> {
    await this.prisma.deviceToken.deleteMany({ where: { userId } });
  }
}
