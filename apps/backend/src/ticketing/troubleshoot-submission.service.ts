import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { type PresenceSource, type RootCauseCategory, type SubmissionType } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { SeCoverageService } from '../shared-pool/se-coverage.service';
import { foldAndResumeSlaPause } from './sla-pause';

/** A component the SE physically consumed on this visit (Issue 24 inventory ledger). */
export interface ConsumedComponent {
  componentId: bigint;
  qty: number;
}

/**
 * Troubleshooting-form submission (Issue 16, schema D11). The SE's online form submit: structured
 * root cause (the analytics source — free-text is supplementary), the silently-captured SE GPS anchor,
 * and storage-level idempotency on `(se_id, client_submission_id)`. On a fresh submit the Ticket moves
 * OPEN → VERIFICATION_PENDING, the Failure Cycle moves OPEN → SUBMITTED, the SE's active soft states on
 * the ticket resolve (form-submission is their resolution event — CONTEXT §Soft State), and an audit +
 * lifecycle event are written — all in one transaction. A repeat of the same client id is a no-op that
 * returns the already-created record (`duplicate=true`), never a second record or inventory movement.
 *
 * The multi `submission_components` join + expected-component auto-populate land with inventory
 * (Issue 21); here only the scalar component-unavailable signal is captured.
 */
export interface SubmitTroubleshootInput {
  ticketId: string;
  seId: string;
  clientSubmissionId: string;
  rootCauseCategory: RootCauseCategory;
  rootCauseSubcategory?: string | null;
  rootCauseNotes?: string | null;
  actionTakenCategory?: string | null;
  actionTakenNotes?: string | null;
  diagnosisNotes?: string | null;
  componentUnavailable?: boolean;
  componentUnavailableItem?: bigint | null;
  /** Components physically consumed on this visit — recorded in the inventory ledger (Issue 24). */
  consumedComponents?: ConsumedComponent[];
  photoRefs?: string[];
  /** SE GPS captured silently at submission (the Phase-1 verification anchor). */
  seGps?: { lat: number; lon: number };
  presenceSource?: PresenceSource;
  submissionType?: Extract<SubmissionType, 'TROUBLESHOOTING_FORM' | 'COMPONENT_RESUBMIT'>;
  actor: { userId: string; role: string };
  now?: Date;
}

export interface SubmissionView {
  submissionId: string;
  ticketId: string;
  seId: string;
  clientSubmissionId: string;
  rootCauseCategory: RootCauseCategory;
  componentUnavailable: boolean;
  presenceSource: PresenceSource;
  seGpsLat: number | null;
  seGpsLon: number | null;
  submittedAt: Date;
}

export type SubmitOutcome =
  | { result: 'OK'; duplicate: false; submission: SubmissionView }
  | { result: 'DUPLICATE'; duplicate: true; submission: SubmissionView }
  | { result: 'NOT_FOUND' }
  | {
      // Business 409 (CONTEXT §Business 409 Conflict): the Ticket is no longer actionable because
      // another SE's submission already won (or auto-recovery closed it). Distinct from a DUPLICATE.
      result: 'CONFLICT';
      status: string;
      conflict: { winnerSeId: string | null; winnerSeName: string | null; winnerAt: string | null };
      shadowUseRecorded: boolean;
    };

function toView(row: {
  submissionId: string;
  ticketId: string;
  seId: string;
  clientSubmissionId: string;
  rootCauseCategory: RootCauseCategory;
  componentUnavailable: boolean;
  presenceSource: PresenceSource;
  seGpsLat: number | null;
  seGpsLon: number | null;
  submittedAt: Date;
}): SubmissionView {
  return {
    submissionId: row.submissionId,
    ticketId: row.ticketId,
    seId: row.seId,
    clientSubmissionId: row.clientSubmissionId,
    rootCauseCategory: row.rootCauseCategory,
    componentUnavailable: row.componentUnavailable,
    presenceSource: row.presenceSource,
    seGpsLat: row.seGpsLat,
    seGpsLon: row.seGpsLon,
    submittedAt: row.submittedAt,
  };
}

@Injectable()
export class TroubleshootSubmissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly coverage: SeCoverageService,
  ) {}

  async submit(input: SubmitTroubleshootInput): Promise<SubmitOutcome> {
    const now = input.now ?? new Date();

    // Idempotency: a retry of the same draft returns the already-created record, untouched.
    const existing = await this.prisma.troubleshootingSubmission.findUnique({
      where: { seId_clientSubmissionId: { seId: input.seId, clientSubmissionId: input.clientSubmissionId } },
    });
    if (existing) return { result: 'DUPLICATE', duplicate: true, submission: toView(existing) };

    const ticket = await this.prisma.ticket.findUnique({ where: { ticketId: input.ticketId } });
    if (!ticket || ticket.workType !== 'TROUBLESHOOT' || !ticket.failureCycleId) {
      return { result: 'NOT_FOUND' };
    }
    // #162 coverage floor: assignment is not required (the Business-409/Shadow-Use model sanctions
    // covered-plant races), but the ticket's plant must be in the SE's coverage. Checked ahead of the
    // status branch so an out-of-coverage SE never learns a closed ticket's winner/conflict details.
    if (!(await this.coverage.isPlantCovered(input.seId, ticket.plantId))) {
      return { result: 'NOT_FOUND' };
    }
    if (ticket.status !== 'OPEN') return this.handleConflict(ticket.status, input);

    const presenceSource: PresenceSource = input.presenceSource ?? (input.seGps ? 'FORM_GPS' : 'NONE');

    const submission = await this.prisma.$transaction(async (tx) => {
      const created = await tx.troubleshootingSubmission.create({
        data: {
          ticketId: input.ticketId,
          failureCycleId: ticket.failureCycleId!,
          submissionType: input.submissionType ?? 'TROUBLESHOOTING_FORM',
          clientSubmissionId: input.clientSubmissionId,
          seId: input.seId,
          seGpsLat: input.seGps?.lat ?? null,
          seGpsLon: input.seGps?.lon ?? null,
          presenceSource,
          componentUnavailable: input.componentUnavailable ?? false,
          componentUnavailableItem: input.componentUnavailableItem ?? null,
          rootCauseCategory: input.rootCauseCategory,
          rootCauseSubcategory: input.rootCauseSubcategory ?? null,
          rootCauseNotes: input.rootCauseNotes ?? null,
          actionTakenCategory: input.actionTakenCategory ?? null,
          actionTakenNotes: input.actionTakenNotes ?? null,
          diagnosisNotes: input.diagnosisNotes ?? null,
          photoRefs: input.photoRefs ?? [],
          submittedAt: now,
        },
      });

      // Form submission resolves the SE's active soft states on this ticket (CONTEXT §Soft State) —
      // the resolution event is the same whether or not a component was available.
      await tx.softState.updateMany({
        where: { ticketId: input.ticketId, seId: input.seId, resolvedAt: null },
        data: { resolvedAt: now, resolvedBy: 'SE', resolutionReason: 'FORM_SUBMITTED' },
      });

      // …and it ends the vehicle's absence (#245 AC5, Decision 16). Someone worked the vehicle, so a
      // report still saying "expect it back on <date>" is now describing a wait that has been
      // overtaken by events — and #246 is about to read that date to defer real dispatch. Applies to
      // the component-unavailable path too: the SE reached the vehicle either way.
      await tx.vehicleUnavailabilityReport.updateMany({
        where: { ticketId: input.ticketId, status: 'OPEN' },
        data: {
          status: 'RESOLVED',
          resolvedBy: input.seId.length === 36 ? input.seId : null,
          resolvedByRole: input.actor.role,
          resolvedAt: now,
        },
      });

      // #271 (Q7 Case 2) — the ticket is still active here (VERIFICATION_PENDING is not terminal, and
      // neither is staying OPEN for the component-unavailable branch below), so this is the boundary
      // that owns resuming a running VEHICLE_UNAVAILABLE pause, not the 03:30 sweep: submission just
      // resolved the report above, so the sweep's `status: 'OPEN'` selection can no longer see it
      // (#253's dead scenario). Deliberately BEFORE the `componentUnavailable` branch below — item 2's
      // "fold before re-pausing" — so a component-unavailable submission still gets full credit for the
      // VU interval instead of it being silently overwritten by the WAITING_COMPONENT pause that opens
      // next (the accounting bug this issue found and closes). Reason-guarded to VEHICLE_UNAVAILABLE:
      // if the cycle is already paused for WAITING_COMPONENT (a resubmit on a still-OPEN ticket), this
      // is not this writer's pause to end (#247 AC1's asymmetry rule, generalised).
      const vuFold = await foldAndResumeSlaPause(tx, ticket.failureCycleId!, now, {
        onlyReason: 'VEHICLE_UNAVAILABLE',
      });
      if (vuFold.resumed) {
        await tx.auditLog.create({
          data: {
            actorId: input.actor.userId,
            actorRole: input.actor.role,
            action: 'VU_SLA_AUTO_RESUMED',
            entityType: 'failure_cycles',
            entityId: ticket.failureCycleId!,
            metadata: {
              ticketId: input.ticketId,
              // Distinguishes this writer from the nightly sweep's SYSTEM-actor rows in the same ledger.
              resumedBy: 'SUBMISSION',
              addedPauseSeconds: vuFold.addedSeconds,
            },
          },
        });
      }

      if (input.componentUnavailable) {
        // Component-unavailable path (ADR-0008, CONTEXT §8): the Ticket stays OPEN, the Failure Cycle
        // enters WAITING_COMPONENT, the primary SLA pauses, and a Component Request routes to the
        // Warehouse Manager. The raise is idempotent through the submission's own idempotency above.
        await tx.ticket.update({
          where: { ticketId: input.ticketId },
          data: { lastStateChangedAt: now },
        });
        await tx.failureCycle.update({
          where: { cycleId: ticket.failureCycleId! },
          data: {
            state: 'WAITING_COMPONENT',
            slaPaused: true,
            slaPauseReason: 'WAITING_COMPONENT',
            slaPausedAt: now,
            slaPauseSource: 'SE_COMPONENT_UNAVAILABLE',
          },
        });
        await tx.componentRequest.create({
          data: {
            ticketId: input.ticketId,
            failureCycleId: ticket.failureCycleId!,
            submissionId: created.submissionId,
            seId: input.seId,
            componentId: input.componentUnavailableItem ?? null,
            status: 'REQUESTED',
          },
        });
        await tx.ticketEvent.create({
          data: {
            ticketId: input.ticketId,
            fromState: ticket.status,
            toState: ticket.status,
            at: now,
            actorId: input.actor.userId,
            actorRole: input.actor.role as never,
            reasonCode: 'COMPONENT_REQUESTED',
          },
        });
        await tx.auditLog.create({
          data: {
            actorId: input.actor.userId,
            actorRole: input.actor.role,
            action: 'COMPONENT_REQUESTED',
            entityType: 'tickets',
            entityId: input.ticketId,
            metadata: {
              submissionId: created.submissionId,
              componentId: input.componentUnavailableItem ? String(input.componentUnavailableItem) : null,
            },
          },
        });
        return created;
      }

      // Normal path: Ticket OPEN → VERIFICATION_PENDING; cycle OPEN → SUBMITTED.
      await tx.ticket.update({
        where: { ticketId: input.ticketId },
        data: { status: 'VERIFICATION_PENDING', lastStateChangedAt: now },
      });
      await tx.failureCycle.update({
        where: { cycleId: ticket.failureCycleId! },
        data: { state: 'SUBMITTED' },
      });

      await tx.ticketEvent.create({
        data: {
          ticketId: input.ticketId,
          fromState: ticket.status,
          toState: 'VERIFICATION_PENDING',
          at: now,
          actorId: input.actor.userId,
          actorRole: input.actor.role as never,
          reasonCode: 'TROUBLESHOOT_SUBMITTED',
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: input.actor.userId,
          actorRole: input.actor.role,
          action: 'TROUBLESHOOT_SUBMITTED',
          entityType: 'tickets',
          entityId: input.ticketId,
          metadata: { submissionId: created.submissionId, rootCauseCategory: input.rootCauseCategory },
        },
      });

      // Consumed components enter the ledger as PRE_VERIFICATION and decrement van stock; they resolve
      // to DEDUCTED / ROLLED_BACK on the verification outcome (Issue 24, slice 3).
      for (const c of input.consumedComponents ?? []) {
        await this.decrementStock(tx, input.seId, c.componentId, c.qty);
        await tx.inventoryTransaction.create({
          data: {
            seId: input.seId,
            componentId: c.componentId,
            qty: c.qty,
            ticketId: input.ticketId,
            submissionId: created.submissionId,
            type: 'TICKET_CONSUMPTION',
            status: 'PRE_VERIFICATION',
          },
        });
      }
      return created;
    });

    return { result: 'OK', duplicate: false, submission: toView(submission) };
  }

  /**
   * Business 409: the Ticket left OPEN because another SE won (or auto-recovery closed it). If the
   * rejected SE physically consumed components, decrement THEIR van stock and log each as SHADOW_USE
   * for warehouse reconciliation (CONTEXT §Shadow Use). Identifies the winning SE for the SE-facing copy.
   */
  private async handleConflict(status: string, input: SubmitTroubleshootInput): Promise<SubmitOutcome> {
    const now = input.now ?? new Date();
    const winner = await this.prisma.troubleshootingSubmission.findFirst({
      where: { ticketId: input.ticketId, seId: { not: input.seId } },
      orderBy: { submittedAt: 'desc' },
      select: { seId: true, submittedAt: true, engineer: { select: { user: { select: { name: true } } } } },
    });

    let shadowUseRecorded = false;
    const consumed = input.consumedComponents ?? [];
    if (consumed.length > 0) {
      await this.prisma.$transaction(async (tx) => {
        for (const c of consumed) {
          await this.decrementStock(tx, input.seId, c.componentId, c.qty);
          await tx.inventoryTransaction.create({
            data: {
              seId: input.seId,
              componentId: c.componentId,
              qty: c.qty,
              ticketId: input.ticketId,
              type: 'TICKET_CONSUMPTION',
              status: 'SHADOW_USE',
              reason: 'BUSINESS_409_SHADOW_USE',
            },
          });
        }
        await tx.auditLog.create({
          data: {
            actorId: input.actor.userId,
            actorRole: input.actor.role,
            action: 'SHADOW_USE_RECORDED',
            entityType: 'tickets',
            entityId: input.ticketId,
            metadata: { winnerSeId: winner?.seId ?? null, components: consumed.length },
          },
        });
      });
      shadowUseRecorded = true;
    }

    return {
      result: 'CONFLICT',
      status,
      conflict: {
        winnerSeId: winner?.seId ?? null,
        winnerSeName: winner?.engineer.user.name ?? null,
        winnerAt: winner ? winner.submittedAt.toISOString() : null,
      },
      shadowUseRecorded,
    };
  }

  /** Decrement an SE's van stock for a consumed component (floored at 0). No-op when untracked. */
  private async decrementStock(tx: Prisma.TransactionClient, seId: string, componentId: bigint, qty: number): Promise<void> {
    const row = await tx.seVanStock.findUnique({ where: { seId_componentId: { seId, componentId } } });
    if (!row) return;
    await tx.seVanStock.update({
      where: { seId_componentId: { seId, componentId } },
      data: { qty: Math.max(0, row.qty - qty) },
    });
  }
}
