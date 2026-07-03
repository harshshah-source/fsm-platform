import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { Prisma } from '../generated/prisma/client';
import { type DealType, type SlaBucket } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

export interface DeviceView {
  deviceId: string;
  dealType: DealType | null;
  currentVehicleId: string | null;
  deviceType: string | null;
  simId: string | null;
}

/** One row in the Device Detail list (FE-22), joining device state → vehicle / plant / zone / company. */
export interface DeviceListRow {
  deviceId: string;
  vehicleNo: string | null;
  deviceType: string | null;
  dealType: DealType | null;
  plantName: string | null;
  zoneName: string | null;
  companyName: string | null;
  slaBucket: SlaBucket | null;
  /** Device's last GPS ping (Issue 3) — the UI derives the elapsed inactive duration. Null if never seen. */
  latestGpsDatetime: string | null;
  isInactive: boolean;
}

export interface DeviceListScope {
  role: string;
  zoneId: number | null;
}

export type SetDealTypeOutcome = { result: 'OK'; device: DeviceView } | { result: 'NOT_FOUND' };

export interface DealTypeActor {
  userId: string;
  role: string;
  actedAsRole?: string | null;
}

function toView(d: {
  deviceId: string;
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

  async setDealType(deviceId: string, dealType: DealType, actor: DealTypeActor): Promise<SetDealTypeOutcome> {
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

  async getDevice(deviceId: string): Promise<DeviceView | null> {
    const d = await this.prisma.device.findUnique({ where: { deviceId } });
    return d ? toView(d) : null;
  }

  /**
   * The Device Detail list (FE-22, ref 22). Tracked devices (those with a `device_states` row) joined to
   * their vehicle / plant / zone / company, carrying the current SLA bucket. Zone-scoped like the ticket
   * reads (a ZM sees only their own zone; CSM / Operations Head see all), with an optional free-text
   * search over device id / vehicle no / plant / company. Inactive devices sort first (most urgent).
   */
  async listDevices(scope: DeviceListScope, opts: { search?: string; limit?: number } = {}): Promise<DeviceListRow[]> {
    const conds: Prisma.Sql[] = [];
    if (scope.role === 'ZONAL_MANAGER' && scope.zoneId !== null) {
      conds.push(Prisma.sql`AND p.zone_id = ${BigInt(scope.zoneId)}`);
    }
    const search = opts.search?.trim();
    if (search) {
      const q = `%${search}%`;
      conds.push(
        Prisma.sql`AND (CAST(ds.device_id AS TEXT) ILIKE ${q} OR v.vehicle_no ILIKE ${q} OR p.name ILIKE ${q} OR c.name ILIKE ${q})`,
      );
    }
    const where = conds.length ? Prisma.join(conds, ' ') : Prisma.empty;
    const limit = opts.limit && opts.limit > 0 ? Math.min(opts.limit, 200) : 100;

    const rows = await this.prisma.$queryRaw<
      {
        deviceId: string;
        vehicleNo: string | null;
        deviceType: string | null;
        dealType: DealType | null;
        plantName: string | null;
        zoneName: string | null;
        companyName: string | null;
        slaBucket: SlaBucket | null;
        latestGpsDatetime: Date | null;
        isInactive: boolean;
      }[]
    >(Prisma.sql`
      SELECT ds.device_id AS "deviceId", v.vehicle_no AS "vehicleNo", d.device_type AS "deviceType",
             d.deal_type AS "dealType", p.name AS "plantName", z.name AS "zoneName", c.name AS "companyName",
             ds.sla_bucket AS "slaBucket", ds.latest_gps_datetime AS "latestGpsDatetime", ds.is_inactive AS "isInactive"
      FROM device_states ds
      JOIN devices d ON d.device_id = ds.device_id
      LEFT JOIN vehicles v ON v.vehicle_id = ds.vehicle_id
      LEFT JOIN plants p ON p.plant_id = ds.plant_id
      LEFT JOIN zones z ON z.zone_id = p.zone_id
      LEFT JOIN company_master c ON c.company_id = ds.company_id
      WHERE 1=1 ${where}
      ORDER BY ds.is_inactive DESC, ds.latest_gps_datetime ASC NULLS LAST
      LIMIT ${limit}`);

    return rows.map((r) => ({
      ...r,
      deviceId: String(r.deviceId),
      latestGpsDatetime: r.latestGpsDatetime ? r.latestGpsDatetime.toISOString() : null,
    }));
  }
}
