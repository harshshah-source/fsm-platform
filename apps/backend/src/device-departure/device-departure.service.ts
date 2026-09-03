import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import type { $Enums } from '../generated/prisma/client';
import { isOperationalStatus } from '../ingestion/autoplant/master-mapping';
import { PrismaService } from '../prisma/prisma.service';
import { LIVE_FAILURE_CYCLE_STATES, RESOLVED_TICKET_STATUSES } from '../ticketing/resolved-ticket-status';
import { REMOVAL_REASONS } from '../scheduling/removal-reason';

/**
 * FSM-owned device deployment lifecycle (Issue 128) — the device-grain twin of
 * {@link PlantDeactivationService} (#119): observe the source, never delete, reversible, audited,
 * sync-durable.
 *
 * **The gap this closes.** Master sync used to read `mst_vehicle` filtered to
 * `deployment_status IN ('DEPLOYED')` and upsert only the rows that filtered read returned, so a
 * vehicle that LEFT the deployed fleet was never written again — its mirror froze at `'DEPLOYED'`
 * forever. Measured on production 2026-07-17: all 20,856 FSM vehicles read DEPLOYED against 15,652
 * actually deployed, and **739 of 1,738 devices on live dispatch batches (42.5%) were UNDEPLOYED at
 * source** — half the dispatch queue was wasted truck rolls.
 *
 * **Two detection paths, deliberately not equal in trust:**
 *  - `SOURCE_STATUS` — the widened read OBSERVED a non-operational status. Trustworthy: applied
 *    unconditionally.
 *  - `ABSENT_FROM_READ` — the device is not in the read at all (AutoPlant drops a `device_id`
 *    outright when a vehicle is unfitted; 3–7% of every sample). This is INFERRED, so a bad or
 *    truncated read could mass-depart the fleet. It is therefore guard-railed twice: absence is only
 *    meaningful inside the plant scope the read actually covered, and a swing beyond
 *    {@link DEFAULT_MAX_ABSENCE_RATIO} aborts the absence pass entirely, marking nothing.
 *
 * Restores are the same observation running backwards: a device seen operational again closes its
 * active departure and resumes automatically — no manual step, nothing destroyed.
 */

/**
 * Terminal ticket statuses — everything else is "open" work a departure cancels (mirrors #119).
 * Re-exported for #218c's stand-down export, which must select the SAME ticket set this pass closes:
 * respelling the predicate there is how the two would silently drift apart.
 *
 * #308 — this was one of the two **divergent** copies (four members). It now aliases the canonical
 * seven, so a ticket already terminal at `FAILED_VERIFICATION` / `FAILED_ACTIVATION` /
 * `RECEIVED_AT_WAREHOUSE` is no longer re-closed as `CLOSED / DEVICE_UNDEPLOYED_CLOSE` with its
 * `closure_type`, `closed_at` and closure event overwritten. What the departure still needs from such
 * a device — a live failure cycle terminated — is now taken from the cycle directly; see
 * `openDepartures`.
 */
export const TERMINAL_TICKET_STATUSES: $Enums.TicketStatus[] = [...RESOLVED_TICKET_STATUSES];

/** `observed_status` sentinel for the absence path — the device is in no source row at all. */
export const MISSING_FROM_SOURCE = 'MISSING_FROM_SOURCE';

/**
 * Absence-diff blast limiter: if one run would mark more than this fraction of the in-scope fleet as
 * MISSING_FROM_SOURCE, the absence pass is abandoned and an alert logged. Sized against measured
 * reality (2026-07-17: genuinely-absent devices run ~3% of a random sample, ~6.8% of live-batch
 * devices), so it clears normal churn — including the one-time backfill — while a truncated read
 * (which presents as a large slice of the fleet vanishing at once) trips it.
 */
export const DEFAULT_MAX_ABSENCE_RATIO = 0.1;

export type DepartureReason = 'SOURCE_STATUS' | 'ABSENT_FROM_READ';

export interface DeparturePlanRow {
  deviceId: string;
  /** Verbatim source status, or {@link MISSING_FROM_SOURCE}. */
  observedStatus: string;
  reason: DepartureReason;
  plantId: bigint | null;
}

export interface ReconcileInput {
  /**
   * `device_id` → verbatim source `deployment_status`, for EVERY row of the widened (all-status)
   * read — including rows FSM did not mirror. Membership is what distinguishes "observed
   * non-operational" from "absent".
   */
  observed: Map<string, string | null>;
  /**
   * FSM `plant_id`s this run actually synced. Absence is only meaningful inside the scope the read
   * covered: a device under a plant the read never visited (an FSM-seeded plant, or one that fell out
   * of ACTIVE scope) must never be inferred departed. Without this the pass would mark every
   * non-AutoPlant device in the database as MISSING_FROM_SOURCE.
   */
  syncedPlantIds: bigint[];
  /** Master-sync run that observed this — stamped on every transition for provenance. */
  runId?: bigint | null;
  maxAbsenceRatio?: number;
  now?: Date;
  /** Compute and return the plan without writing anything (the #128 backfill dry-run gate). */
  dryRun?: boolean;
}

export interface ReconcileResult {
  /** Departures opened (or, in a dry run, that would be opened). */
  departed: number;
  /** Active departures closed by a re-deployment. */
  restored: number;
  cancelledTickets: number;
  /** Devices the absence path proposed; equals `guardTripped ? marked-nothing : included in departed`. */
  absentCandidates: number;
  guardTripped: boolean;
  /** Itemised no-ops (`ABSENCE_GUARD_TRIPPED`), mirroring master-sync's skip accounting. */
  skippedByReason: Record<string, number>;
  /** Populated only for `dryRun` — the rows that would be marked, for operator review. */
  plan?: DeparturePlanRow[];
}

interface FsmDeviceRow {
  device_id: string;
  plant_id: bigint | null;
  active_departure_id: bigint | null;
}

@Injectable()
export class DeviceDepartureService {
  private readonly logger = new Logger(DeviceDepartureService.name);

  // Audit rows are written directly on the caller's `tx` rather than through `AuditService.withAudit`:
  // that helper wraps a transaction and writes exactly ONE row, while a reconcile emits one row per
  // transitioning device. The invariant it exists to protect is preserved — the audit inserts commit
  // in the same transaction as the mutations they record, so nothing is ever persisted unaudited.
  constructor(private readonly prisma: PrismaService) {}

  /** Devices with an ACTIVE departure — the exclusion set every downstream gate keys on. */
  async activeDepartedDeviceIds(): Promise<string[]> {
    const rows = await this.prisma.deviceDeparture.findMany({
      where: { restoredAt: null },
      select: { deviceId: true },
    });
    return rows.map((r) => r.deviceId);
  }

  /**
   * Reconcile FSM's known devices against one widened source read: open departures for devices that
   * left the operational fleet, close departures for devices that returned. Idempotent — a re-run
   * over an unchanged read is a no-op (the one-active-per-device partial unique is the backstop).
   */
  async reconcile(input: ReconcileInput): Promise<ReconcileResult> {
    const now = input.now ?? new Date();
    const maxAbsenceRatio = input.maxAbsenceRatio ?? DEFAULT_MAX_ABSENCE_RATIO;
    const skippedByReason: Record<string, number> = {};

    // One read of the device universe + its active departures. Same posture as master-sync's
    // `existingKeys`: load the (fleet-bounded) mirror rather than an IN() over tens of thousands of ids.
    const devices = await this.prisma.$queryRaw<FsmDeviceRow[]>(Prisma.sql`
      SELECT d.device_id, v.plant_id, dd.id AS active_departure_id
      FROM devices d
      LEFT JOIN vehicles v ON v.vehicle_id = d.current_vehicle_id
      LEFT JOIN device_departures dd ON dd.device_id = d.device_id AND dd.restored_at IS NULL`);

    const syncedPlants = new Set(input.syncedPlantIds.map((p) => p.toString()));
    const toDepart: DeparturePlanRow[] = [];
    const absent: DeparturePlanRow[] = [];
    const toRestore: { deviceId: string; status: string }[] = [];
    let inScopeDevices = 0;

    for (const d of devices) {
      const inScope = d.plant_id !== null && syncedPlants.has(d.plant_id.toString());
      if (inScope) inScopeDevices++;

      if (input.observed.has(d.device_id)) {
        const status = input.observed.get(d.device_id) ?? null;
        const operational = isOperationalStatus(status);
        if (!operational && d.active_departure_id === null) {
          toDepart.push({
            deviceId: d.device_id,
            // A null/blank source status is itself non-operational; record it legibly rather than
            // writing an empty string nobody can interpret later.
            observedStatus: (status ?? '').trim() || 'UNKNOWN',
            reason: 'SOURCE_STATUS',
            plantId: d.plant_id,
          });
        } else if (operational && d.active_departure_id !== null) {
          toRestore.push({ deviceId: d.device_id, status: (status ?? '').trim() || 'UNKNOWN' });
        }
      } else if (inScope && d.active_departure_id === null) {
        absent.push({
          deviceId: d.device_id,
          observedStatus: MISSING_FROM_SOURCE,
          reason: 'ABSENT_FROM_READ',
          plantId: d.plant_id,
        });
      }
    }

    // Guard rail: a truncated/partial read presents as a large slice of the in-scope fleet vanishing
    // at once. Inference must never be allowed to mass-depart the fleet, so the whole absence pass is
    // abandoned — the OBSERVED (SOURCE_STATUS) departures still apply, because those are not inferred.
    const absenceRatio = inScopeDevices === 0 ? 0 : absent.length / inScopeDevices;
    const guardTripped = absent.length > 0 && absenceRatio > maxAbsenceRatio;
    if (guardTripped) {
      skippedByReason.ABSENCE_GUARD_TRIPPED = absent.length;
      this.logger.error(
        `Departure absence guard TRIPPED: ${absent.length}/${inScopeDevices} in-scope devices ` +
          `(${(absenceRatio * 100).toFixed(1)}%) absent from the source read — above the ` +
          `${(maxAbsenceRatio * 100).toFixed(1)}% limit. Marking NOTHING from the absence path; ` +
          `suspect a truncated read. Observed status departures still applied.`,
      );
    } else {
      toDepart.push(...absent);
    }

    if (input.dryRun) {
      return {
        departed: toDepart.length,
        restored: toRestore.length,
        cancelledTickets: await this.countOpenTickets(toDepart.map((r) => r.deviceId)),
        absentCandidates: absent.length,
        guardTripped,
        skippedByReason,
        plan: toDepart,
      };
    }

    if (toDepart.length === 0 && toRestore.length === 0) {
      return { departed: 0, restored: 0, cancelledTickets: 0, absentCandidates: absent.length, guardTripped, skippedByReason };
    }

    const cancelledTickets = await this.prisma.$transaction(async (tx) => {
      const cancelled = await this.openDepartures(tx, toDepart, input.runId ?? null, now);
      await this.closeDepartures(tx, toRestore, input.runId ?? null, now);
      return cancelled;
    });

    this.logger.log(
      `Departure reconcile: +${toDepart.length} departed (${absent.length} absent${
        guardTripped ? ', GUARD TRIPPED — none applied' : ''
      }), -${toRestore.length} restored, ${cancelledTickets} tickets cancelled`,
    );
    return {
      departed: toDepart.length,
      restored: toRestore.length,
      cancelledTickets,
      absentCandidates: absent.length,
      guardTripped,
      skippedByReason,
    };
  }

  private countOpenTickets(deviceIds: string[]): Promise<number> {
    if (deviceIds.length === 0) return Promise.resolve(0);
    return this.prisma.ticket.count({
      where: { deviceId: { in: deviceIds }, status: { notIn: TERMINAL_TICKET_STATUSES } },
    });
  }

  /**
   * Open one departure per device and cancel that device's open tickets (#119 semantics, reason
   * DEVICE_UNDEPLOYED). Set-based: the per-row loop #119 uses is fine for one plant's tickets but this
   * pass marks ~6.9k devices on the first (backfill) run.
   */
  private async openDepartures(
    tx: Prisma.TransactionClient,
    rows: DeparturePlanRow[],
    runId: bigint | null,
    now: Date,
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const deviceIds = rows.map((r) => r.deviceId);

    // Every ticket these devices hold, so the live-cycle sweep below can see the cycles hanging off
    // ALREADY-terminal tickets too (#308) — `open` is only the subset this pass closes.
    const allTickets = await tx.ticket.findMany({
      where: { deviceId: { in: deviceIds } },
      select: { ticketId: true, status: true, deviceId: true, failureCycleId: true },
    });
    const terminal = new Set<string>(TERMINAL_TICKET_STATUSES);
    const open = allTickets.filter((t) => !terminal.has(t.status));
    const cancelledByDevice = new Map<string, number>();
    for (const t of open) cancelledByDevice.set(t.deviceId, (cancelledByDevice.get(t.deviceId) ?? 0) + 1);
    const statusByDevice = new Map(rows.map((r) => [r.deviceId, r.observedStatus]));

    await tx.deviceDeparture.createMany({
      data: rows.map((r) => ({
        deviceId: r.deviceId,
        observedStatus: r.observedStatus,
        reason: r.reason,
        departedAt: now,
        detectedByRunId: runId,
        cancelledTicketsCount: cancelledByDevice.get(r.deviceId) ?? 0,
      })),
    });

    if (open.length > 0) {
      // `closure_reason` carries the observed status verbatim, so grouping keeps the reason honest
      // per device without a per-ticket round trip. The distinct set is tiny (UNDEPLOYED / MAINTENANCE
      // / MISSING_FROM_SOURCE / the rare unknown value).
      const byStatus = new Map<string, string[]>();
      for (const t of open) {
        const status = statusByDevice.get(t.deviceId) ?? 'UNKNOWN';
        const list = byStatus.get(status) ?? [];
        list.push(t.ticketId);
        byStatus.set(status, list);
      }
      for (const [status, ticketIds] of byStatus) {
        // #308 — the status guard is in the WHERE, not only in the read above. The read and this write
        // are separated by the departure-row insert, and a ticket that reached a terminal state in that
        // window must keep its own closure rather than have `closure_type`/`closed_at` overwritten by
        // a departure that did not close it.
        await tx.ticket.updateMany({
          where: { ticketId: { in: ticketIds }, status: { notIn: TERMINAL_TICKET_STATUSES } },
          data: {
            status: 'CLOSED',
            closureType: 'DEVICE_UNDEPLOYED_CLOSE',
            closureReason: `DEVICE_UNDEPLOYED: ${status}`,
            closedAt: now,
            lastStateChangedAt: now,
          },
        });
      }
      // Which tickets this transaction actually closed — a guarded `updateMany` reports a count, not
      // rows, and every write below (event, day-plan detach) must describe the tickets that really
      // moved. Re-read rather than trust `open`, which is now only a candidate list.
      const closedIds = new Set(
        (
          await tx.ticket.findMany({
            where: {
              ticketId: { in: open.map((t) => t.ticketId) },
              closedAt: now,
              closureType: 'DEVICE_UNDEPLOYED_CLOSE',
            },
            select: { ticketId: true },
          })
        ).map((t) => t.ticketId),
      );
      const closed = open.filter((t) => closedIds.has(t.ticketId));
      await tx.ticketEvent.createMany({
        data: closed.map((t) => ({
          ticketId: t.ticketId,
          fromState: t.status,
          toState: 'CLOSED',
          reasonCode: 'DEVICE_UNDEPLOYED',
          at: now,
        })),
      });
      // #241 — end the assignment too, in the same transaction that closes the ticket. Closing a
      // ticket while leaving its batch row live is not a bookkeeping detail: every day-plan read
      // filters on `removed_at IS NULL` and *not* on ticket status, so a departed device's cancelled
      // ticket kept rendering on the SE's day plan as work to do. 3,310 such rows exist in the dev
      // mirror, 20 of them on ACTIVE schedules. `removed_by` is NULL because no human did this.
      await tx.batchAssignmentTicket.updateMany({
        where: { ticketId: { in: closed.map((t) => t.ticketId) }, removedAt: null },
        data: { removedAt: now, removedBy: null, removalReason: REMOVAL_REASONS.TICKET_CANCELLED },
      });
    }

    // Terminate the parent Failure Cycle → FAILED so it leaves the one-active-per-device set: a
    // returned device can open a fresh cycle, and FAILED (not VERIFIED) keeps the re-created ticket
    // from being mis-flagged a REPEAT. Same reasoning as #119.
    //
    // #308 — sourced from the device's cycles, NOT from the tickets this pass closed, and OUTSIDE the
    // `open.length > 0` branch. A `FAILED_VERIFICATION` ticket is terminal while its cycle stays live
    // (verification closes the cycle only on CLOSED), so the old ticket-driven set reached that cycle
    // *only* as a side effect of wrongly re-closing the ticket. Widening the terminal vocabulary
    // without moving this would have stranded those cycles live on a departed device whose only
    // ticket was already terminal — while `has_open_failure_cycle` was cleared anyway, which is
    // precisely the contradiction #218's lifecycle check exists to catch. The `state` filter also
    // means an already-terminated cycle is never re-stamped.
    const cycleIds = allTickets.map((t) => t.failureCycleId).filter((c): c is string => c !== null);
    const endedCycles =
      cycleIds.length === 0
        ? { count: 0 }
        : await tx.failureCycle.updateMany({
            where: { cycleId: { in: cycleIds }, state: { in: [...LIVE_FAILURE_CYCLE_STATES] } },
            data: { state: 'FAILED', closedAt: now },
          });
    if (open.length > 0 || endedCycles.count > 0) {
      await tx.deviceState.updateMany({
        where: { deviceId: { in: deviceIds } },
        data: { hasOpenFailureCycle: false },
      });
    }

    await tx.auditLog.createMany({
      data: rows.map((r) => ({
        actorId: 'SYSTEM',
        actorRole: 'SYSTEM',
        action: 'DEVICE_DEPARTED',
        entityType: 'DEVICE',
        entityId: r.deviceId,
        metadata: {
          observedStatus: r.observedStatus,
          reason: r.reason,
          runId: runId === null ? null : String(runId),
          cancelledTickets: cancelledByDevice.get(r.deviceId) ?? 0,
        },
      })),
    });
    return open.length;
  }

  /** Stamp the active departure restored. History is kept; nothing is deleted. */
  private async closeDepartures(
    tx: Prisma.TransactionClient,
    rows: { deviceId: string; status: string }[],
    runId: bigint | null,
    now: Date,
  ): Promise<void> {
    if (rows.length === 0) return;
    const byStatus = new Map<string, string[]>();
    for (const r of rows) {
      const list = byStatus.get(r.status) ?? [];
      list.push(r.deviceId);
      byStatus.set(r.status, list);
    }
    for (const [status, deviceIds] of byStatus) {
      await tx.deviceDeparture.updateMany({
        where: { deviceId: { in: deviceIds }, restoredAt: null },
        data: { restoredAt: now, restoredByRunId: runId, restoredStatus: status },
      });
    }
    await tx.auditLog.createMany({
      data: rows.map((r) => ({
        actorId: 'SYSTEM',
        actorRole: 'SYSTEM',
        action: 'DEVICE_REDEPLOYED',
        entityType: 'DEVICE',
        entityId: r.deviceId,
        metadata: { restoredStatus: r.status, runId: runId === null ? null : String(runId) },
      })),
    });
  }
}
