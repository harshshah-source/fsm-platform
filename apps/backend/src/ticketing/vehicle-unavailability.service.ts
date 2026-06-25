import { Injectable } from '@nestjs/common';
import { type VehicleUnavailReason } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

export interface VuActor {
  userId: string;
  role: string;
  zoneId: number | null;
}

export interface FileReportInput {
  ticketId: string;
  seId: string;
  reasonCode: VehicleUnavailReason;
  transporterContacted: boolean;
  expectedFrom: Date;
  expectedTo?: Date | null;
  notes?: string | null;
  gpsLat?: number | null;
  gpsLng?: number | null;
}

export type VuOutcome =
  | { result: 'OK'; id: string }
  | { result: 'FORBIDDEN' }
  | { result: 'NOT_FOUND' };

export interface VuScope {
  role: string;
  zoneId: number | null;
}

export interface VehicleUnavailRow {
  id: string;
  ticketId: string;
  seId: string;
  plantName: string;
  reasonCode: VehicleUnavailReason;
  transporterContacted: boolean;
  expectedFrom: string;
  expectedTo: string | null;
  notes: string | null;
  status: string;
  slaPaused: boolean;
  /** Effective (pausable) SLA elapsed seconds. */
  primarySlaSeconds: number;
  /** True elapsed seconds from the Failure Cycle's opened_at — never pauses (ZM/CSM/OH only). */
  secondarySlaSeconds: number;
  createdAt: string;
}

const MANAGER_ROLES = ['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD'];

/**
 * Vehicle Unavailability Report + dual SLA clocks (Issue 28). Filing pauses the primary SLA on the
 * ticket's Failure Cycle (pause_reason = VEHICLE_UNAVAILABLE) and stores the expected-availability
 * date. The ZM list derives BOTH clocks from the cycle; the secondary (true elapsed) is manager-only.
 * The ZM may confirm/edit the date or manually resume the SLA (which resolves the report).
 */
@Injectable()
export class VehicleUnavailabilityService {
  constructor(private readonly prisma: PrismaService) {}

  async fileReport(input: FileReportInput, actor: VuActor, now: Date = new Date()): Promise<VuOutcome> {
    const ticket = await this.prisma.ticket.findUnique({ where: { ticketId: input.ticketId } });
    if (!ticket) return { result: 'NOT_FOUND' };
    const isManager = MANAGER_ROLES.includes(actor.role);
    if (!(isManager || actor.userId === input.seId)) return { result: 'FORBIDDEN' };

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.vehicleUnavailabilityReport.create({
        data: {
          ticketId: input.ticketId,
          failureCycleId: ticket.failureCycleId,
          seId: input.seId,
          reasonCode: input.reasonCode,
          transporterContacted: input.transporterContacted,
          expectedFrom: input.expectedFrom,
          expectedTo: input.expectedTo ?? null,
          notes: input.notes ?? null,
          gpsLat: input.gpsLat ?? null,
          gpsLng: input.gpsLng ?? null,
        },
      });
      // Pause the primary SLA (only if not already paused for another reason).
      if (ticket.failureCycleId) {
        const cycle = await tx.failureCycle.findUnique({ where: { cycleId: ticket.failureCycleId } });
        if (cycle && !cycle.slaPaused) {
          await tx.failureCycle.update({
            where: { cycleId: ticket.failureCycleId },
            data: {
              slaPaused: true,
              slaPauseReason: 'VEHICLE_UNAVAILABLE',
              slaPausedAt: now,
              slaPauseSource: 'SE_VEHICLE_UNAVAILABLE',
            },
          });
        }
        await tx.ticket.update({ where: { ticketId: input.ticketId }, data: { lastStateChangedAt: now } });
      }
      return { result: 'OK', id: String(created.id) };
    });
  }

  /** ZM-scoped open reports with both SLA clocks. A ZONAL_MANAGER sees only their own zone. */
  async listForZone(scope: VuScope, now: Date = new Date()): Promise<VehicleUnavailRow[]> {
    const reports = await this.prisma.vehicleUnavailabilityReport.findMany({
      where: {
        status: 'OPEN',
        ...(scope.role === 'ZONAL_MANAGER' && scope.zoneId != null
          ? { ticket: { plant: { zoneId: BigInt(scope.zoneId) } } }
          : {}),
      },
      include: { ticket: { include: { plant: { select: { name: true } }, failureCycle: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return reports.map((r) => {
      const cycle = r.ticket.failureCycle;
      const secondary = cycle ? Math.floor((now.getTime() - cycle.openedAt.getTime()) / 1000) : 0;
      const currentPause = cycle?.slaPaused && cycle.slaPausedAt ? Math.floor((now.getTime() - cycle.slaPausedAt.getTime()) / 1000) : 0;
      const primary = cycle ? Math.max(0, secondary - Number(cycle.slaAccumulatedPauseSeconds) - currentPause) : 0;
      return {
        id: String(r.id),
        ticketId: r.ticketId,
        seId: r.seId,
        plantName: r.ticket.plant.name,
        reasonCode: r.reasonCode,
        transporterContacted: r.transporterContacted,
        expectedFrom: r.expectedFrom.toISOString(),
        expectedTo: r.expectedTo ? r.expectedTo.toISOString() : null,
        notes: r.notes,
        status: r.status,
        slaPaused: cycle?.slaPaused ?? false,
        primarySlaSeconds: primary,
        secondarySlaSeconds: secondary,
        createdAt: r.createdAt.toISOString(),
      };
    });
  }

  /** ZM edits/confirms the expected-availability date. */
  async confirmDate(reportId: string, expectedFrom: Date, actor: VuActor): Promise<VuOutcome> {
    const report = await this.prisma.vehicleUnavailabilityReport.findUnique({ where: { id: BigInt(reportId) } });
    if (!report) return { result: 'NOT_FOUND' };
    if (!(await this.isManagerForTicket(report.ticketId, actor))) return { result: 'FORBIDDEN' };
    await this.prisma.vehicleUnavailabilityReport.update({ where: { id: BigInt(reportId) }, data: { expectedFrom } });
    return { result: 'OK', id: reportId };
  }

  /** ZM manually resumes the primary SLA and resolves the report. */
  async resumeSla(reportId: string, actor: VuActor, now: Date = new Date()): Promise<VuOutcome> {
    const report = await this.prisma.vehicleUnavailabilityReport.findUnique({ where: { id: BigInt(reportId) } });
    if (!report) return { result: 'NOT_FOUND' };
    if (!(await this.isManagerForTicket(report.ticketId, actor))) return { result: 'FORBIDDEN' };

    await this.prisma.$transaction(async (tx) => {
      if (report.failureCycleId) {
        const cycle = await tx.failureCycle.findUnique({ where: { cycleId: report.failureCycleId } });
        if (cycle?.slaPaused && cycle.slaPausedAt) {
          const addSeconds = Math.floor((now.getTime() - cycle.slaPausedAt.getTime()) / 1000);
          await tx.failureCycle.update({
            where: { cycleId: report.failureCycleId },
            data: {
              slaPaused: false,
              slaPauseReason: null,
              slaPausedAt: null,
              slaPauseSource: null,
              slaAccumulatedPauseSeconds: cycle.slaAccumulatedPauseSeconds + BigInt(addSeconds),
            },
          });
        }
      }
      await tx.vehicleUnavailabilityReport.update({
        where: { id: BigInt(reportId) },
        data: { status: 'RESOLVED', resolvedBy: actor.userId.length === 36 ? actor.userId : null, resolvedByRole: actor.role, resolvedAt: now },
      });
    });
    return { result: 'OK', id: reportId };
  }

  private async isManagerForTicket(ticketId: string, actor: VuActor): Promise<boolean> {
    if (actor.role === 'CENTRAL_SERVICE_MANAGER' || actor.role === 'OPERATIONS_HEAD') return true;
    if (actor.role !== 'ZONAL_MANAGER') return false;
    if (actor.zoneId == null) return true;
    const ticket = await this.prisma.ticket.findUnique({ where: { ticketId }, include: { plant: { select: { zoneId: true } } } });
    return ticket != null && Number(ticket.plant.zoneId) === actor.zoneId;
  }
}
