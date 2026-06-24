import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { isEligibleForUptime } from './eligibility';
import { classifySlaBucket } from './sla-bucket';

const MS_PER_HOUR = 3_600_000;
const DEFAULT_INACTIVITY_THRESHOLD_HOURS = 24;

/** Non-Op states that exclude a device from the eligible set (invariant I13 active states). */
const ACTIVE_NONOP_STATES = ['CONFIRMED', 'ACTIVE'] as const;

/**
 * DeviceStateService — derives the current `device_states` row for every device from its latest
 * `raw_device_snapshots` ping (schema D5 / LLD DeviceStateService). One upsert per device:
 *
 *  - `inactivity_hours = now − latest_gps_datetime`, clamped ≥0 (clock skew → 0, never negative).
 *  - `is_inactive` against the configurable `inactivity_threshold_hours` setting (canonical 24h).
 *  - `sla_bucket` is the STORED output of the pure classifier — null for the 0–4h ACTIVE band.
 *  - vehicle / plant / company / transporter denormalised off the device's current fitment so the
 *    queue and dashboards never join on the hot path.
 *
 * Eligibility (`eligible_for_uptime`) and `has_open_failure_cycle` are owned by later slices and
 * left at their column defaults here.
 */
@Injectable()
export class DeviceStateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  /** Recompute and upsert `device_states` for all known devices. `now` is injectable for tests. */
  async recompute(now: Date = new Date()): Promise<{ upserted: number }> {
    const threshold =
      (await this.settings.get<number>('inactivity_threshold_hours')) ??
      DEFAULT_INACTIVITY_THRESHOLD_HOURS;

    // Latest ping per device across the (partitioned) telemetry table.
    const latest = await this.prisma.rawDeviceSnapshot.groupBy({
      by: ['deviceId'],
      _max: { gpsDatetime: true },
    });
    const latestByDevice = new Map(latest.map((r) => [r.deviceId, r._max.gpsDatetime]));

    // Eligibility inputs: latest PGI per device, and the set of devices under an active Non-Op marking.
    const latestPgi = await this.prisma.pgiHistory.groupBy({
      by: ['deviceId'],
      _max: { pgiDate: true },
    });
    const latestPgiByDevice = new Map(latestPgi.map((r) => [r.deviceId, r._max.pgiDate]));

    const nonOp = await this.prisma.nonOperationalMarking.findMany({
      where: { state: { in: [...ACTIVE_NONOP_STATES] } },
      select: { deviceId: true },
    });
    const nonOpDevices = new Set(nonOp.map((r) => r.deviceId));

    const devices = await this.prisma.device.findMany({ include: { currentVehicle: true } });

    let upserted = 0;
    for (const device of devices) {
      const latestGps = latestByDevice.get(device.deviceId) ?? null;
      const inactivityHours =
        latestGps === null
          ? null
          : Math.max(0, (now.getTime() - latestGps.getTime()) / MS_PER_HOUR);
      const isInactive = inactivityHours !== null && inactivityHours >= threshold;
      const slaBucket = inactivityHours === null ? null : classifySlaBucket(inactivityHours);
      const eligibleForUptime = isEligibleForUptime({
        latestPgiDate: latestPgiByDevice.get(device.deviceId) ?? null,
        hasActiveNonOp: nonOpDevices.has(device.deviceId),
        now,
      });
      const v = device.currentVehicle;

      const derived = {
        latestGpsDatetime: latestGps,
        isInactive,
        inactivityHours,
        slaBucket,
        eligibleForUptime,
        vehicleId: v?.vehicleId ?? null,
        plantId: v?.plantId ?? null,
        companyId: v?.companyId ?? null,
        transporterId: v?.transporterId ?? null,
        computedAt: now,
      };

      await this.prisma.deviceState.upsert({
        where: { deviceId: device.deviceId },
        create: { deviceId: device.deviceId, ...derived },
        update: derived,
      });
      upserted++;
    }

    return { upserted };
  }
}
