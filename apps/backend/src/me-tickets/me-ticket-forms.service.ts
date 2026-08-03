import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SeCoverageService } from '../shared-pool/se-coverage.service';
import { isTicketReadableBySe } from './se-ticket-access';
import type { TicketFormView } from '../ticketing/ticket-query.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * #161 item 3 — `GET /api/me/tickets/:id/forms`, the SE-readable variant of the manager-only
 * `GET /api/tickets/:id/forms` (`TicketQueryService.formsForTicket`). Scoped to the caller's OWN
 * submissions on the ticket — never another SE's, even when both have submitted on the same ticket.
 *
 * Access gate: the caller sees the (filtered) forms list if EITHER they have at least one submission
 * of their own on this ticket (ownership, regardless of the ticket's *current* coverage/assignment —
 * a zone/plant reassignment must not erase an SE's own past work from their view) OR the ticket is
 * currently readable to them under #161 item 1's rule (`isTicketReadableBySe`) — covering the "I can
 * see this ticket but haven't submitted anything yet" empty-array case. Outside both → `null`, which
 * the controller turns into a 404 (same never-distinguish-unknown-from-out-of-scope convention as
 * item 1).
 */
@Injectable()
export class MeTicketFormsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly coverage: SeCoverageService,
  ) {}

  async getMyForms(seId: string, ticketId: string, now: Date = new Date()): Promise<TicketFormView[] | null> {
    if (!UUID_RE.test(ticketId)) return null;

    const ticket = await this.prisma.ticket.findUnique({
      where: { ticketId },
      select: { ticketId: true, assignedSeId: true, plantId: true, status: true, assignmentState: true, deferredUntil: true },
    });
    if (!ticket) return null;

    const subs = await this.prisma.troubleshootingSubmission.findMany({
      where: { ticketId, seId },
      orderBy: { submittedAt: 'asc' },
    });

    if (subs.length === 0 && !(await isTicketReadableBySe(this.prisma, this.coverage, ticket, seId, now))) {
      return null;
    }

    return subs.map((s) => ({
      submissionId: s.submissionId,
      submissionType: s.submissionType,
      seId: s.seId,
      clientSubmissionId: s.clientSubmissionId,
      rootCauseCategory: s.rootCauseCategory,
      rootCauseSubcategory: s.rootCauseSubcategory,
      rootCauseNotes: s.rootCauseNotes,
      actionTakenCategory: s.actionTakenCategory,
      actionTakenNotes: s.actionTakenNotes,
      diagnosisNotes: s.diagnosisNotes,
      componentUnavailable: s.componentUnavailable,
      componentUnavailableItem: s.componentUnavailableItem != null ? String(s.componentUnavailableItem) : null,
      photoRefs: s.photoRefs,
      presenceSource: s.presenceSource,
      seGpsLat: s.seGpsLat,
      seGpsLon: s.seGpsLon,
      submittedAt: s.submittedAt.toISOString(),
    }));
  }
}
