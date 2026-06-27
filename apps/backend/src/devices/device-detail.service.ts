import { Injectable } from '@nestjs/common';
import { classifySlaBucket, type SlaBucket } from '../device-state/sla-bucket';
import { Prisma } from '../generated/prisma/client';
import type { ClosureType, RootCauseCategory, VerifyOutcome } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

export interface DeviceScope {
  role: string;
  zoneId: number | null;
}

/** One Failure Cycle as the Device Detail page renders it (all hot operational records, no summary). */
export interface DeviceCycleView {
  cycleId: string;
  openedAt: string;
  closedAt: string | null;
  durationSeconds: number;
  /** The SLA bucket the cycle's downtime duration reached (null = stayed in the 0–4h ACTIVE band). */
  slaBucketReached: SlaBucket | null;
  repeatFailure: boolean;
  assignedSeId: string | null;
  plantId: string | null;
  companyId: string | null;
  rootCauseCategory: RootCauseCategory | null;
  componentRelated: boolean;
  vehicleUnavailableImpact: boolean;
  componentBlockedImpact: boolean;
  verificationOutcome: VerifyOutcome | null;
  closureType: ClosureType | null;
  autoRecovery: boolean;
}

export type DeviceCyclesOutcome =
  | { result: 'OK'; deviceId: string; cycles: DeviceCycleView[] }
  | { result: 'NOT_FOUND' };

export interface DowntimeTrendMonth {
  month: string;
  downtimeHours: number;
  cycleCount: number;
  repeatFailureCount: number;
  autoRecoveryClosures: number;
  seRepairedClosures: number;
  componentDowntimeHours: number;
  avgTimeToRecoverHours: number | null;
}
export interface RootCauseTrendPoint {
  month: string;
  category: RootCauseCategory;
  count: number;
}
export interface DeviceDowntimeTrend {
  deviceId: string;
  lifetime: {
    totalCycles: number;
    totalDowntimeHours: number;
    repeatFailures: number;
    longestEpisodeHours: number;
    avgTimeToRecoverHours: number | null;
    autoRecoveryClosures: number;
    seRepairedClosures: number;
  };
  monthly: DowntimeTrendMonth[];
  rootCauseTrend: RootCauseTrendPoint[];
}
export type DowntimeTrendOutcome = { result: 'OK'; trend: DeviceDowntimeTrend } | { result: 'NOT_FOUND' };

/**
 * Device Detail reads (Issue 44, CONTEXT §Device Detail). `deviceCycles` is the lifetime Failure-Cycle
 * list straight off hot operational records — bounded to one device, never a fleet-wide telemetry scan.
 * A ZONAL_MANAGER sees only devices in their own zone (out-of-zone → NOT_FOUND, no existence leak); CSM /
 * Operations Head see any device. The device's zone comes from its hot `device_states` plant, falling back
 * to the most recent ticket's plant.
 */
@Injectable()
export class DeviceDetailService {
  constructor(private readonly prisma: PrismaService) {}

  async deviceCycles(deviceId: bigint, scope: DeviceScope, now: Date = new Date()): Promise<DeviceCyclesOutcome> {
    if (!(await this.visible(deviceId, scope))) return { result: 'NOT_FOUND' };

    const cycles = await this.prisma.failureCycle.findMany({
      where: { deviceId },
      orderBy: { openedAt: 'desc' },
      include: {
        ticket: true,
        submissions: { orderBy: { submittedAt: 'desc' }, take: 1, include: { verificationRuns: { orderBy: { startedAt: 'desc' } } } },
        componentRequests: { take: 1 },
      },
    });

    const vu = await this.prisma.vehicleUnavailabilityReport.findMany({ where: { ticket: { deviceId } }, select: { ticketId: true } });
    const vuTickets = new Set(vu.map((v) => v.ticketId));

    const views = cycles.map((c): DeviceCycleView => {
      const end = c.closedAt ?? now;
      const durationSeconds = Math.max(0, Math.floor((end.getTime() - c.openedAt.getTime()) / 1000));
      const submission = c.submissions[0] ?? null;
      const outcomeRun = submission?.verificationRuns.find((r) => r.outcome !== null) ?? null;
      const componentRelated = c.componentRequests.length > 0;
      return {
        cycleId: c.cycleId,
        openedAt: c.openedAt.toISOString(),
        closedAt: c.closedAt ? c.closedAt.toISOString() : null,
        durationSeconds,
        slaBucketReached: classifySlaBucket(durationSeconds / 3600),
        repeatFailure: c.repeatFailure,
        assignedSeId: c.ticket?.assignedSeId ?? submission?.seId ?? null,
        plantId: c.ticket ? String(c.ticket.plantId) : null,
        companyId: c.ticket ? String(c.ticket.companyId) : null,
        rootCauseCategory: submission?.rootCauseCategory ?? null,
        componentRelated,
        vehicleUnavailableImpact: (c.ticket ? vuTickets.has(c.ticket.ticketId) : false) || c.slaPauseReason === 'VEHICLE_UNAVAILABLE',
        componentBlockedImpact: componentRelated || c.slaPauseReason === 'WAITING_COMPONENT',
        verificationOutcome: outcomeRun?.outcome ?? null,
        closureType: c.ticket?.closureType ?? null,
        autoRecovery: c.ticket?.status === 'CLOSED_AUTO_RECOVERY',
      };
    });

    return { result: 'OK', deviceId: String(deviceId), cycles: views };
  }

  async downtimeTrend(deviceId: bigint, scope: DeviceScope): Promise<DowntimeTrendOutcome> {
    if (!(await this.visible(deviceId, scope))) return { result: 'NOT_FOUND' };

    const summaries = await this.prisma.deviceDowntimeSummaryMonthly.findMany({ where: { deviceId }, orderBy: { month: 'asc' } });

    const rcRows = await this.prisma.$queryRaw<{ month: Date; category: RootCauseCategory; count: number }[]>(Prisma.sql`
      SELECT date_trunc('month', ts.submitted_at)::date AS month, ts.root_cause_category AS category, COUNT(*)::int AS count
      FROM troubleshooting_submissions ts
      JOIN tickets t ON t.ticket_id = ts.ticket_id
      WHERE t.device_id = ${deviceId}
      GROUP BY 1, 2
      ORDER BY 1`);

    const hours = (seconds: bigint | number) => Math.round((Number(seconds) / 3600) * 100) / 100;
    const monthly: DowntimeTrendMonth[] = summaries.map((s) => ({
      month: s.month.toISOString().slice(0, 10),
      downtimeHours: hours(s.downtimeSeconds),
      cycleCount: s.cycleCount,
      repeatFailureCount: s.repeatFailureCount,
      autoRecoveryClosures: s.autoRecoveryClosures,
      seRepairedClosures: s.seRepairedClosures,
      componentDowntimeHours: hours(s.componentDowntimeSeconds),
      avgTimeToRecoverHours: s.recoveredCycles > 0 ? hours(Number(s.recoverSecondsSum) / s.recoveredCycles) : null,
    }));

    const sum = (pick: (s: (typeof summaries)[number]) => number) => summaries.reduce((acc, s) => acc + pick(s), 0);
    const recoverSecondsSum = sum((s) => Number(s.recoverSecondsSum));
    const recoveredCycles = sum((s) => s.recoveredCycles);
    const longestEpisodeSeconds = summaries.reduce((max, s) => Math.max(max, Number(s.longestEpisodeSeconds)), 0);

    const trend: DeviceDowntimeTrend = {
      deviceId: String(deviceId),
      lifetime: {
        totalCycles: sum((s) => s.cycleCount),
        totalDowntimeHours: hours(sum((s) => Number(s.downtimeSeconds))),
        repeatFailures: sum((s) => s.repeatFailureCount),
        longestEpisodeHours: hours(longestEpisodeSeconds),
        avgTimeToRecoverHours: recoveredCycles > 0 ? hours(recoverSecondsSum / recoveredCycles) : null,
        autoRecoveryClosures: sum((s) => s.autoRecoveryClosures),
        seRepairedClosures: sum((s) => s.seRepairedClosures),
      },
      monthly,
      rootCauseTrend: rcRows.map((r) => ({ month: r.month.toISOString().slice(0, 10), category: r.category, count: r.count })),
    };
    return { result: 'OK', trend };
  }

  /** Device exists and is visible to this scope (ZM → own zone only). */
  private async visible(deviceId: bigint, scope: DeviceScope): Promise<boolean> {
    const device = await this.prisma.device.findUnique({ where: { deviceId }, select: { deviceId: true } });
    if (!device) return false;
    if (scope.role !== 'ZONAL_MANAGER') return true;
    const zoneId = await this.deviceZone(deviceId);
    return zoneId !== null && zoneId === scope.zoneId;
  }

  /** The device's zone via its hot `device_states` plant, falling back to its most recent ticket's plant. */
  private async deviceZone(deviceId: bigint): Promise<number | null> {
    const ds = await this.prisma.deviceState.findUnique({ where: { deviceId }, select: { plantId: true } });
    if (ds?.plantId != null) {
      const plant = await this.prisma.plant.findUnique({ where: { plantId: ds.plantId }, select: { zoneId: true } });
      if (plant?.zoneId != null) return Number(plant.zoneId);
    }
    const ticket = await this.prisma.ticket.findFirst({
      where: { deviceId },
      orderBy: { lastStateChangedAt: 'desc' },
      select: { plant: { select: { zoneId: true } } },
    });
    return ticket?.plant.zoneId != null ? Number(ticket.plant.zoneId) : null;
  }
}
