import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { type DealType } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

export interface DeviceView {
  deviceId: string;
  dealType: DealType | null;
  currentVehicleId: string | null;
  deviceType: string | null;
  simId: string | null;
}

export type SetDealTypeOutcome = { result: 'OK'; device: DeviceView } | { result: 'NOT_FOUND' };

export interface DealTypeActor {
  userId: string;
  role: string;
  actedAsRole?: string | null;
}

function toView(d: {
  deviceId: bigint;
  dealType: DealType | null;
  currentVehicleId: bigint | null;
  deviceType: string | null;
  simId: string | null;
}): DeviceView {
  return {
    deviceId: String(d.deviceId),
    dealType: d.dealType,
    currentVehicleId: d.currentVehicleId != null ? String(d.currentVehicleId) : null,
    deviceType: d.deviceType,
    simId: d.simId,
  };
}

/**
 * Device master reads + the Operations-Head manual `deal_type` tag (Issue 49, CONTEXT "Deal Type",
 * ADR-0014). `deal_type` (RECURRING | ONE_TIME, nullable) is conceptually sourced from CRM/SAP; with
 * no v1 integration it is set by the audited Ops-Head tag here (NULL = untagged). The first consumer
 * is #35 (Non-Operational dual-confirmation → Recovery Ticket creation on RECURRING).
 */
@Injectable()
export class DeviceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async setDealType(deviceId: bigint, dealType: DealType, actor: DealTypeActor): Promise<SetDealTypeOutcome> {
    const existing = await this.prisma.device.findUnique({ where: { deviceId } });
    if (!existing) return { result: 'NOT_FOUND' };

    const updated = await this.audit.withAudit(
      {
        actorId: actor.userId,
        actorRole: actor.role,
        actedAsRole: actor.actedAsRole ?? null,
        action: 'DEVICE_DEAL_TYPE_TAG',
        entityType: 'device',
        entityId: String(deviceId),
        metadata: { dealType, previous: existing.dealType },
      },
      (tx) => tx.device.update({ where: { deviceId }, data: { dealType } }),
    );
    return { result: 'OK', device: toView(updated) };
  }

  async getDevice(deviceId: bigint): Promise<DeviceView | null> {
    const d = await this.prisma.device.findUnique({ where: { deviceId } });
    return d ? toView(d) : null;
  }
}
