import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SUPERSEDED_RECOMMENDATION_STATUSES } from '../recommender/recommendation-status';
import { RESOLVED_TICKET_STATUSES } from '../ticketing/resolved-ticket-status';
import type { ZmScope } from './zm-schedule-query.service';

export interface DispatchRunListRow {
  runId: string;
  trigger: string;
  /** Actor role for a MANUAL run (null for CRON / system runs). */
  actorRole: string | null;
  /** Actor display name for a MANUAL run, resolved from actorUserId (null for CRON / unknown user). */
  actorName: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  status: string;
  zones: number;
  schedules: number;
  batches: number;
  ticketsDispatched: number;
  recommended: number;
  unassignable: number;
  errorCount: number;
}

export interface DispatchRunZoneCard {
  zoneId: string;
  zoneName: string | null;
  mode: string | null;
  weightSetRef: string | null;
  ticketsConsidered: number;
  recommended: number;
  unassignable: number;
  unassignableReasons: Record<string, unknown> | null;
  schedules: number;
  batches: number;
  ticketsDispatched: number;
  error: string | null;
  /**
   * #259 — what this run's claim on the zone came to. DONE/ERROR are the two ways a zone this run held
   * finished; CONTENDED means it never held the zone at all, because another run did. Without it a
   * refused zone renders identically to a zone that had no work — zeros across the card — and those are
   * very different facts for whoever is asking why nothing was dispatched there.
   */
  outcome: string;
  /** #259 — for a CONTENDED card, the run that held the zone, so the operator can go and read it. */
  contendedWithRunId: string | null;
  /**
   * #262 — engineers this zone could not dispatch, and why. `error` above is the WHOLE-zone field; a
   * zone that dispatched four of five SEs did not fail, and recording that as a zone error would put a
   * contained single-engineer problem in the run's Errors column. Empty for every zone that dispatched
   * every SE, and for every row written before per-SE transactions existed.
   */
  seSkips: Array<{ seId: string; reason: string; constraint: string | null }>;
  /**
   * #252 (landed with #259) — the three populations the engine did **not** decide on, written to the
   * ledger by #238 / #242 / #177 and, until now, projected by nothing. Without them
   * `recommended + unassignable` reads as the whole funnel while a larger population sits outside it
   * entirely; on the dev mirror at #252's filing, 5,127 of 6,464 open unassigned Troubleshoot tickets
   * carried no computed SLA bucket.
   *
   * Kept apart from `unassignable` and from each other because they send different teams:
   * `unassignable` is an Ops coverage gap, `withheldBelowThreshold` is policy working,
   * `bucketlessDropped` is a data fault and `componentBlockedWithheld` is the warehouse's clock. The
   * last two are `null` when the zone's recommender never reported — "not recorded", not "none".
   */
  withheldBelowThreshold: number;
  bucketlessDropped: number | null;
  componentBlockedWithheld: number | null;
  /**
   * #179 follow-up — LIVE counters beside the historical `ticketsDispatched`. The ledger is
   * immutable ("this run dispatched X"), which read alone implies the work is still on engineers'
   * plans; it is not, once a bulk unassign or a ZM override stamped `removed_at`. Derived from the
   * run's own batch rows (`plant_batch_assignments.run_id`) — nothing in the ledger is rewritten.
   * `removedSince` deliberately does NOT attribute a cause: bulk unassign, REMOVE_TICKET and
   * DEFER_TICKET all stamp the same column, and guessing between them from timestamps would be
   * fiction. Both are 0 for a pre-#batch-run-attribution run whose batches carry no `run_id`.
   */
  ticketsStillAssigned: number;
  ticketsRemovedSince: number;
}

/**
 * #131 — the run's build attribution against the current runtime-lock high-water mark, the same
 * shape `AutoPlantHealthService` uses for `masterSync.build`/`snapshot.build` (#130 L3), plus the
 * current version/fingerprint the badge needs to render "ran under build vX, current vY" without a
 * second request. Null for a historical run predating #130 (no build columns stamped).
 */
export interface DispatchRunBuildStamp {
  buildVersion: string;
  buildFingerprint: string;
  staleBuild: boolean;
  currentVersion: string;
  currentFingerprint: string;
}

export interface DispatchRunDetail extends Omit<DispatchRunListRow, 'zones'> {
  actorUserId: string | null;
  /** #213 — the operator's optional one-line "why" for a MANUAL run. Null for CRON and for runs that
   *  predate the field, so the UI must treat its absence as normal rather than as missing data. */
  reason: string | null;
  /** The config that actually applied — frozen at run start, not today's values. */
  configSnapshot: Record<string, unknown>;
  /** Per-zone cards (a ZM sees only their own). Replaces the list row's numeric `zones` count. */
  zones: DispatchRunZoneCard[];
  build: DispatchRunBuildStamp | null;
}

export interface DispatchBatchRow {
  batchId: string;
  scheduleId: string;
  seId: string;
  seName: string | null;
  plantId: string;
  plantName: string;
  /**
   * Owning company for the batch, derived from its tickets (a batch is one plant, so normally one
   * company); when a batch spans companies the first is shown with a `+N` suffix. Null if no tickets.
   * Transporter is deliberately absent here — it is per-vehicle-per-ticket, not a clean batch-level
   * value; it surfaces at the assignment-row / trace level instead (follow-up #125 for batch rollup).
   */
  companyName: string | null;
  stopSequence: number;
  status: string;
  ticketCount: number;
  /** Tickets on the SE's whole Day Plan this run vs the capacity frozen in the run's snapshot. */
  capacityUsed: { used: number; cap: number | null };
}

export interface DispatchUnassignableRow {
  ticketId: string;
  deviceId: string | null;
  plantId: string | null;
  plantName: string | null;
  companyName: string | null;
  poolEmptyReason: string | null;
  dropCounts: Record<string, number>;
}

/**
 * Fleet context for a plant that received dispatch in this zone — the same device-health / assignment
 * signals the Company/Plant Overview shows, so a manager reads a plant's standing without leaving the
 * run. Device counts come from `device_states`; assigned/unassigned are the plant's tickets by
 * `assignment_state`. Keyed by plantId on the zone detail (not per batch — a plant-level value).
 */
export interface PlantDeviceStats {
  totalDevices: number;
  inactiveDevices: number;
  assignedDevices: number;
  unassignedDevices: number;
}

export interface DispatchZoneDetail {
  runId: string;
  zone: DispatchRunZoneCard;
  batches: DispatchBatchRow[];
  unassignable: DispatchUnassignableRow[];
  /** plantId → fleet device stats for every plant dispatched in this zone. */
  plantStats: Record<string, PlantDeviceStats>;
}

export interface DispatchAssignmentRow {
  ticketId: string;
  deviceId: string | null;
  /** Ticket context, resolved so managers read names not IDs. Vehicle/transporter null when unlinked. */
  companyName: string | null;
  vehicleNo: string | null;
  transporterName: string | null;
  /**
   * AutoPlant device context for the batch row (Inactive Duration / IMSI / Device Type / Trip Creation).
   * Resolved through the ticket's existing `device` relation — device identity off `devices` (master
   * sync), live state off `device_states` (30-min telemetry tick). All null for a ticket whose device
   * is unlinked or not yet tracked.
   */
  deviceType: string | null;
  imsiNo: string | null;
  /** Last GPS ping — the UI derives Inactive Duration from this, exactly as the device list does. */
  latestGpsDatetime: string | null;
  tripCreationDatetime: string | null;
  plantId: string;
  seId: string;
  sortOrder: number;
  /** Canonical processing rank from the recommendation (null for pre-ledger rows). */
  rank: number | null;
  score: number | null;
  /**
   * Whether this row's score is degenerate (all candidates score identically → precedence decided).
   * Surfaced on the row so the assignment table can hide numeric scores and show precedence terms
   * without a per-ticket trace fetch. Null for pre-ledger rows with no trace.
   */
  scoreDegenerate: boolean | null;
  recStatus: string | null;
  ticketStatus: string;
  hasTrace: boolean;
}

export interface DispatchBatchDetail {
  /** The run behind the batch's schedule. Null for pre-ledger schedules and for any schedule no
   * dispatch run produced — a manager's manual plan, and (since #283) a `SYSTEM_GENERATED` schedule
   * the intraday CRITICAL sweep created, which is the engine's work but not a *run's*. The batch is
   * addressed by its own id, so it still resolves; only the run-keyed trace is unavailable. */
  runId: string | null;
  batchId: string;
  scheduleId: string;
  zoneId: string;
  seId: string;
  seName: string | null;
  plantId: string;
  plantName: string;
  rows: DispatchAssignmentRow[];
}

export interface DispatchTicketTrace {
  runId: string;
  ticketId: string;
  seId: string | null;
  trace: Record<string, unknown>;
  scoreBreakdown: Record<string, unknown> | null;
  recStatus: string | null;
  /** seId → display name for every SE named in the trace (chosen + runners-up); UUIDs read as names. */
  seNames: Record<string, string | null>;
  /** Full ticket identity for the "why this SE" strip — read context without navigating away. */
  identity: {
    deviceId: string | null;
    vehicleNo: string | null;
    plantName: string | null;
    companyName: string | null;
    transporterName: string | null;
  };
}

/**
 * Batch-Assignment transparency reads (`/api/dispatch-runs/*`) — the drill-down over the
 * observe-only dispatch ledger: runs list → run detail (config-in-effect + zone cards) → zone
 * batches → assignment rows → per-ticket decision trace. Zone-scoped like
 * {@link ZmScheduleQueryService}: a ZONAL_MANAGER sees only their zone's slice at every level
 * (list totals included); CSM / Operations Head see all zones. Read-only — nothing here mutates
 * dispatch state.
 */
/**
 * #262 — read `dispatch_run_zones.se_skips` back into the shape the card renders.
 *
 * Defensive because the column is untyped JSONB written by one producer: a row from before the column
 * existed is NULL, and anything that is not the expected array shape is dropped rather than rendered
 * as `[object Object]` on an operator's screen. An empty array and a NULL therefore mean the same
 * thing to the reader — "no engineer was skipped" — which is the honest reading of both.
 */
function readSeSkips(raw: unknown): Array<{ seId: string; reason: string; constraint: string | null }> {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { seId, reason, constraint } = entry as Record<string, unknown>;
    if (typeof seId !== 'string' || typeof reason !== 'string') return [];
    return [{ seId, reason, constraint: typeof constraint === 'string' ? constraint : null }];
  });
}

@Injectable()
export class DispatchTransparencyQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async listRuns(scope: ZmScope, limit = 30): Promise<DispatchRunListRow[]> {
    const zoneClamp = this.zmZone(scope);
    const runs = await this.prisma.dispatchRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: limit,
      include: {
        zoneRows: {
          ...(zoneClamp !== null ? { where: { zoneId: zoneClamp } } : {}),
          select: {
            zoneId: true,
            status: true,
            schedules: true,
            batches: true,
            ticketsDispatched: true,
            recommended: true,
            unassignable: true,
            error: true,
          },
        },
      },
    });

    const actorNames = await this.resolveActorNames(runs.map((r) => r.actorUserId));
    return runs.map((run) => {
      const base = {
        runId: run.runId.toString(),
        trigger: run.trigger,
        actorRole: run.actorRole,
        actorName: run.actorUserId ? (actorNames.get(run.actorUserId) ?? null) : null,
        startedAt: run.startedAt.toISOString(),
        finishedAt: run.finishedAt?.toISOString() ?? null,
        durationMs: run.finishedAt ? run.finishedAt.getTime() - run.startedAt.getTime() : null,
        status: run.status,
      };
      if (zoneClamp === null) {
        return {
          ...base,
          zones: run.zones,
          schedules: run.schedules,
          batches: run.batches,
          ticketsDispatched: run.ticketsDispatched,
          recommended: run.recommended,
          unassignable: run.unassignable,
          errorCount: run.zoneRows.filter((z) => z.error !== null).length,
        };
      }
      // ZM slice: the run's totals are their zone row's totals.
      const mine = run.zoneRows[0];
      return {
        ...base,
        // #259 — a CONTENDED row means this run never held the zone. Counting it as a processed zone
        // would tell the ZM their zone was worked and produced nothing, when in fact it was not worked
        // at all; the run-level column beside it excludes contended zones for the same reason.
        zones: mine && mine.status !== 'CONTENDED' ? 1 : 0,
        schedules: mine?.schedules ?? 0,
        batches: mine?.batches ?? 0,
        ticketsDispatched: mine?.ticketsDispatched ?? 0,
        recommended: mine?.recommended ?? 0,
        unassignable: mine?.unassignable ?? 0,
        errorCount: mine?.error != null ? 1 : 0,
      };
    });
  }

  async getRunDetail(runId: bigint, scope: ZmScope): Promise<DispatchRunDetail | null> {
    const zoneClamp = this.zmZone(scope);
    const run = await this.prisma.dispatchRun.findUnique({
      where: { runId },
      include: {
        zoneRows: {
          ...(zoneClamp !== null ? { where: { zoneId: zoneClamp } } : {}),
          orderBy: { zoneId: 'asc' },
          include: { zone: { select: { name: true } } },
        },
      },
    });
    if (!run) return null;

    const liveByZone = await this.liveVsRemovedByZone(runId);
    const zoneCards: DispatchRunZoneCard[] = run.zoneRows.map((z) => {
      const live = liveByZone.get(z.zoneId.toString()) ?? { stillAssigned: 0, removedSince: 0 };
      return {
        zoneId: z.zoneId.toString(),
        zoneName: z.zone?.name ?? null,
        mode: z.mode,
        weightSetRef: z.weightSetRef,
        ticketsConsidered: z.ticketsConsidered,
        recommended: z.recommended,
        unassignable: z.unassignable,
        unassignableReasons: (z.unassignableReasons as Record<string, unknown> | null) ?? null,
        schedules: z.schedules,
        batches: z.batches,
        ticketsDispatched: z.ticketsDispatched,
        error: z.error,
        outcome: z.status,
        contendedWithRunId: z.contendedWithRunId?.toString() ?? null,
        seSkips: readSeSkips(z.seSkips),
        withheldBelowThreshold: z.withheldBelowThreshold,
        bucketlessDropped: z.bucketlessDropped,
        componentBlockedWithheld: z.componentBlockedWithheld,
        ticketsStillAssigned: live.stillAssigned,
        ticketsRemovedSince: live.removedSince,
      };
    });

    const actorNames = await this.resolveActorNames([run.actorUserId]);
    return {
      runId: run.runId.toString(),
      trigger: run.trigger,
      actorUserId: run.actorUserId,
      actorRole: run.actorRole,
      actorName: run.actorUserId ? (actorNames.get(run.actorUserId) ?? null) : null,
      reason: run.reason,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      durationMs: run.finishedAt ? run.finishedAt.getTime() - run.startedAt.getTime() : null,
      status: run.status,
      schedules: zoneClamp === null ? run.schedules : sum(zoneCards, (z) => z.schedules),
      batches: zoneClamp === null ? run.batches : sum(zoneCards, (z) => z.batches),
      ticketsDispatched: zoneClamp === null ? run.ticketsDispatched : sum(zoneCards, (z) => z.ticketsDispatched),
      recommended: zoneClamp === null ? run.recommended : sum(zoneCards, (z) => z.recommended),
      unassignable: zoneClamp === null ? run.unassignable : sum(zoneCards, (z) => z.unassignable),
      errorCount: zoneCards.filter((z) => z.error !== null).length,
      configSnapshot: (run.configSnapshot as Record<string, unknown>) ?? {},
      zones: zoneCards,
      build: await this.runBuildStamp(run.buildVersion, run.buildFingerprint),
    };
  }

  /**
   * #179 follow-up — per zone, how many of the tickets THIS run put on a day plan are still there
   * vs have since been pulled off. Reads the run's own batches (`plant_batch_assignments.run_id`)
   * and their ticket rows' `removed_at`, so it is exact and needs no correlation with the audit
   * log. One bounded query per run detail (scoped to that run's batches).
   */
  private async liveVsRemovedByZone(
    runId: bigint,
  ): Promise<Map<string, { stillAssigned: number; removedSince: number }>> {
    const rows = await this.prisma.batchAssignmentTicket.findMany({
      where: { batch: { runId } },
      select: { removedAt: true, batch: { select: { schedule: { select: { zoneId: true } } } } },
    });
    const byZone = new Map<string, { stillAssigned: number; removedSince: number }>();
    for (const r of rows) {
      const key = r.batch.schedule.zoneId.toString();
      const acc = byZone.get(key) ?? { stillAssigned: 0, removedSince: 0 };
      if (r.removedAt === null) acc.stillAssigned++;
      else acc.removedSince++;
      byZone.set(key, acc);
    }
    return byZone;
  }

  /**
   * #131 — the run's build stamp against the current `runtime_lock` high-water mark. Null when the
   * run predates #130 (no build columns stamped) or the lock has no row yet (fresh/unattributed DB).
   */
  private async runBuildStamp(
    buildVersion: bigint | null,
    buildFingerprint: string | null,
  ): Promise<DispatchRunBuildStamp | null> {
    if (buildVersion == null || buildFingerprint == null) return null;
    const rows = await this.prisma.$queryRawUnsafe<Array<{ version: string; fingerprint: string }>>(
      `SELECT version::text AS version, fingerprint FROM runtime_lock WHERE id = 1`,
    );
    const lock = rows[0];
    if (!lock) return null;
    return {
      buildVersion: buildVersion.toString(),
      buildFingerprint,
      staleBuild: buildVersion < BigInt(lock.version),
      currentVersion: lock.version,
      currentFingerprint: lock.fingerprint,
    };
  }

  async getZoneDetail(runId: bigint, zoneId: bigint, scope: ZmScope): Promise<DispatchZoneDetail | null> {
    const zoneClamp = this.zmZone(scope);
    if (zoneClamp !== null && zoneClamp !== zoneId) return null;

    const zoneRow = await this.prisma.dispatchRunZone.findUnique({
      where: { runId_zoneId: { runId, zoneId } },
      include: { zone: { select: { name: true } }, run: { select: { configSnapshot: true } } },
    });
    if (!zoneRow) return null;

    const capacityOf = capacityFromSnapshot(zoneRow.run.configSnapshot);
    // Batches THIS run created in the zone. A same-day re-run APPENDS fresh batches onto an SE's
    // existing schedule, so a schedule can span runs — attribution lives on the batch (`run_id`). The
    // `runId: null` leg attributes legacy batches (written before batch-level attribution) via their
    // schedule's run_id; those schedules are unshared, so exactly one leg matches per batch.
    const runBatches = await this.prisma.plantBatchAssignment.findMany({
      where: {
        schedule: { zoneId },
        OR: [{ runId }, { runId: null, schedule: { runId } }],
      },
      orderBy: [{ seId: 'asc' }, { stopSequence: 'asc' }],
      include: {
        plant: { select: { name: true } },
        engineer: { select: { user: { select: { name: true } } } },
        tickets: {
          where: { removedAt: null },
          select: { id: true, ticket: { select: { company: { select: { name: true } } } } },
        },
      },
    });

    const plantIds = [...new Set(runBatches.map((b) => b.plantId))];
    const plantStats = await this.plantDeviceStats(plantIds);

    // SE Day-Plan "used" = LIVE batch tickets across the SE's whole schedule for this zone/day (every
    // run that appended to it), against the run-snapshot capacity — the same whole-day denominator the
    // recommender enforces (NEW-A1). One grouped read keyed by scheduleId, tallied in memory.
    const scheduleIds = [...new Set(runBatches.map((b) => b.scheduleId))];
    const usedBySchedule = new Map<string, number>();
    if (scheduleIds.length) {
      const live = await this.prisma.batchAssignmentTicket.findMany({
        where: { removedAt: null, batch: { scheduleId: { in: scheduleIds } } },
        select: { batch: { select: { scheduleId: true } } },
      });
      for (const t of live) {
        const key = t.batch.scheduleId.toString();
        usedBySchedule.set(key, (usedBySchedule.get(key) ?? 0) + 1);
      }
    }

    const batches: DispatchBatchRow[] = runBatches.map((b) => ({
      batchId: b.batchId.toString(),
      scheduleId: b.scheduleId.toString(),
      seId: b.seId,
      seName: b.engineer?.user?.name ?? null,
      plantId: b.plantId.toString(),
      plantName: b.plant.name,
      companyName: distinctLabel(b.tickets.map((t) => t.ticket?.company?.name ?? null)),
      stopSequence: b.stopSequence,
      status: b.status,
      ticketCount: b.tickets.length,
      capacityUsed: { used: usedBySchedule.get(b.scheduleId.toString()) ?? b.tickets.length, cap: capacityOf(b.seId) },
    }));

    const unassignableTraces = await this.prisma.dispatchDecisionTrace.findMany({
      where: { runId, zoneId, seId: null },
      include: {
        ticket: {
          select: { deviceId: true, plantId: true, plant: { select: { name: true } }, company: { select: { name: true } } },
        },
      },
      orderBy: { traceId: 'asc' },
    });
    const unassignable: DispatchUnassignableRow[] = unassignableTraces.map((t) => {
      const trace = t.trace as Record<string, unknown>;
      return {
        ticketId: t.ticketId,
        deviceId: t.ticket?.deviceId ?? null,
        plantId: t.ticket ? t.ticket.plantId.toString() : null,
        plantName: t.ticket?.plant?.name ?? null,
        companyName: t.ticket?.company?.name ?? null,
        poolEmptyReason: (trace.poolEmptyReason as string | null) ?? null,
        dropCounts: (trace.dropCounts as Record<string, number>) ?? {},
      };
    });

    const zoneLive = (await this.liveVsRemovedByZone(runId)).get(zoneRow.zoneId.toString()) ?? {
      stillAssigned: 0,
      removedSince: 0,
    };
    return {
      runId: runId.toString(),
      zone: {
        zoneId: zoneRow.zoneId.toString(),
        zoneName: zoneRow.zone?.name ?? null,
        mode: zoneRow.mode,
        weightSetRef: zoneRow.weightSetRef,
        ticketsConsidered: zoneRow.ticketsConsidered,
        recommended: zoneRow.recommended,
        unassignable: zoneRow.unassignable,
        unassignableReasons: (zoneRow.unassignableReasons as Record<string, unknown> | null) ?? null,
        schedules: zoneRow.schedules,
        batches: zoneRow.batches,
        ticketsDispatched: zoneRow.ticketsDispatched,
        error: zoneRow.error,
        outcome: zoneRow.status,
        contendedWithRunId: zoneRow.contendedWithRunId?.toString() ?? null,
        seSkips: readSeSkips(zoneRow.seSkips),
        withheldBelowThreshold: zoneRow.withheldBelowThreshold,
        bucketlessDropped: zoneRow.bucketlessDropped,
        componentBlockedWithheld: zoneRow.componentBlockedWithheld,
        ticketsStillAssigned: zoneLive.stillAssigned,
        ticketsRemovedSince: zoneLive.removedSince,
      },
      batches,
      unassignable,
      plantStats,
    };
  }

  /**
   * Fleet device stats for the given plants (device totals + inactive from `device_states`; assigned /
   * unassigned from the plants' tickets by `assignment_state`) — the plant-standing context surfaced on
   * the zone's companies-and-plants overview. One grouped query each; empty in ⇒ empty out.
   */
  private async plantDeviceStats(plantIds: bigint[]): Promise<Record<string, PlantDeviceStats>> {
    if (plantIds.length === 0) return {};
    const ids = Prisma.join(plantIds);
    const devices = await this.prisma.$queryRaw<{ plantId: string; total: number; inactive: number }[]>(Prisma.sql`
      SELECT ds.plant_id::text AS "plantId",
             COUNT(*)::int AS "total",
             COUNT(*) FILTER (WHERE ds.is_inactive)::int AS "inactive"
      FROM device_states ds
      WHERE ds.plant_id IN (${ids})
      GROUP BY ds.plant_id`);
    const assign = await this.prisma.$queryRaw<{ plantId: string; assigned: number; unassigned: number }[]>(Prisma.sql`
      SELECT t.plant_id::text AS "plantId",
             COUNT(*) FILTER (WHERE t.assignment_state = 'FORMALLY_ASSIGNED')::int AS "assigned",
             COUNT(*) FILTER (WHERE t.assignment_state = 'UNASSIGNED')::int AS "unassigned"
      FROM tickets t
      WHERE t.plant_id IN (${ids})
        -- #178 — a finished ticket is neither assigned work nor outstanding work. Without this the
        -- closure fix would simply move it from one column to the other and still report it as work
        -- at the plant. assignment_state answers who holds it, never whether anything is left to do.
        AND t.status NOT IN (${Prisma.join([...RESOLVED_TICKET_STATUSES])})
      GROUP BY t.plant_id`);

    const stats: Record<string, PlantDeviceStats> = {};
    const at = (plantId: string) =>
      (stats[plantId] ??= { totalDevices: 0, inactiveDevices: 0, assignedDevices: 0, unassignedDevices: 0 });
    for (const d of devices) {
      const s = at(d.plantId);
      s.totalDevices = d.total;
      s.inactiveDevices = d.inactive;
    }
    for (const a of assign) {
      const s = at(a.plantId);
      s.assignedDevices = a.assigned;
      s.unassignedDevices = a.unassigned;
    }
    return stats;
  }

  /**
   * A batch addressed by its own id — NOT via its run. Most live batches carry no `run_id` (their
   * schedule predates the ledger, or came from the manual path), and a run-scoped lookup left those
   * unreachable from every drill-down. The run is derived from the schedule and reported for the
   * breadcrumb + trace reads; the ZM clamp hangs off the schedule's zone, which every batch has.
   */
  async getBatchDetail(batchId: bigint, scope: ZmScope): Promise<DispatchBatchDetail | null> {
    const zoneClamp = this.zmZone(scope);
    const batch = await this.prisma.plantBatchAssignment.findFirst({
      where: { batchId, ...(zoneClamp !== null ? { schedule: { zoneId: zoneClamp } } : {}) },
      include: {
        schedule: { select: { scheduleId: true, zoneId: true, runId: true } },
        plant: { select: { name: true } },
        engineer: { select: { user: { select: { name: true } } } },
        tickets: {
          where: { removedAt: null },
          orderBy: { sortOrder: 'asc' },
          include: {
            ticket: {
              select: {
                ticketId: true,
                deviceId: true,
                status: true,
                company: { select: { name: true } },
                vehicle: { select: { vehicleNo: true, transporter: { select: { name: true } } } },
                // AutoPlant device context for the batch table. Rides the ticket's existing `device`
                // relation (a required FK) + its optional hot state row, so this adds no query — the
                // batch is already one bounded read of its own tickets.
                device: {
                  select: {
                    deviceType: true,
                    imsiNo: true,
                    state: { select: { latestGpsDatetime: true, tripCreationDatetime: true } },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!batch) return null;

    // `runId: null` reads as `run_id IS NULL`, which is exactly right: a run-less schedule's
    // recommendations are themselves run-less, so the rank/status still resolve for pre-ledger rows.
    const runId = batch.schedule.runId;
    const ticketIds = batch.tickets.map((t) => t.ticket.ticketId);
    const recs = await this.prisma.recommendation.findMany({
      // #286 — a run can now leave a RETIRED row beside the DISPATCHED one for the same ticket (its
      // own suggestion, superseded before it was consumed). Two rows per ticket would make the
      // last-write-wins map below arbitrary, so the superseded one is skipped: this batch is a record
      // of what was dispatched, not of what was reconsidered.
      where: { runId, ticketId: { in: ticketIds }, status: { notIn: SUPERSEDED_RECOMMENDATION_STATUSES } },
      select: {
        ticketId: true,
        processingRank: true,
        status: true,
        scoreBreakdown: true,
        trace: { select: { traceId: true, trace: true } },
      },
    });
    const recByTicket = new Map(recs.map((r) => [r.ticketId, r]));

    return {
      runId: runId?.toString() ?? null,
      batchId: batch.batchId.toString(),
      scheduleId: batch.schedule.scheduleId.toString(),
      zoneId: batch.schedule.zoneId.toString(),
      seId: batch.seId,
      seName: batch.engineer?.user?.name ?? null,
      plantId: batch.plantId.toString(),
      plantName: batch.plant.name,
      rows: batch.tickets.map((t) => {
        const rec = recByTicket.get(t.ticket.ticketId);
        const breakdown = (rec?.scoreBreakdown ?? null) as Record<string, unknown> | null;
        return {
          ticketId: t.ticket.ticketId,
          deviceId: t.ticket.deviceId,
          companyName: t.ticket.company?.name ?? null,
          vehicleNo: t.ticket.vehicle?.vehicleNo ?? null,
          transporterName: t.ticket.vehicle?.transporter?.name ?? null,
          deviceType: t.ticket.device?.deviceType ?? null,
          imsiNo: t.ticket.device?.imsiNo ?? null,
          latestGpsDatetime: t.ticket.device?.state?.latestGpsDatetime?.toISOString() ?? null,
          tripCreationDatetime: t.ticket.device?.state?.tripCreationDatetime?.toISOString() ?? null,
          plantId: batch.plantId.toString(),
          seId: batch.seId,
          sortOrder: t.sortOrder,
          rank: rec?.processingRank ?? null,
          score: typeof breakdown?.score === 'number' ? (breakdown.score as number) : null,
          scoreDegenerate: rec?.trace ? Boolean((rec.trace.trace as Record<string, unknown>)?.scoreDegenerate) : null,
          recStatus: rec?.status ?? null,
          ticketStatus: t.ticket.status,
          hasTrace: rec?.trace != null,
        };
      }),
    };
  }

  async getTicketTrace(runId: bigint, ticketId: string, scope: ZmScope): Promise<DispatchTicketTrace | null> {
    const zoneClamp = this.zmZone(scope);
    const trace = await this.prisma.dispatchDecisionTrace.findFirst({
      where: { runId, ticketId, ...(zoneClamp !== null ? { zoneId: zoneClamp } : {}) },
      include: {
        recommendation: { select: { scoreBreakdown: true, status: true } },
        ticket: {
          select: {
            deviceId: true,
            plant: { select: { name: true } },
            company: { select: { name: true } },
            vehicle: { select: { vehicleNo: true, transporter: { select: { name: true } } } },
          },
        },
      },
    });
    if (!trace) return null;
    const traceJson = (trace.trace as Record<string, unknown>) ?? {};
    return {
      runId: runId.toString(),
      ticketId: trace.ticketId,
      seId: trace.seId,
      trace: traceJson,
      scoreBreakdown: (trace.recommendation?.scoreBreakdown as Record<string, unknown> | null) ?? null,
      recStatus: trace.recommendation?.status ?? null,
      seNames: await this.resolveSeNames(traceJson),
      identity: {
        deviceId: trace.ticket?.deviceId ?? null,
        vehicleNo: trace.ticket?.vehicle?.vehicleNo ?? null,
        plantName: trace.ticket?.plant?.name ?? null,
        companyName: trace.ticket?.company?.name ?? null,
        transporterName: trace.ticket?.vehicle?.transporter?.name ?? null,
      },
    };
  }

  /** actorUserId → display name for MANUAL-run actors (dedupes; skips CRON/null actors). */
  private async resolveActorNames(ids: (string | null)[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((id): id is string => id != null))];
    if (unique.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { userId: { in: unique } },
      select: { userId: true, name: true },
    });
    return new Map(users.map((u) => [u.userId, u.name]));
  }

  /** Names for every SE the trace references (chosen + runners-up) so the UI shows names, not UUIDs. */
  private async resolveSeNames(traceJson: Record<string, unknown>): Promise<Record<string, string | null>> {
    const seIds = new Set<string>();
    const chosen = traceJson.chosen as { seId?: string } | null;
    if (chosen?.seId) seIds.add(chosen.seId);
    for (const r of (traceJson.runnersUp as { seId?: string }[] | undefined) ?? []) {
      if (r?.seId) seIds.add(r.seId);
    }
    if (seIds.size === 0) return {};
    const engineers = await this.prisma.engineerMaster.findMany({
      where: { engineerId: { in: [...seIds] } },
      select: { engineerId: true, user: { select: { name: true } } },
    });
    return Object.fromEntries(engineers.map((e) => [e.engineerId, e.user?.name ?? null]));
  }

  /** The ZM clamp: non-null zone id when the caller is a ZONAL_MANAGER (mirrors ZmScheduleQueryService). */
  private zmZone(scope: ZmScope): bigint | null {
    return scope.role === 'ZONAL_MANAGER' && scope.zoneId != null ? BigInt(scope.zoneId) : null;
  }
}

function sum<T>(items: T[], f: (t: T) => number): number {
  return items.reduce((n, it) => n + f(it), 0);
}

/**
 * A single label for a set of per-ticket values (e.g. a batch's companies). One distinct value → that
 * value; several → the first with a `+N` suffix; none → null. Keeps batch rows honest when a plant's
 * tickets span more than one company without adding columns.
 */
function distinctLabel(values: (string | null)[]): string | null {
  const distinct = [...new Set(values.filter((v): v is string => v != null))];
  if (distinct.length === 0) return null;
  return distinct.length === 1 ? distinct[0] : `${distinct[0]} +${distinct.length - 1}`;
}

/** Per-SE daily capacity from the run's frozen config snapshot — never today's engineer_master. */
function capacityFromSnapshot(snapshot: unknown): (seId: string) => number | null {
  const capacity =
    snapshot && typeof snapshot === 'object'
      ? ((snapshot as Record<string, unknown>).capacity as Record<string, { dailyCapacity?: number }> | undefined)
      : undefined;
  return (seId) => {
    const cap = capacity?.[seId]?.dailyCapacity;
    return typeof cap === 'number' ? cap : null;
  };
}
