import { Injectable } from '@nestjs/common';
import { type PresenceSource, type RootCauseCategory, type SubmissionType } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

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
  | { result: 'NOT_OPEN'; status: string };

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
  constructor(private readonly prisma: PrismaService) {}

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
    if (ticket.status !== 'OPEN') return { result: 'NOT_OPEN', status: ticket.status };

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

      // Ticket OPEN → VERIFICATION_PENDING; cycle OPEN → SUBMITTED.
      await tx.ticket.update({
        where: { ticketId: input.ticketId },
        data: { status: 'VERIFICATION_PENDING', lastStateChangedAt: now },
      });
      await tx.failureCycle.update({
        where: { cycleId: ticket.failureCycleId! },
        data: { state: 'SUBMITTED' },
      });

      // Form submission resolves the SE's active soft states on this ticket (CONTEXT §Soft State).
      await tx.softState.updateMany({
        where: { ticketId: input.ticketId, seId: input.seId, resolvedAt: null },
        data: { resolvedAt: now, resolvedBy: 'SE', resolutionReason: 'FORM_SUBMITTED' },
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
      return created;
    });

    return { result: 'OK', duplicate: false, submission: toView(submission) };
  }
}
