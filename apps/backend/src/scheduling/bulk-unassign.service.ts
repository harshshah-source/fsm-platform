import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { buildStampFields } from '../build-info/run-stamp';
import { istDate } from '../common/ist-day';
import { Prisma } from '../generated/prisma/client';
import { NotificationService } from '../notifications/notification.service';
import { PrismaService } from '../prisma/prisma.service';
import { drainProducerRows, queueNotification } from './day-plan-notification-outbox';
import { dispatchZoneLockKey } from './dispatch-zone-lock';
import { signPreviewToken, verifyPreviewToken } from './preview-token';
import { REMOVAL_REASONS } from './removal-reason';
import { liveScheduleFilter } from './schedule-status';
import { SOFT_STATE_CONFLICT, type SoftStateConflictPort } from './soft-state-conflict';
import { liveZoneClaimRunId } from './zone-claim';

export interface ZoneClassCounts {
  eligible: number;
  onSite: number;
  componentBlocked: number;
  closedExcluded: number;
  installRecoveryExcluded: number;
  deferredExcluded: number;
}

export interface PreviewZoneResult {
  zoneId: string;
  zoneName: string;
  counts: ZoneClassCounts;
}

export interface PreviewResult {
  operationId: string;
  previewToken: string;
  targetDate: string;
  zones: PreviewZoneResult[];
}

export interface BulkUnassignRequest {
  scope: 'ZONE' | 'PAN_INDIA';
  zoneId?: bigint;
  reasonCode: string;
  previewToken?: string;
}

export interface BulkUnassignActor {
  userId: string;
  role: string;
}

export interface ExecuteZoneResult {
  zoneId: string;
  zoneName: string;
  skipped: boolean;
  skipReason: string | null;
  ticketsUnassigned: number;
}

export interface ExecuteOutcomeOk {
  result: 'OK';
  operationId: string;
  zones: ExecuteZoneResult[];
}
export type ExecuteOutcome =
  | ExecuteOutcomeOk
  | { result: 'TOKEN_REQUIRED' }
  | { result: 'TOKEN_INVALID' }
  | { result: 'TOKEN_STALE'; freshPreview: PreviewResult };

/** One `BULK_UNASSIGN_ZONE` audit_logs row, read back for the admin page's history list. */
export interface BulkUnassignHistoryRow {
  id: string;
  operationId: string | null;
  actorId: string;
  scope: string;
  zoneId: string;
  zoneName: string | null;
  reasonCode: string | null;
  skipped: boolean;
  skipReason: string | null;
  counts: ZoneClassCounts | null;
  ticketsUnassigned: number;
  createdAt: string;
}

/**
 * The snapshot #179 signs: the counts the operator was shown, so `execute` can tell "you are acting
 * on the figures you saw" from "the world moved under you". The envelope (`iat`/`exp`), the HMAC and
 * the constant-time compare live in the shared module — extracted there by #251 so the scheduler
 * preview could reuse them rather than grow a second copy that drifts.
 */
interface PreviewTokenPayload {
  operationId: string;
  scope: 'ZONE' | 'PAN_INDIA';
  targetDate: string;
  countsByZone: Record<string, ZoneClassCounts>;
}

interface ZoneClassification {
  counts: ZoneClassCounts;
  /** batch_assignment_tickets.id rows to stamp removed_at on (eligible + onSite + componentBlocked). */
  batchTicketRowIds: bigint[];
  ticketIds: string[];
  scheduleIds: bigint[];
  seIdsAffected: string[];
}

/**
 * #179 — OH bulk unassign (zone / Pan-India), mid-day rebalance. See
 * `.scratch/fsm-platform-v1/issues/179-oh-bulk-unassign-rebalance.md` — scope predicate, the six
 * preview/report classes, and every "known accepted cost" are settled there; do not re-derive them.
 */
@Injectable()
export class BulkUnassignService {
  private readonly logger = new Logger(BulkUnassignService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    @Inject(SOFT_STATE_CONFLICT) private readonly conflict: SoftStateConflictPort,
  ) {}

  async preview(req: Pick<BulkUnassignRequest, 'scope' | 'zoneId' | 'reasonCode'>, now: Date = new Date()): Promise<PreviewResult> {
    const targetDate = istDate(now);
    const zoneIds = await this.resolveZoneIds(req.scope, req.zoneId);
    const zones = await this.prisma.zone.findMany({ where: { zoneId: { in: zoneIds } }, orderBy: { zoneId: 'asc' } });

    const results: PreviewZoneResult[] = [];
    const countsByZone: Record<string, ZoneClassCounts> = {};
    for (const zone of zones) {
      const classified = await this.classifyZone(this.prisma, zone.zoneId, targetDate);
      results.push({ zoneId: zone.zoneId.toString(), zoneName: zone.name, counts: classified.counts });
      countsByZone[zone.zoneId.toString()] = classified.counts;
    }

    const operationId = randomUUID();
    const previewToken = signPreviewToken<PreviewTokenPayload>(
      { operationId, scope: req.scope, targetDate: targetDate.toISOString().slice(0, 10), countsByZone },
      now,
    );

    return { operationId, previewToken, targetDate: targetDate.toISOString().slice(0, 10), zones: results };
  }

  /** The admin page's history list — every `BULK_UNASSIGN_ZONE` audit row, newest first. */
  async history(limit = 50): Promise<BulkUnassignHistoryRow[]> {
    const rows = await this.prisma.auditLog.findMany({
      where: { action: 'BULK_UNASSIGN_ZONE' },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    const zoneIds = [...new Set(rows.map((r) => r.actingZone).filter((z): z is bigint => z != null))];
    const zones = await this.prisma.zone.findMany({ where: { zoneId: { in: zoneIds } }, select: { zoneId: true, name: true } });
    const zoneNameById = new Map(zones.map((z) => [z.zoneId.toString(), z.name]));

    return rows.map((r) => {
      const meta = (r.metadata ?? {}) as Record<string, unknown>;
      const counts = (meta.counts as ZoneClassCounts | undefined) ?? null;
      const skipped = meta.skipped === true;
      const zoneId = r.actingZone != null ? r.actingZone.toString() : '';
      return {
        id: r.id.toString(),
        operationId: typeof meta.operationId === 'string' ? meta.operationId : null,
        actorId: r.actorId,
        scope: typeof meta.scope === 'string' ? meta.scope : 'ZONE',
        zoneId,
        zoneName: zoneId ? (zoneNameById.get(zoneId) ?? null) : null,
        reasonCode: typeof meta.reasonCode === 'string' ? meta.reasonCode : null,
        skipped,
        skipReason: typeof meta.skipReason === 'string' ? meta.skipReason : null,
        counts,
        ticketsUnassigned: counts ? counts.eligible + counts.onSite + counts.componentBlocked : 0,
        createdAt: r.createdAt.toISOString(),
      };
    });
  }

  async execute(req: BulkUnassignRequest, actor: BulkUnassignActor, now: Date = new Date()): Promise<ExecuteOutcome> {
    const targetDate = istDate(now);

    // Pan-India requires a preview token (D-gate); a zone-scoped rebalance does not.
    if (req.scope === 'PAN_INDIA' && !req.previewToken) return { result: 'TOKEN_REQUIRED' };

    let operationId: string = randomUUID();
    if (req.previewToken) {
      const decoded = verifyPreviewToken<PreviewTokenPayload>(req.previewToken, now);
      if (!decoded) return { result: 'TOKEN_INVALID' };
      if (await this.tokenIsStale(decoded, targetDate)) {
        const freshPreview = await this.preview({ scope: req.scope, zoneId: req.zoneId, reasonCode: req.reasonCode }, now);
        return { result: 'TOKEN_STALE', freshPreview };
      }
      operationId = decoded.operationId;
    }

    const zoneIds = await this.resolveZoneIds(req.scope, req.zoneId);
    const zones = await this.prisma.zone.findMany({ where: { zoneId: { in: zoneIds } }, orderBy: { zoneId: 'asc' } });

    const zoneResults: ExecuteZoneResult[] = [];
    for (const zone of zones) {
      zoneResults.push(await this.executeZone(zone.zoneId, zone.name, req.scope, targetDate, req.reasonCode, operationId, actor, now));
    }

    return { result: 'OK', operationId, zones: zoneResults };
  }

  /** A token is stale if any zone it priced has drifted from a fresh read of the same classification. */
  private async tokenIsStale(decoded: PreviewTokenPayload, targetDate: Date): Promise<boolean> {
    for (const [zoneIdStr, priced] of Object.entries(decoded.countsByZone)) {
      const fresh = await this.classifyZone(this.prisma, BigInt(zoneIdStr), targetDate);
      if (JSON.stringify(fresh.counts) !== JSON.stringify(priced)) return true;
    }
    return false;
  }

  private async executeZone(
    zoneId: bigint,
    zoneName: string,
    scope: 'ZONE' | 'PAN_INDIA',
    targetDate: Date,
    reasonCode: string,
    operationId: string,
    actor: BulkUnassignActor,
    now: Date,
  ): Promise<ExecuteZoneResult> {
    // #262 — named from `dispatch-zone-lock.ts` rather than hand-spelled here. The two strings agreed
    // by luck; that module exists precisely because two spellings that drift by a character take
    // DIFFERENT locks and contend with nothing, which no test would fail on.
    const lockKey = dispatchZoneLockKey(zoneId);
    const buildFields = buildStampFields();

    // #262 — a live dispatch run OWNS this zone for its whole duration (#259's claim), which is wider
    // than the advisory lock below: that lock is transaction-scoped, and dispatch is now one
    // transaction per SE, so it is released and retaken between engineers. A rebalance landing in one
    // of those gaps would half-rebalance the zone — SE1 dispatched, then unassigned, then SE2
    // dispatched fresh. Skipping a claimed zone is the same answer this already gives for lock
    // contention, decided one level up.
    const claimedBy = await liveZoneClaimRunId(this.prisma, zoneId);
    if (claimedBy !== null) {
      this.logger.log(`bulk unassign for zone ${zoneId} skipped — dispatch run ${claimedBy} holds the zone`);
      await this.recordZoneSkip(zoneId, scope, targetDate, reasonCode, operationId, actor, buildFields, 'DISPATCH_IN_PROGRESS');
      return { zoneId: zoneId.toString(), zoneName, skipped: true, skipReason: 'DISPATCH_IN_PROGRESS', ticketsUnassigned: 0 };
    }

    // Same non-blocking per-zone advisory lock as dispatch (`batch-assignment.service.ts:68-73`) —
    // a concurrently dispatching (or concurrently rebalancing) zone is skipped, never blocked on.
    const outcome = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtext(${lockKey})) AS locked`;
      if (!locked[0]?.locked) return { skipped: true as const };

      const classified = await this.classifyZone(tx, zoneId, targetDate);
      if (classified.ticketIds.length > 0) {
        await tx.batchAssignmentTicket.updateMany({
          where: { id: { in: classified.batchTicketRowIds } },
          data: { removedAt: now, removedBy: actor.userId, removalReason: REMOVAL_REASONS.BULK_UNASSIGNED },
        });
        await tx.ticket.updateMany({
          where: { ticketId: { in: classified.ticketIds } },
          data: { assignmentState: 'UNASSIGNED' },
        });
        await tx.ticketEvent.createMany({
          data: classified.ticketIds.map((ticketId) => ({
            ticketId,
            fromState: 'OPEN',
            toState: 'OPEN',
            actorId: actor.userId,
            actorRole: actor.role as never,
            reasonCode: 'BULK_UNASSIGNED',
            at: now,
          })),
        });
        // D3 — status untouched. Flipping to OVERRIDDEN would drop every live schedule out of the
        // partial unique `work_schedules_one_active_per_se_zone_day` (predicated status='ACTIVE')
        // simultaneously — #155's hole opened fleet-wide in one click. Provenance only.
        await tx.workSchedule.updateMany({
          where: { scheduleId: { in: classified.scheduleIds } },
          data: { lastOverriddenBy: actor.userId, lastOverriddenAt: now },
        });
      }

      // Audit row commits atomically with the mutation it describes — inline here (not
      // AuditService.withAudit) because the metadata is derived from this same transaction's
      // classification result, which withAudit's fixed-entry-before-work signature cannot express.
      await tx.auditLog.create({
        data: {
          actorId: actor.userId,
          actorRole: actor.role,
          actingZone: zoneId,
          action: 'BULK_UNASSIGN_ZONE',
          entityType: 'zones',
          entityId: zoneId.toString(),
          metadata: {
            operationId,
            scope,
            // D1 reversed 2026-07-29 — stated explicitly so a row is interpretable years later:
            // rows written BEFORE the reversal swept today only and carry no `dateScope`.
            dateScope: 'ALL_LIVE',
            targetDate: targetDate.toISOString().slice(0, 10),
            reasonCode,
            counts: classified.counts,
            skippedTicketIds: classified.ticketIds.slice(0, 500),
            ticketCountTotal: classified.ticketIds.length,
            scheduleIds: classified.scheduleIds.map(String),
            buildVersion: buildFields.buildVersion.toString(),
            buildFingerprint: buildFields.buildFingerprint,
          } as unknown as Prisma.InputJsonValue,
        },
      });

      // #338 — the notice commits with the unassign it announces, beside the audit row that already
      // lived in this transaction. One row per affected engineer, which is exactly what the
      // post-commit loop wrote; what changes is that a push can no longer be lost by a crash here,
      // nor take the rest of a Pan-India sweep down with it by throwing.
      const queuedNotices: bigint[] = [];
      for (const seId of classified.seIdsAffected) {
        queuedNotices.push(
          await queueNotification(tx, {
            recipients: [{ userId: seId, role: 'SERVICE_ENGINEER' }],
            type: 'DAY_PLAN_REBALANCED',
            title: 'Your day plan was rebalanced',
            body: 'An Operations Head rebalance updated your assignments. Your day plan will refresh on the next dispatch run.',
            entityType: 'zone',
            entityId: zoneId.toString(),
            metadata: { operationId, reasonCode },
          }),
        );
      }

      return { skipped: false as const, classified, queuedNotices };
    });

    if (outcome.skipped) {
      await this.recordZoneSkip(zoneId, scope, targetDate, reasonCode, operationId, actor, buildFields, 'LOCK_CONTENDED');
      return { zoneId: zoneId.toString(), zoneName, skipped: true, skipReason: 'LOCK_CONTENDED', ticketsUnassigned: 0 };
    }

    // Delivery still happens only AFTER commit (same posture as DayPlanNotifier) — a rolled-back
    // rebalance must never tell an SE their plan changed. The intent is now a committed row (#338),
    // so a failure here is the sweep's retry rather than a notice nobody will ever send.
    await drainProducerRows(this.prisma, { notify: this.notifications }, outcome.queuedNotices, now);

    return {
      zoneId: zoneId.toString(),
      zoneName,
      skipped: false,
      skipReason: null,
      ticketsUnassigned: outcome.classified.ticketIds.length,
    };
  }

  /**
   * Record a zone this operation did not touch, and why (#179; second cause added by #262).
   *
   * A standalone audit row (`AuditService.record`, not `withAudit`) because no mutation happened and
   * there is no transaction to attach to — Pan-India history still has to be legible per zone, and a
   * zone that silently produced nothing is indistinguishable from one with no eligible work.
   *
   * Two causes now, deliberately named apart: `LOCK_CONTENDED` is "somebody held the zone lock at the
   * instant we tried", `DISPATCH_IN_PROGRESS` is "a dispatch run owns this zone right now". They call
   * for different responses — the first is worth retrying immediately, the second means waiting for a
   * run to finish — so collapsing them would cost the operator the distinction.
   */
  private async recordZoneSkip(
    zoneId: bigint,
    scope: 'ZONE' | 'PAN_INDIA',
    targetDate: Date,
    reasonCode: string,
    operationId: string,
    actor: BulkUnassignActor,
    buildFields: { buildVersion: bigint; buildFingerprint: string },
    skipReason: 'LOCK_CONTENDED' | 'DISPATCH_IN_PROGRESS',
  ): Promise<void> {
    await this.audit.record({
      actorId: actor.userId,
      actorRole: actor.role,
      actingZone: Number(zoneId),
      action: 'BULK_UNASSIGN_ZONE',
      entityType: 'zones',
      entityId: zoneId.toString(),
      metadata: {
        operationId,
        scope,
        dateScope: 'ALL_LIVE',
        targetDate: targetDate.toISOString().slice(0, 10),
        reasonCode,
        skipped: true,
        skipReason,
        buildVersion: buildFields.buildVersion.toString(),
        buildFingerprint: buildFields.buildFingerprint,
      } as unknown as Prisma.InputJsonValue,
    });
  }

  private async resolveZoneIds(scope: 'ZONE' | 'PAN_INDIA', zoneId?: bigint): Promise<bigint[]> {
    if (scope === 'ZONE') {
      if (zoneId == null) throw new Error('zoneId is required for scope=ZONE');
      return [zoneId];
    }
    // Active zones = zones with at least one plant — same universe dispatch iterates
    // (`dispatch-run.service.ts:activeZoneIds`).
    const rows = await this.prisma.plant.findMany({ distinct: ['zoneId'], select: { zoneId: true }, orderBy: { zoneId: 'asc' } });
    return rows.map((r) => r.zoneId);
  }

  /**
   * The scope predicate + the six report classes (`179-oh-bulk-unassign-rebalance.md`). Every
   * FORMALLY_ASSIGNED ticket reachable via a live batch row on a live schedule in this zone
   * partitions into: TROUBLESHOOT+OPEN (further split componentBlocked > onSite > eligible, in that
   * precedence — a ticket already resolved its soft states on form submission, `troubleshoot-
   * submission.service.ts:144-149`, so the overlap is normally empty; the precedence just keeps the
   * counts mutually exclusive if it ever isn't), TROUBLESHOOT+not-OPEN (closedExcluded — the #178
   * standing defect), or INSTALL/RECOVERY (installRecoveryExcluded — D-9, installs stay out).
   * `deferredExcluded` is a separate informational count: a deferred ticket is already UNASSIGNED
   * with its batch row already removed, so it is never reachable through this query at all — this
   * tells the OH it exists and will not be touched, structurally.
   *
   * **D1 REVERSED 2026-07-29 (operator): no date predicate.** This originally filtered
   * `dateFrom = targetDate` (today only), deferring the stale-plan backlog to #147. That left work
   * on week-old ACTIVE schedules reading as "assigned" on every surface while nobody worked it —
   * the operator's reason for widening. `liveScheduleFilter()` remains the boundary: COMPLETED and
   * PARTIAL stay out, so widening cannot resurrect finished work. `targetDate` is still the run day
   * and still gates `deferredExcluded` below, which is inherently date-relative.
   */
  private async classifyZone(db: Prisma.TransactionClient, zoneId: bigint, targetDate: Date): Promise<ZoneClassification> {
    const rows = await db.batchAssignmentTicket.findMany({
      where: {
        removedAt: null,
        batch: { schedule: { zoneId, ...liveScheduleFilter() } },
        ticket: { assignmentState: 'FORMALLY_ASSIGNED' },
      },
      select: {
        id: true,
        ticketId: true,
        batch: { select: { scheduleId: true, seId: true } },
        ticket: { select: { workType: true, status: true } },
      },
    });

    const tsOpen = rows.filter((r) => r.ticket.workType === 'TROUBLESHOOT' && r.ticket.status === 'OPEN');
    const closedExcluded = rows.filter((r) => r.ticket.workType === 'TROUBLESHOOT' && r.ticket.status !== 'OPEN');
    const installRecoveryExcluded = rows.filter((r) => r.ticket.workType !== 'TROUBLESHOOT');

    const tsOpenIds = tsOpen.map((r) => r.ticketId);
    const onSiteSet = await this.conflict.activeOnSiteTicketIds(tsOpenIds);
    const componentBlockedSet = await this.componentBlockedTicketIds(db, tsOpenIds);

    let eligible = 0;
    let onSite = 0;
    let componentBlocked = 0;
    for (const r of tsOpen) {
      if (componentBlockedSet.has(r.ticketId)) componentBlocked++;
      else if (onSiteSet.has(r.ticketId)) onSite++;
      else eligible++;
    }

    const deferredExcluded = await db.ticket.count({
      where: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        assignmentState: 'UNASSIGNED',
        deferredUntil: { gte: targetDate },
        plant: { zoneId },
      },
    });

    return {
      counts: {
        eligible,
        onSite,
        componentBlocked,
        closedExcluded: closedExcluded.length,
        installRecoveryExcluded: installRecoveryExcluded.length,
        deferredExcluded,
      },
      batchTicketRowIds: tsOpen.map((r) => r.id),
      ticketIds: tsOpenIds,
      scheduleIds: [...new Set(tsOpen.map((r) => r.batch.scheduleId))],
      seIdsAffected: [...new Set(tsOpen.map((r) => r.batch.seId))],
    };
  }

  private async componentBlockedTicketIds(db: Prisma.TransactionClient, ticketIds: string[]): Promise<Set<string>> {
    if (ticketIds.length === 0) return new Set();
    const rows = await db.ticket.findMany({
      where: { ticketId: { in: ticketIds }, failureCycle: { state: 'WAITING_COMPONENT' } },
      select: { ticketId: true },
    });
    return new Set(rows.map((r) => r.ticketId));
  }
}
