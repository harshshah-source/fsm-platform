import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { meetsRecoveryCriteria, type RecoveryThresholds } from './recovery-criteria';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AutoRecoveryActor {
  userId: string;
  role: string;
  actedAsRole?: string | null;
}

export type ManualCloseResult = 'CLOSED' | 'NOT_FOUND' | 'NOT_OPEN';

/**
 * AutoRecoveryService (CONTEXT "Auto-Recovery", Issue 08). Scans open Troubleshoot Tickets; when a
 * device has resumed pinging (≥3 pings ≥15 min after its Failure Cycle opened) **without any SE
 * troubleshooting form**, the Ticket closes as `CLOSED_AUTO_RECOVERY` — kept distinct from a
 * SE-repaired `CLOSED` so productivity/component reports aren't inflated. The cycle goes `VERIFIED`
 * (device verified back online, no effort credited), the open-cycle flag clears, and a lifecycle
 * event is recorded — all in one transaction.
 */
@Injectable()
export class AutoRecoveryService {
  constructor(private readonly prisma: PrismaService) {}

  async runAutoRecovery(
    now: Date = new Date(),
    thresholds: RecoveryThresholds = {},
  ): Promise<{ closed: number }> {
    const openTickets = await this.prisma.ticket.findMany({
      where: { workType: 'TROUBLESHOOT', status: 'OPEN' },
      include: { failureCycle: true },
    });

    let closed = 0;
    for (const ticket of openTickets) {
      const cycle = ticket.failureCycle;
      if (!cycle) continue;

      // No SE troubleshooting form may have been submitted (CONTEXT §Auto-Recovery). Issue 16 moves a
      // ticket to VERIFICATION_PENDING on submit, so the `status: 'OPEN'` scan above already excludes
      // any ticket that has a submission — auto-recovery can only fire on a never-worked ticket.
      const pings = await this.prisma.rawDeviceSnapshot.findMany({
        where: { deviceId: ticket.deviceId, gpsDatetime: { gt: cycle.openedAt } },
        select: { gpsDatetime: true },
      });
      if (!meetsRecoveryCriteria(pings.map((p) => p.gpsDatetime), thresholds)) continue;

      await this.closeAsAutoRecovery(ticket.ticketId, ticket.status, cycle.cycleId, ticket.deviceId, now);
      closed++;
    }
    return { closed };
  }

  /**
   * A ZM (or CSM/OpsHead) manually marks an open Troubleshoot Ticket CLOSED_AUTO_RECOVERY (AC#3).
   * Zone-scoped: a ZONAL_MANAGER may only close own-zone tickets (else NOT_FOUND). Already-closed
   * tickets are NOT_OPEN (→ 409).
   */
  async manualClose(
    ticketId: string,
    scope: { role: string; zoneId: number | null },
    actor: AutoRecoveryActor,
    now: Date = new Date(),
  ): Promise<ManualCloseResult> {
    if (!UUID_RE.test(ticketId)) return 'NOT_FOUND';
    const zoneWhere =
      scope.role === 'ZONAL_MANAGER' && scope.zoneId !== null
        ? { plant: { zoneId: BigInt(scope.zoneId) } }
        : {};
    const ticket = await this.prisma.ticket.findFirst({
      where: { ticketId, ...zoneWhere },
      include: { failureCycle: true },
    });
    if (!ticket) return 'NOT_FOUND';
    if (ticket.status !== 'OPEN' || ticket.workType !== 'TROUBLESHOOT' || !ticket.failureCycle)
      return 'NOT_OPEN';

    await this.closeAsAutoRecovery(
      ticket.ticketId,
      ticket.status,
      ticket.failureCycle.cycleId,
      ticket.deviceId,
      now,
      actor,
    );
    return 'CLOSED';
  }

  /** Close a single Ticket as auto-recovered. `actor` null = system (the scan); set = manual close. */
  async closeAsAutoRecovery(
    ticketId: string,
    fromStatus: string,
    cycleId: string,
    deviceId: bigint,
    now: Date,
    actor: AutoRecoveryActor | null = null,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.ticket.update({
        where: { ticketId },
        data: { status: 'CLOSED_AUTO_RECOVERY', lastStateChangedAt: now },
      });
      await tx.failureCycle.update({
        where: { cycleId },
        data: { state: 'VERIFIED', closedAt: now },
      });
      await tx.ticketEvent.create({
        data: {
          ticketId,
          fromState: fromStatus,
          toState: 'CLOSED_AUTO_RECOVERY',
          at: now,
          actorId: actor?.userId ?? null,
          actorRole: (actor?.role as never) ?? null,
          actedAsRole: (actor?.actedAsRole as never) ?? null,
          reasonCode: actor ? 'MANUAL_AUTO_RECOVERY' : null,
        },
      });
      await tx.deviceState.updateMany({
        where: { deviceId },
        data: { hasOpenFailureCycle: false },
      });
    });
  }
}
