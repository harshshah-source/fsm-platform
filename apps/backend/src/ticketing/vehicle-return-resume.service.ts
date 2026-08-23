import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { returnDateArrivedBefore } from './deferral';
import { foldAndResumeSlaPause } from './sla-pause';

export interface VehicleReturnResumeResult {
  /** How many Failure Cycles this tick restarted. */
  resumed: number;
}

/**
 * #247 slice 2 — the primary SLA resumes when the vehicle is due back.
 *
 * Until this existed there were exactly two writers of `sla_paused = false`
 * (`vehicle-unavailability.service.ts`, `component-request.service.ts`) and **neither was
 * date-driven**. #246 made the ticket re-enter the dispatch pool on its authoritative return date all
 * by itself — the deferral simply lapses — but nothing restarted the clock that measures how long the
 * fix has taken. So a returned ticket was dispatchable, workable and closable with a frozen primary
 * SLA: the longer a vehicle had been away, the healthier the ticket looked in the very report the
 * pause exists to keep honest. A human had to notice and press resume, and nothing anywhere said so.
 *
 * **Why a sweep and not a read-time derivation.** `sla_accumulated_pause_seconds` is materialised, and
 * every consumer (the VU queue's two clocks, the SLA reports, `device-detail`) reads it directly. A
 * derived "…plus the interval since `paused_at`, if the date has passed" would have to be spread to
 * each of them — which is the six-copies failure `deferral.ts` exists to prevent — and would leave the
 * stored column permanently wrong for anything that reads it later.
 *
 * **Shape.** `TierOverrideExpiryService`: find the due rows, flip them in one transaction, write one
 * batched SYSTEM-actor audit insert for however many the tick found. The per-row update cannot be an
 * `updateMany` because the interval folded in differs per cycle, and the volume it iterates is bounded
 * by the number of *open* vehicle waits whose date has passed, not by the fleet.
 *
 * **Single writer, and idempotent through the same check that makes it safe.** The reason check is
 * what stops it double-counting: after the flip the cycle is not paused, so the next tick — and the
 * one the night after, while the report is still open — finds nothing. The same check is why a cycle
 * that went `WAITING_COMPONENT` during the wait is never touched: that pause is not this sweep's to
 * end, and clearing it would restart the clock on a ticket nobody can work (the manual mirror of this
 * is `resumeSla`'s AC1 guard).
 *
 * **#271 — no longer the only writer.** `troubleshoot-submission.service.ts` now folds the same
 * `VEHICLE_UNAVAILABLE` pause at the point submission ends the vehicle's absence, which is almost
 * always BEFORE this sweep would ever see the report (the report is resolved at submission, so this
 * sweep's own `status: 'OPEN'` filter naturally excludes it from then on — #253's dead scenario). This
 * sweep now exists for exactly the case submission cannot reach: nobody has submitted, but the vehicle
 * is due back anyway. The per-cycle fold below is routed through {@link foldAndResumeSlaPause}'s guarded
 * write specifically so that if a submission lands in the same instant this tick is running, at most
 * one of them folds the interval (AC-7) — the pre-filter immediately below is a cheap candidate list,
 * not the authority on which cycles are actually still paused when the write happens.
 *
 * **The report is deliberately left OPEN** (Decision 16). The vehicle being *due* back is not the same
 * as the SE finding it there; the report resolves when a submission closes the attempt or a fresh
 * absence supersedes it. Resuming the clock and resolving the report are two different claims, and
 * only the first one is true at this moment.
 */
@Injectable()
export class VehicleReturnResumeService {
  constructor(private readonly prisma: PrismaService) {}

  async sweepReturnedVehicles(now: Date = new Date()): Promise<VehicleReturnResumeResult> {
    const due = await this.prisma.vehicleUnavailabilityReport.findMany({
      where: {
        status: 'OPEN',
        expectedFrom: { lt: returnDateArrivedBefore(now) },
        failureCycleId: { not: null },
      },
      select: { id: true, ticketId: true, failureCycleId: true, expectedFrom: true },
    });
    if (due.length === 0) return { resumed: 0 };

    // The report is the trigger; the cycle is what gets written. Keyed by cycle so that two reports
    // pointing at one cycle fold the interval in once — "exactly once" (AC2) has to survive the data,
    // not just the second tick.
    const reportByCycle = new Map<string, (typeof due)[number]>();
    for (const r of due) if (!reportByCycle.has(r.failureCycleId!)) reportByCycle.set(r.failureCycleId!, r);

    // Cheap candidate list, not the authority — see the class docstring (#271). A cycle that a
    // concurrent submission has already resumed by the time the transaction below runs will simply
    // fail its guarded write and drop out of `resumptions`.
    const candidates = await this.prisma.failureCycle.findMany({
      where: {
        cycleId: { in: [...reportByCycle.keys()] },
        slaPaused: true,
        slaPauseReason: 'VEHICLE_UNAVAILABLE',
        slaPausedAt: { not: null },
      },
      select: { cycleId: true },
    });
    if (candidates.length === 0) return { resumed: 0 };

    const resumptions: { cycleId: string; report: (typeof due)[number]; addedSeconds: number }[] = [];
    await this.prisma.$transaction(async (tx) => {
      for (const { cycleId } of candidates) {
        const fold = await foldAndResumeSlaPause(tx, cycleId, now, { onlyReason: 'VEHICLE_UNAVAILABLE' });
        if (fold.resumed) resumptions.push({ cycleId, report: reportByCycle.get(cycleId)!, addedSeconds: fold.addedSeconds });
      }
      if (resumptions.length === 0) return;
      // Actor = system: a scheduled sweep, not a manager's decision. Batched like the tier-override
      // and device-departure sweeps — one insert for however many rows this tick actually resumed
      // (not however many candidates it started with — a candidate a concurrent writer got to first
      // gets no audit row here, because this tick did nothing to it).
      await tx.auditLog.createMany({
        data: resumptions.map(({ cycleId, report, addedSeconds }) => ({
          actorId: 'SYSTEM',
          actorRole: 'SYSTEM',
          action: 'VU_SLA_AUTO_RESUMED',
          entityType: 'failure_cycles',
          entityId: cycleId,
          metadata: {
            ticketId: report.ticketId,
            reportId: report.id.toString(),
            expectedFrom: report.expectedFrom.toISOString(),
            addedPauseSeconds: addedSeconds,
          },
        })),
      });
    });

    return { resumed: resumptions.length };
  }
}
