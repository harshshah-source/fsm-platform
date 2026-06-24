import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { type OnsiteSource, type SoftStateType } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { type ActivityStatus, deriveActivityStatus, resolveShiftEnd } from './activity-status';

/**
 * SE soft-state lifecycle (Issue 15, schema D7). Soft states are field-progress signals on a ticket —
 * never a ticket lifecycle state and never a lock (CONTEXT §Soft State). The chain is
 * VIEWED → ON_SITE → TROUBLESHOOT_STARTED; advancing one step resolves the prior state so a single SE
 * holds at most one active state per ticket (different SEs may overlap — that overlap is the input to
 * the derived SE Activity Status, not a conflict).
 *
 * This slice owns the transition guard (AC#1). Geofence/manual `onsite_source` (AC#2), activity ping
 * (AC#3), VIEWED timeout vs ON_SITE/TROUBLESHOOT_STARTED non-expiry (AC#4), and stale-work warnings
 * (AC#5) layer on in later slices.
 */
const ORDER: SoftStateType[] = ['VIEWED', 'ON_SITE', 'TROUBLESHOOT_STARTED'];
const rank = (t: SoftStateType | null): number => (t === null ? 0 : ORDER.indexOf(t) + 1);

/** Default VIEWED timeout (1.5 h) — overridable by the `viewed_soft_state_timeout_minutes` setting. */
export const DEFAULT_VIEWED_TIMEOUT_MINUTES = 90;
const VIEWED_TIMEOUT_SETTING = 'viewed_soft_state_timeout_minutes';

/** Default stale-work threshold (2 h) for ON_SITE / TROUBLESHOOT_STARTED — overridable per type. */
export const DEFAULT_STALE_WARNING_HOURS = 2;
const ONSITE_STALE_SETTING = 'onsite_stale_warning_hours';
const TS_STALE_SETTING = 'troubleshoot_started_stale_warning_hours';

/** A ZM stale-work attention signal: an active ON_SITE / TROUBLESHOOT_STARTED held past its threshold. */
export interface StaleWorkWarning {
  softStateId: bigint;
  ticketId: string;
  seId: string;
  type: 'ON_SITE' | 'TROUBLESHOOT_STARTED';
  setAt: Date;
  heldHours: number;
  thresholdHours: number;
}

export interface SoftStateView {
  softStateId: bigint;
  ticketId: string;
  seId: string;
  type: SoftStateType;
  onsiteSource: OnsiteSource | null;
  setAt: Date;
  timeoutAt: Date | null;
  resolvedAt: Date | null;
}

export interface AdvanceSoftStateInput {
  ticketId: string;
  seId: string;
  target: SoftStateType;
  onsiteSource?: OnsiteSource;
  now?: Date;
}

/** Default plant geofence radius (metres) — captured points within this of the plant point are AUTO. */
export const DEFAULT_GEOFENCE_RADIUS_M = 200;

export interface SetOnSiteInput {
  ticketId: string;
  seId: string;
  /** Location captured by the deliberate app action; absent = capture failed / location off. */
  capturedLocation?: { lat: number; lng: number };
  actor: { userId: string; role: string };
  now?: Date;
}

export type AdvanceOutcome =
  | { result: 'OK'; softState: SoftStateView }
  | { result: 'IDEMPOTENT'; softState: SoftStateView }
  | { result: 'INVALID_TRANSITION'; from: SoftStateType | null; to: SoftStateType };

function toView(row: {
  softStateId: bigint;
  ticketId: string;
  seId: string;
  type: SoftStateType;
  onsiteSource: OnsiteSource | null;
  setAt: Date;
  timeoutAt: Date | null;
  resolvedAt: Date | null;
}): SoftStateView {
  return {
    softStateId: row.softStateId,
    ticketId: row.ticketId,
    seId: row.seId,
    type: row.type,
    onsiteSource: row.onsiteSource,
    setAt: row.setAt,
    timeoutAt: row.timeoutAt,
    resolvedAt: row.resolvedAt,
  };
}

@Injectable()
export class SoftStateService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Advance the SE's soft state on a ticket to `target`. Valid only as the next step in the chain;
   * re-advancing to the current state is idempotent; anything else is INVALID_TRANSITION. The prior
   * active state (if any) is resolved as part of the same transaction.
   */
  async advance(input: AdvanceSoftStateInput): Promise<AdvanceOutcome> {
    const now = input.now ?? new Date();
    const viewedTimeoutMs = await this.viewedTimeoutMs();
    return this.prisma.$transaction((tx) => this.runAdvance(tx, input, now, viewedTimeoutMs));
  }

  /**
   * Resolve every active VIEWED whose configurable timeout has elapsed (SYSTEM/VIEWED_TIMEOUT). The
   * row is retained (resolved, not deleted) for the audit trail. ON_SITE / TROUBLESHOOT_STARTED carry
   * a NULL `timeout_at` and so are never matched — they never time-expire (CONTEXT §Soft State).
   */
  async clearExpiredViewed(now: Date = new Date()): Promise<number> {
    const res = await this.prisma.softState.updateMany({
      where: { type: 'VIEWED', resolvedAt: null, timeoutAt: { lte: now } },
      data: { resolvedAt: now, resolvedBy: 'SYSTEM', resolutionReason: 'VIEWED_TIMEOUT' },
    });
    return res.count;
  }

  /** Configured VIEWED timeout in ms (Operations-Head setting), falling back to the 1.5 h default. */
  private async viewedTimeoutMs(): Promise<number> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: VIEWED_TIMEOUT_SETTING } });
    const minutes = typeof row?.value === 'number' ? row.value : DEFAULT_VIEWED_TIMEOUT_MINUTES;
    return minutes * 60_000;
  }

  /**
   * Active ON_SITE / TROUBLESHOOT_STARTED soft states held longer than their configured stale-work
   * threshold — the ZM dashboard attention signal (CONTEXT §Soft State). This is a read: it NEVER
   * resolves the state. ON_SITE and TROUBLESHOOT_STARTED have independent thresholds.
   */
  async staleWorkWarnings(now: Date = new Date()): Promise<StaleWorkWarning[]> {
    const onsiteHours = await this.settingHours(ONSITE_STALE_SETTING, DEFAULT_STALE_WARNING_HOURS);
    const tsHours = await this.settingHours(TS_STALE_SETTING, DEFAULT_STALE_WARNING_HOURS);
    const rows = await this.prisma.softState.findMany({
      where: {
        resolvedAt: null,
        OR: [
          { type: 'ON_SITE', setAt: { lte: new Date(now.getTime() - onsiteHours * 3_600_000) } },
          { type: 'TROUBLESHOOT_STARTED', setAt: { lte: new Date(now.getTime() - tsHours * 3_600_000) } },
        ],
      },
      orderBy: { setAt: 'asc' },
    });
    return rows.map((r) => ({
      softStateId: r.softStateId,
      ticketId: r.ticketId,
      seId: r.seId,
      type: r.type as 'ON_SITE' | 'TROUBLESHOOT_STARTED',
      setAt: r.setAt,
      heldHours: (now.getTime() - r.setAt.getTime()) / 3_600_000,
      thresholdHours: r.type === 'ON_SITE' ? onsiteHours : tsHours,
    }));
  }

  /** Reads an hours-valued setting, falling back to a default. */
  private async settingHours(key: string, fallback: number): Promise<number> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key } });
    return typeof row?.value === 'number' ? row.value : fallback;
  }

  /**
   * Derive the SE's render-time Activity Status (ADR-0023) from active soft states + activity ping +
   * shift end. Nothing is stored — every call recomputes. SE_AVAILABILITY sourcing lands with Issue 25;
   * until then availability is treated as AVAILABLE so soft states / heartbeat / shift drive the label.
   */
  async activityStatusFor(seId: string, now: Date = new Date()): Promise<ActivityStatus> {
    const engineer = await this.prisma.engineerMaster.findUniqueOrThrow({ where: { engineerId: seId } });
    const active = await this.prisma.softState.findMany({
      where: { seId, resolvedAt: null },
      select: { type: true },
    });
    return deriveActivityStatus({
      availabilityStatus: 'AVAILABLE',
      activeSoftStateTypes: active.map((a) => a.type),
      lastActivityAt: engineer.lastActivityAt,
      shiftEnd: resolveShiftEnd(engineer.shiftEnd, now),
      now,
    });
  }

  /**
   * Record an SE Activity Ping (ADR-0024): an SE-initiated app action stamps `last_activity_at`. This
   * is visibility/telemetry only — it never gates Recommender scoring and never clears a soft state.
   * Call this only on genuine SE-action code paths; background workers must not ping.
   */
  async recordActivityPing(seId: string, now: Date = new Date()): Promise<void> {
    await this.prisma.engineerMaster.update({
      where: { engineerId: seId },
      data: { lastActivityAt: now },
    });
  }

  /**
   * Set ON_SITE on a ticket the SE is currently VIEWED on, deriving the source: a captured location
   * inside the plant geofence → AUTO_GEOFENCE; otherwise the SE's manual tap → MANUAL, which is
   * audited (CONTEXT §Soft State). Creation and the MANUAL audit row commit together.
   */
  async setOnSite(input: SetOnSiteInput): Promise<AdvanceOutcome> {
    const now = input.now ?? new Date();
    const source = await this.resolveOnsiteSource(input.ticketId, input.capturedLocation);
    return this.prisma.$transaction(async (tx) => {
      const outcome = await this.runAdvance(
        tx,
        { ticketId: input.ticketId, seId: input.seId, target: 'ON_SITE', onsiteSource: source },
        now,
        0, // ON_SITE carries no timeout; the VIEWED-timeout arg is unused here
      );
      if (outcome.result === 'OK' && source === 'MANUAL') {
        await tx.auditLog.create({
          data: {
            actorId: input.actor.userId,
            actorRole: input.actor.role,
            action: 'SOFT_STATE_ONSITE_MANUAL',
            entityType: 'soft_states',
            entityId: String(outcome.softState.softStateId),
            metadata: { ticketId: input.ticketId, seId: input.seId },
          },
        });
      }
      return outcome;
    });
  }

  /** Inside the plant geofence (configurable radius) ⇒ AUTO_GEOFENCE; else (no/failed/outside) MANUAL. */
  private async resolveOnsiteSource(
    ticketId: string,
    capturedLocation?: { lat: number; lng: number },
  ): Promise<OnsiteSource> {
    if (!capturedLocation) return 'MANUAL';
    const rows = await this.prisma.$queryRaw<{ inside: boolean }[]>`
      SELECT ST_DWithin(
        p.location::geography,
        ST_SetSRID(ST_MakePoint(${capturedLocation.lng}, ${capturedLocation.lat}), 4326)::geography,
        ${DEFAULT_GEOFENCE_RADIUS_M}
      ) AS inside
      FROM tickets t JOIN plants p ON p.plant_id = t.plant_id
      WHERE t.ticket_id = ${ticketId}::uuid AND p.location IS NOT NULL`;
    return rows[0]?.inside ? 'AUTO_GEOFENCE' : 'MANUAL';
  }

  /** The transition guard + resolve-prior + create, on a given transaction client. */
  private async runAdvance(
    tx: Prisma.TransactionClient,
    input: AdvanceSoftStateInput,
    now: Date,
    viewedTimeoutMs: number,
  ): Promise<AdvanceOutcome> {
    const current = await tx.softState.findFirst({
      where: { ticketId: input.ticketId, seId: input.seId, resolvedAt: null },
      orderBy: { setAt: 'desc' },
    });
    const from = current?.type ?? null;

    if (from === input.target && current) {
      return { result: 'IDEMPOTENT', softState: toView(current) };
    }
    if (rank(input.target) !== rank(from) + 1) {
      return { result: 'INVALID_TRANSITION', from, to: input.target };
    }

    if (current) {
      await tx.softState.update({
        where: { softStateId: current.softStateId },
        data: { resolvedAt: now, resolvedBy: 'SE', resolutionReason: 'ADVANCED' },
      });
    }
    const created = await tx.softState.create({
      data: {
        ticketId: input.ticketId,
        seId: input.seId,
        type: input.target,
        onsiteSource: input.target === 'ON_SITE' ? (input.onsiteSource ?? null) : null,
        setAt: now,
        timeoutAt: input.target === 'VIEWED' ? new Date(now.getTime() + viewedTimeoutMs) : null,
      },
    });
    // A soft-state transition is an SE-initiated action — stamp the activity ping (ADR-0024).
    await tx.engineerMaster.update({ where: { engineerId: input.seId }, data: { lastActivityAt: now } });
    return { result: 'OK', softState: toView(created) };
  }
}
