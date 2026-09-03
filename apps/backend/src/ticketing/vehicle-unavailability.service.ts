import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { Prisma } from '../generated/prisma/client';
import { type VehicleUnavailReason } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { REMOVAL_REASONS } from '../scheduling/removal-reason';
import { deferralDateFor } from './deferral';
import { foldAndResumeSlaPause } from './sla-pause';

export interface VuActor {
  userId: string;
  role: string;
  zoneId: number | null;
  actedAsRole?: string | null;
  /**
   * The zone whose ZM duty this write is being made under, when the caller is acting (#340).
   * Attribution, not scope: it names who was covering, never what the caller may touch.
   */
  actingZone?: number | null;
}

export interface FileReportInput {
  ticketId: string;
  seId: string;
  reasonCode: VehicleUnavailReason;
  transporterContacted: boolean;
  /** #171 — the name/number the SE actually used, distinct from the master `Transporter.contactPhone`. */
  transporterName?: string | null;
  transporterContact?: string | null;
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

/**
 * Filing's outcome (#246). Carries the deferral the service derived, so the SE is told what actually
 * happened — "back on the 27th" or "still on today's list" — rather than being shown the date they
 * typed and left to guess whether it had any effect.
 */
export type VuFileOutcome =
  | { result: 'OK'; id: string; deferredUntil: string | null }
  | { result: 'FORBIDDEN' }
  | { result: 'NOT_FOUND' };

/**
 * A decision leg's outcome (#245). Two failures beyond the read/scope pair the other legs share:
 * the report is no longer the live one (someone resumed or superseded it while the manager was
 * looking at it — a business 409, not a missing row), and an override with no reason.
 */
export type VuDecisionOutcome =
  | VuOutcome
  | { result: 'NOT_DECIDABLE'; status: string }
  | { result: 'REASON_REQUIRED' };

/**
 * A manual resume's outcome (#247 AC1). `slaResumed` is the honest half: the manager's action always
 * resolves the report, but it clears the pause only when the pause was *this* report's — so the caller
 * is told which of the two happened rather than being left to assume the clock restarted.
 */
export type VuResumeOutcome =
  | { result: 'OK'; id: string; slaResumed: boolean }
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
  /** The SE's entry, immutable (#245). Never rewritten by a manager decision. */
  proposedFrom: string;
  /** The **authoritative** return date — the one every consumer reads (#245/#246). */
  expectedFrom: string;
  expectedTo: string | null;
  notes: string | null;
  status: string;
  /** `APPROVED` | `OVERRIDDEN` | null while nobody has decided yet (#245). */
  decision: string | null;
  decidedBy: string | null;
  decidedByRole: string | null;
  decidedAt: string | null;
  overrideReason: string | null;
  slaPaused: boolean;
  /** Effective (pausable) SLA elapsed seconds. */
  primarySlaSeconds: number;
  /** True elapsed seconds from the Failure Cycle's opened_at — never pauses (ZM/CSM/OH only). */
  secondarySlaSeconds: number;
  resolvedAt: string | null;
  createdAt: string;
}

/** The SE-readable row (#163 item 6) — identical to {@link VehicleUnavailRow} minus
 *  `secondarySlaSeconds`, which is manager-only by design (PRD §299). */
export type MeVehicleUnavailRow = Omit<VehicleUnavailRow, 'secondarySlaSeconds'>;

const MANAGER_ROLES = ['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD'];

/**
 * How many resolved reports the manager queue carries behind the live ones. A display cap, not a
 * business rule: the reference queue (v2-reference/11) shows RESUMED rows alongside OPEN ones, and
 * without a bound that tail grows without limit for the life of the zone.
 */
const RESOLVED_TAIL = 100;

/** `decided_by` is a UUID column; the older `resolved_by` guard is kept for the same reason. */
const asUuid = (userId: string): string | null => (userId.length === 36 ? userId : null);

/**
 * Vehicle Unavailability Report + dual SLA clocks (Issue 28), and — since #245 — the system of record
 * for the vehicle's return date. Filing pauses the primary SLA on the ticket's Failure Cycle
 * (pause_reason = VEHICLE_UNAVAILABLE) and records the SE's proposed date. The ZM list derives BOTH
 * clocks from the cycle; the secondary (true elapsed) is manager-only.
 *
 * #245 replaced the single mutable date with a proposal/decision pair. `proposed_from` is what the SE
 * reported and never changes; `expected_from` is the authoritative date, which starts equal to the
 * proposal (Q1(a): the SE's date takes effect immediately as a provisional deferral, so review can
 * only *change* the wait, never invent one) and afterwards moves only through {@link approve} or
 * {@link override} — both audited. `confirmDate`, which rewrote the date in place with no audit row
 * and no memory of what the SE said, is gone.
 *
 * A ticket has at most one OPEN report, enforced by a partial unique index. Filing again supersedes
 * the previous one rather than racing it (Decision 16: a new absence is a new report).
 */
@Injectable()
export class VehicleUnavailabilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async fileReport(input: FileReportInput, actor: VuActor, now: Date = new Date()): Promise<VuFileOutcome> {
    const ticket = await this.prisma.ticket.findUnique({ where: { ticketId: input.ticketId } });
    if (!ticket) return { result: 'NOT_FOUND' };
    const isManager = MANAGER_ROLES.includes(actor.role);
    if (!(isManager || actor.userId === input.seId)) return { result: 'FORBIDDEN' };

    const deferred = deferralDateFor(input.expectedFrom, now);
    const write = () =>
      this.prisma.$transaction(async (tx) => {
        // A new absence retires the old account of it (#245 AC1). Superseded rows stay readable —
        // the ticket's history is the reason this is not a delete.
        await tx.vehicleUnavailabilityReport.updateMany({
          where: { ticketId: input.ticketId, status: 'OPEN' },
          data: { status: 'SUPERSEDED' },
        });
        const created = await tx.vehicleUnavailabilityReport.create({
          data: {
            ticketId: input.ticketId,
            failureCycleId: ticket.failureCycleId,
            seId: input.seId,
            reasonCode: input.reasonCode,
            transporterContacted: input.transporterContacted,
            transporterName: input.transporterName ?? null,
            transporterContact: input.transporterContact ?? null,
            // Q1(a) — provisional-authoritative on arrival. The two are equal until a manager decides.
            proposedFrom: input.expectedFrom,
            expectedFrom: input.expectedFrom,
            expectedTo: input.expectedTo ?? null,
            notes: input.notes ?? null,
            gpsLat: input.gpsLat ?? null,
            gpsLng: input.gpsLng ?? null,
          },
        });
        // #246 — the filing ends the attempt window. Until this slice the ticket stayed
        // FORMALLY_ASSIGNED on today's batch and the next run planned it again as if the vehicle were
        // there; the date the SE typed had no consequence anywhere. Same three-write shape as
        // `OverrideService.deferTicket`, system-flavoured: the SE is the remover, and the reason is
        // what makes this countable by #244 as a *reached but unsuccessful* attempt rather than an
        // administrative withdrawal.
        //
        // `updateMany` rather than find-then-update: a ticket has at most one live row, and a ticket
        // with none — shared-pool work, or already recycled — is an ordinary case, not an error.
        await tx.batchAssignmentTicket.updateMany({
          where: { ticketId: input.ticketId, removedAt: null },
          data: { removedAt: now, removedBy: input.seId, removalReason: REMOVAL_REASONS.VEHICLE_UNAVAILABLE },
        });
        await tx.ticket.update({
          where: { ticketId: input.ticketId },
          data: {
            // UNASSIGNED and the deferral are a pair. Without the first nothing can ever re-plan the
            // ticket (the permanent-stranding bug #146 fixed for ZM defers); without the second it is
            // re-planned within the hour, which is the opposite of waiting for a vehicle.
            assignmentState: 'UNASSIGNED',
            deferredUntil: deferred,
          },
        });

        // Pause the primary SLA — but only if the cycle is not already paused. #247's other half:
        // this guard is deliberate and stays. A cycle already waiting on a component is already not
        // running its primary clock, and re-stamping the reason here would both lose the component
        // interval's start and mislabel *why* the ticket is stopped. The report is still recorded in
        // full; the earlier pause reason simply stands, and {@link resumeSla} now mirrors that by
        // refusing to clear a pause this report did not cause.
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
        return { result: 'OK' as const, id: String(created.id), deferredUntil: deferred ? deferred.toISOString() : null };
      });

    try {
      return await write();
    } catch (e) {
      // Two filings for one ticket that interleaved between the supersede and the insert: both saw
      // no live row, both inserted, and the partial unique index rejected the loser. Replaying it is
      // correct — the invariant held, and the later filing is meant to supersede whatever now sits
      // there. One retry only; a second collision is a real problem, not a race.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return write();
      throw e;
    }
  }

  /**
   * The manager queue. Every live report, plus a bounded tail of resolved ones so the queue can show
   * what was resumed (reference 11's RESUMED rows) — superseded reports are deliberately absent:
   * they are history for one ticket, not work, and {@link historyForTicket} is where they belong.
   * A ZONAL_MANAGER sees only their own zone.
   */
  async listForZone(scope: VuScope, now: Date = new Date()): Promise<VehicleUnavailRow[]> {
    const zoneClamp =
      scope.role === 'ZONAL_MANAGER' && scope.zoneId != null
        ? { ticket: { plant: { zoneId: BigInt(scope.zoneId) } } }
        : {};
    const open = await this.findReports({ status: 'OPEN', ...zoneClamp });
    const resolved = await this.findReports({ status: 'RESOLVED', ...zoneClamp }, RESOLVED_TAIL);
    return [...open, ...resolved].map((r) => this.toRow(r, now));
  }

  /** Every report ever filed for a ticket, newest first — the supersession chain (#245 AC1). */
  async historyForTicket(ticketId: string, now: Date = new Date()): Promise<VehicleUnavailRow[]> {
    const reports = await this.findReports({ ticketId });
    return reports.map((r) => this.toRow(r, now));
  }

  /**
   * The same chain, reached from a report the caller can already see, and scoped like every other
   * manager leg — a ZM must not read another zone's history just because they know a report id.
   */
  async historyForReport(
    reportId: string,
    actor: VuActor,
    now: Date = new Date(),
  ): Promise<{ result: 'OK'; rows: VehicleUnavailRow[] } | { result: 'NOT_FOUND' } | { result: 'FORBIDDEN' }> {
    const report = await this.prisma.vehicleUnavailabilityReport.findUnique({ where: { id: BigInt(reportId) } });
    if (!report) return { result: 'NOT_FOUND' };
    if (!(await this.isManagerForTicket(report.ticketId, actor))) return { result: 'FORBIDDEN' };
    return { result: 'OK', rows: await this.historyForTicket(report.ticketId, now) };
  }

  /** #163 item 6 — `GET /api/me/vehicle-unavailability`. The caller's own reports, every status (not
   *  just OPEN, so a resolved report's outcome stays visible) — filing today returns only
   *  `{result, id}`, so the "expected back on [date]" state has no read at all. `secondarySlaSeconds`
   *  (the true, never-pausing elapsed clock) is withheld by design: manager-only per PRD §299, not an
   *  oversight — {@link MeVehicleUnavailRow} has no field for it. */
  async bySe(seId: string, now: Date = new Date()): Promise<MeVehicleUnavailRow[]> {
    const reports = await this.findReports({ seId });
    return reports.map((r) => {
      const { secondarySlaSeconds: _secondarySlaSeconds, ...row } = this.toRow(r, now);
      return row;
    });
  }

  private async findReports(where: Prisma.VehicleUnavailabilityReportWhereInput, take?: number) {
    return this.prisma.vehicleUnavailabilityReport.findMany({
      where,
      include: { ticket: { include: { plant: { select: { name: true } }, failureCycle: true } } },
      orderBy: { createdAt: 'desc' },
      ...(take != null ? { take } : {}),
    });
  }

  private toRow(
    r: Prisma.VehicleUnavailabilityReportGetPayload<{
      include: { ticket: { include: { plant: { select: { name: true } }; failureCycle: true } } };
    }>,
    now: Date,
  ): VehicleUnavailRow {
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
      proposedFrom: r.proposedFrom.toISOString(),
      expectedFrom: r.expectedFrom.toISOString(),
      expectedTo: r.expectedTo ? r.expectedTo.toISOString() : null,
      notes: r.notes,
      status: r.status,
      decision: r.decision,
      decidedBy: r.decidedBy,
      decidedByRole: r.decidedByRole,
      decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
      overrideReason: r.overrideReason,
      slaPaused: cycle?.slaPaused ?? false,
      primarySlaSeconds: primary,
      secondarySlaSeconds: secondary,
      resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    };
  }

  /**
   * The manager agrees with the SE: the authoritative date becomes (stays) the proposal, and the
   * decision is stamped and audited. Replaces half of the retired `confirmDate` — the half that
   * meant "yes, that date" rather than "no, this one".
   */
  approve(reportId: string, actor: VuActor, now: Date = new Date()): Promise<VuDecisionOutcome> {
    return this.decide(reportId, 'APPROVED', null, null, actor, now);
  }

  /**
   * The manager replaces the SE's date. The reason is required and stored: an override is the one
   * action that overrules what the person standing at the plant reported, so "why" is the whole
   * accountability record (Q2(a) — there is no role rank to appeal to).
   */
  override(
    reportId: string,
    input: { expectedFrom: Date; reason: string },
    actor: VuActor,
    now: Date = new Date(),
  ): Promise<VuDecisionOutcome> {
    if (!input.reason || input.reason.trim() === '') return Promise.resolve({ result: 'REASON_REQUIRED' });
    return this.decide(reportId, 'OVERRIDDEN', input.expectedFrom, input.reason.trim(), actor, now);
  }

  /**
   * The one writer of the decision columns and of `expected_from` after creation. Last valid in-scope
   * action wins outright (Q2(a)): the columns are overwritten, not appended to, because the row
   * answers "what is the return date and who last said so" — the sequence of everyone who ever said
   * anything is what `audit_logs` is for, and it is written in the same transaction as the change.
   */
  private async decide(
    reportId: string,
    decision: 'APPROVED' | 'OVERRIDDEN',
    expectedFrom: Date | null,
    overrideReason: string | null,
    actor: VuActor,
    now: Date,
  ): Promise<VuDecisionOutcome> {
    const report = await this.prisma.vehicleUnavailabilityReport.findUnique({ where: { id: BigInt(reportId) } });
    if (!report) return { result: 'NOT_FOUND' };
    if (!(await this.isManagerForTicket(report.ticketId, actor))) return { result: 'FORBIDDEN' };
    // Deciding a report that has been resumed or superseded would move a date nothing reads any
    // more, while looking to the manager like it took effect.
    if (report.status !== 'OPEN') return { result: 'NOT_DECIDABLE', status: report.status };

    const authoritative = decision === 'APPROVED' ? report.proposedFrom : expectedFrom!;

    await this.audit.withAudit(
      {
        actorId: actor.userId,
        actorRole: actor.role,
        actedAsRole: actor.actedAsRole ?? null,
        // #340 — the zone the caller was **acting** in, not the zone they belong to. `actor.zoneId`
        // was written here, which put every ordinary manager's VU decision into the CSM-backup-share
        // report's denominator under their own home zone: the same column overload bulk unassign had,
        // and the reason the report's number was never trustworthy. A non-acting decision now leaves
        // it null, which is what the column means.
        actingZone: actor.actingZone ?? null,
        action: decision === 'APPROVED' ? 'VU_DATE_APPROVED' : 'VU_DATE_OVERRIDDEN',
        entityType: 'vehicle_unavailability_reports',
        entityId: reportId,
        metadata: {
          ticketId: report.ticketId,
          proposedFrom: report.proposedFrom.toISOString(),
          previousExpectedFrom: report.expectedFrom.toISOString(),
          expectedFrom: authoritative.toISOString(),
          overrideReason,
          previousDecision: report.decision,
          previousDecidedBy: report.decidedBy,
        },
      },
      async (tx) => {
        await tx.vehicleUnavailabilityReport.update({
          where: { id: BigInt(reportId) },
          data: {
            expectedFrom: authoritative,
            decision,
            decidedBy: asUuid(actor.userId),
            decidedByRole: actor.role,
            decidedAt: now,
            overrideReason,
          },
        });
        // #246 AC4 — the wait is derived, not stored twice, so it is re-derived here in the same
        // transaction. This can clear the deferral outright: a manager moving the date back onto today
        // means the vehicle is back, and a stale future date would strand the ticket for days after
        // the person with the authority to say so has said it.
        await tx.ticket.update({
          where: { ticketId: report.ticketId },
          data: { deferredUntil: deferralDateFor(authoritative, now) },
        });
      },
    );
    return { result: 'OK', id: reportId };
  }

  /**
   * ZM manually resumes the primary SLA and resolves the report — the manual path, and since #247 the
   * only one that resolves a report at all (the auto-resume sweep deliberately leaves it OPEN).
   *
   * **It resumes only a pause it owns.** The guard used to be `slaPaused && slaPausedAt`, which is true
   * of a cycle waiting for a *component* just as much as one waiting for a vehicle — so resolving a
   * vehicle report on a component-paused cycle restarted the primary clock on a ticket nobody could
   * work, silently and with no trace but the missing pause. The asymmetry is what hid it: `fileReport`
   * refuses to re-pause an already-paused cycle (`!cycle.slaPaused`, :189), so the standing reason
   * survives filing and is then cleared by the resume, and which pause you end up with depends only on
   * the order the two events happened in.
   *
   * The report still resolves either way — the manager did act on it, and leaving it open would put the
   * queue permanently at odds with what the manager just did. `slaResumed` in the outcome is how the
   * caller learns which of the two happened.
   */
  async resumeSla(reportId: string, actor: VuActor, now: Date = new Date()): Promise<VuResumeOutcome> {
    const report = await this.prisma.vehicleUnavailabilityReport.findUnique({ where: { id: BigInt(reportId) } });
    if (!report) return { result: 'NOT_FOUND' };
    if (!(await this.isManagerForTicket(report.ticketId, actor))) return { result: 'FORBIDDEN' };

    let slaResumed = false;
    await this.prisma.$transaction(async (tx) => {
      if (report.failureCycleId) {
        // #271 — routed through the shared helper; still reason-guarded to VEHICLE_UNAVAILABLE (the
        // asymmetry this method's own docstring explains), now also race-safe against a concurrent
        // submission or the nightly sweep resuming the same pause.
        const fold = await foldAndResumeSlaPause(tx, report.failureCycleId, now, {
          onlyReason: 'VEHICLE_UNAVAILABLE',
        });
        slaResumed = fold.resumed;
      }
      await tx.vehicleUnavailabilityReport.update({
        where: { id: BigInt(reportId) },
        data: { status: 'RESOLVED', resolvedBy: asUuid(actor.userId), resolvedByRole: actor.role, resolvedAt: now },
      });
    });
    return { result: 'OK', id: reportId, slaResumed };
  }

  private async isManagerForTicket(ticketId: string, actor: VuActor): Promise<boolean> {
    if (actor.role === 'CENTRAL_SERVICE_MANAGER' || actor.role === 'OPERATIONS_HEAD') return true;
    if (actor.role !== 'ZONAL_MANAGER') return false;
    if (actor.zoneId == null) return true;
    const ticket = await this.prisma.ticket.findUnique({ where: { ticketId }, include: { plant: { select: { zoneId: true } } } });
    return ticket != null && Number(ticket.plant.zoneId) === actor.zoneId;
  }
}
