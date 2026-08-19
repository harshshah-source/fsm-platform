import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { REMOVAL_REASONS, type RemovalReason } from '../scheduling/removal-reason';
import { readSpecialAttemptThreshold } from '../settings/special-threshold';

/**
 * #244 — Special-ticket identification, derived from the ledger every time it is asked for.
 *
 * **What Special means.** A ticket that repeatedly entered an SE's active workload, was actually
 * reached in the mobile workflow, and never produced a successful troubleshooting outcome. It is
 * **not** a status, **not** a priority mechanism, and it never touches REPEAT / ESCALATED — those are
 * failure-cycle concepts about the *device*, this is an observation about *attempts*.
 *
 * **Why there is no column.** Special is computed here and stored nowhere (Decision 3, evidence in
 * `docs/audits/four-decisions-final-analysis-2026-08-18.md` §3.2). Identification-first needs no
 * sortable column; a threshold change has to reclassify the whole open book retroactively, which a
 * stored counter could only achieve by a recompute that would itself be the thing that drifted; and a
 * late submission has to *un*-Special a ticket silently — there is no offline queue on mobile, so a
 * lost submit simply arrives on re-send. With no writer there is no drift, no double-count and
 * nothing to undo. If Special ever needs to affect *sorting*, that is a recorded architectural
 * consequence requiring a follow-up (materialisation), not a quiet change here.
 *
 * **The three evidence definitions, each tied to the one artefact that exists for every path:**
 *
 * | Concept | Artefact | Why this one |
 * |---|---|---|
 * | Attempt window | a `batch_assignment_tickets` row | the only thing every assignment path writes — the 05:00 run, intraday accept, `assignTicket`, and the new row a REASSIGN/SPLIT_BATCH opens. `SWAP_SE` re-points the *batch*, so it continues one window; `REORDER` writes no row |
 * | Reached | a `soft_states` row inside the window | earliest signal is the mobile auto-posted `VIEWED`, so it proves the SE **opened the ticket in the app**. It does NOT prove handset delivery, and a server-side assignment alone is therefore not an attempt |
 * | Success | a `troubleshooting_submissions` row | the system's single success writer, already idempotent. The component-unavailable variant writes one too — the SE *did* diagnose the fault |
 *
 * A window is **countable** when it was reached, produced no submission, and ended with
 * `PLAN_EXPIRED` or `VEHICLE_UNAVAILABLE`. Every other reason is an approved exclusion and they all
 * share one justification: somebody *decided* the attempt should end, so it is not evidence the
 * ticket resists repair. A new reason code is therefore excluded by default and must be classified
 * deliberately — which is the safe direction, since the failure mode of a wrong inclusion is a
 * fabricated Special.
 */

/** The two ends that mean "the attempt ran out", as opposed to "somebody ended it". */
export const COUNTABLE_REMOVAL_REASONS: readonly RemovalReason[] = [
  REMOVAL_REASONS.PLAN_EXPIRED,
  REMOVAL_REASONS.VEHICLE_UNAVAILABLE,
];

/**
 * Countable attempts for the ticket aliased `t`, as a scalar subquery.
 *
 * Defined once and used by every surface — the list's badge column, the `special=true` filter, the
 * standalone count and the detail history all evaluate *this* expression, so the queue cannot show a
 * badge the filter disagrees with.
 *
 * Note what is **not** here: any clause excluding live windows. A live row carries no
 * `removal_reason` (#241's table-wide invariant: reason ⟺ closed), so the reason filter already
 * excludes it, and `removed_at` is non-null for every row this can match — which is what makes the
 * `set_at <= removed_at` bound below total rather than needing a null branch.
 */
export const countableAttemptsSql = Prisma.sql`(
  SELECT count(*) FROM batch_assignment_tickets bat
   WHERE bat.ticket_id = t.ticket_id
     AND bat.removal_reason IN (${Prisma.join([...COUNTABLE_REMOVAL_REASONS])})
     AND EXISTS (
       SELECT 1 FROM soft_states s
        WHERE s.ticket_id = bat.ticket_id
          AND s.set_at >= bat.created_at
          AND s.set_at <= bat.removed_at
     )
     AND NOT EXISTS (
       SELECT 1 FROM troubleshooting_submissions ts
        WHERE ts.ticket_id = bat.ticket_id
          AND ts.submitted_at >= bat.created_at
          AND ts.submitted_at <= bat.removed_at
     )
)`;

/** Whether the ticket aliased `t` has ever produced a submission — the outright disqualifier. */
export const hasSubmissionSql = Prisma.sql`
  EXISTS (SELECT 1 FROM troubleshooting_submissions ts WHERE ts.ticket_id = t.ticket_id)`;

/**
 * The Special predicate for the ticket aliased `t`, at a given threshold.
 *
 * `work_type = 'TROUBLESHOOT'` is a **deliberate narrowing beyond the written definition**, recorded
 * because it is a judgement rather than a transcription: Special is defined by the *absence* of a
 * troubleshooting submission, and an INSTALL ticket can never have one, so without this clause every
 * repeatedly-dispatched install is Special by vacuous truth — a different and unapproved concept
 * ("dispatched a lot") wearing the same badge.
 */
export const specialPredicateSql = (threshold: number): Prisma.Sql => Prisma.sql`(
  t.work_type = 'TROUBLESHOOT'
  AND t.status = 'OPEN'
  AND NOT ${hasSubmissionSql}
  AND ${countableAttemptsSql} >= ${threshold}
)`;

/** One ticket's verdict, as the badge and the filter both understand it. */
export interface SpecialVerdict {
  ticketId: string;
  countableAttempts: number;
  hasSubmission: boolean;
  isSpecial: boolean;
}

/** One assignment window, rendered as an account of what happened during it. */
export interface SpecialAttempt {
  /** `batch_assignment_tickets.id` — the window's identity, stable across reads. */
  attemptId: string;
  seId: string | null;
  seName: string | null;
  openedAt: string;
  /** null ⟺ the window is still live, and a live window is in progress rather than judged. */
  closedAt: string | null;
  removalReason: string | null;
  /** A soft state landed inside this window — the SE opened the ticket in the app. */
  reached: boolean;
  /** A submission landed inside this window — the SE diagnosed the fault. */
  submitted: boolean;
  /** reached ∧ not submitted ∧ ended PLAN_EXPIRED / VEHICLE_UNAVAILABLE. */
  countable: boolean;
}

/** The detail view's whole answer: the verdict, the number it was judged against, and the evidence. */
export interface SpecialAttemptHistory {
  ticketId: string;
  /** The live threshold at read time — shown, because the verdict is meaningless without it. */
  threshold: number;
  countableAttempts: number;
  hasSubmission: boolean;
  isSpecial: boolean;
  attempts: SpecialAttempt[];
}

interface VerdictRow {
  ticketId: string;
  countableAttempts: bigint | number;
  hasSubmission: boolean;
  isSpecial: boolean;
}

interface AttemptRow {
  attemptId: bigint;
  seId: string | null;
  seName: string | null;
  openedAt: Date;
  closedAt: Date | null;
  removalReason: string | null;
  reached: boolean;
  submitted: boolean;
  countable: boolean;
}

@Injectable()
export class SpecialTicketQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Verdicts for a set of tickets, in one statement.
   *
   * Batched by contract, not by convenience: the open book is ~12k tickets and a per-ticket loop is
   * what the issue forbids. Callers pass the page they are rendering, so the cost is bounded by the
   * page rather than by the table, and every id asked about comes back — a ticket with no assignment
   * history answers `0 / not special` rather than being silently absent from the map.
   */
  async verdictsFor(ticketIds: string[]): Promise<Map<string, SpecialVerdict>> {
    if (ticketIds.length === 0) return new Map();
    const threshold = await readSpecialAttemptThreshold(this.prisma);

    const rows = await this.prisma.$queryRaw<VerdictRow[]>(Prisma.sql`
      SELECT t.ticket_id::text AS "ticketId",
             ${countableAttemptsSql}::int AS "countableAttempts",
             ${hasSubmissionSql} AS "hasSubmission",
             ${specialPredicateSql(threshold)} AS "isSpecial"
        FROM tickets t
       WHERE t.ticket_id IN (${Prisma.join(ticketIds.map((id) => Prisma.sql`${id}::uuid`))})`);

    return new Map(
      rows.map((r) => [
        r.ticketId,
        {
          ticketId: r.ticketId,
          countableAttempts: Number(r.countableAttempts),
          hasSubmission: r.hasSubmission,
          isSpecial: r.isSpecial,
        },
      ]),
    );
  }

  /**
   * The per-window history behind one ticket's verdict, oldest first, so it reads as the sequence of
   * events it describes. `null` for a ticket that does not exist — distinct from a ticket that exists
   * with no attempts, because the caller 404s on one and renders an empty history for the other.
   *
   * Each window carries the evidence that decided it rather than only the conclusion: a manager
   * looking at a SPECIAL badge has to be able to check the claim, and "reached, no submission, plan
   * expired" is checkable in a way that a bare count is not.
   */
  async attemptsFor(ticketId: string): Promise<SpecialAttemptHistory | null> {
    const verdicts = await this.verdictsFor([ticketId]);
    const verdict = verdicts.get(ticketId);
    if (!verdict) return null;
    const threshold = await readSpecialAttemptThreshold(this.prisma);

    const rows = await this.prisma.$queryRaw<AttemptRow[]>(Prisma.sql`
      SELECT bat.id AS "attemptId",
             pba.se_id::text AS "seId",
             u.name AS "seName",
             bat.created_at AS "openedAt",
             bat.removed_at AS "closedAt",
             bat.removal_reason AS "removalReason",
             EXISTS (
               SELECT 1 FROM soft_states s
                WHERE s.ticket_id = bat.ticket_id
                  AND s.set_at >= bat.created_at
                  AND (bat.removed_at IS NULL OR s.set_at <= bat.removed_at)
             ) AS "reached",
             EXISTS (
               SELECT 1 FROM troubleshooting_submissions ts
                WHERE ts.ticket_id = bat.ticket_id
                  AND ts.submitted_at >= bat.created_at
                  AND (bat.removed_at IS NULL OR ts.submitted_at <= bat.removed_at)
             ) AS "submitted",
             (
               bat.removal_reason IN (${Prisma.join([...COUNTABLE_REMOVAL_REASONS])})
               AND EXISTS (
                 SELECT 1 FROM soft_states s
                  WHERE s.ticket_id = bat.ticket_id
                    AND s.set_at >= bat.created_at AND s.set_at <= bat.removed_at
               )
               AND NOT EXISTS (
                 SELECT 1 FROM troubleshooting_submissions ts
                  WHERE ts.ticket_id = bat.ticket_id
                    AND ts.submitted_at >= bat.created_at AND ts.submitted_at <= bat.removed_at
               )
             ) AS "countable"
        FROM batch_assignment_tickets bat
        JOIN plant_batch_assignments pba ON pba.batch_id = bat.batch_id
        LEFT JOIN users u ON u.user_id = pba.se_id
       WHERE bat.ticket_id = ${ticketId}::uuid
       ORDER BY bat.created_at ASC, bat.id ASC`);

    return {
      ticketId,
      threshold,
      countableAttempts: verdict.countableAttempts,
      hasSubmission: verdict.hasSubmission,
      isSpecial: verdict.isSpecial,
      attempts: rows.map((r) => ({
        attemptId: r.attemptId.toString(),
        seId: r.seId,
        seName: r.seName,
        openedAt: r.openedAt.toISOString(),
        closedAt: r.closedAt ? r.closedAt.toISOString() : null,
        removalReason: r.removalReason,
        reached: r.reached,
        submitted: r.submitted,
        countable: r.countable ?? false,
      })),
    };
  }
}
