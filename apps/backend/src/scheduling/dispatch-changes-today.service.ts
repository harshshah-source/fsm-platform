import { ForbiddenException, Injectable } from '@nestjs/common';
import { istDate, istDayStartInstant } from '../common/ist-day';
import { PrismaService } from '../prisma/prisma.service';
import { ADD_SOURCES } from './add-source';
import { REMOVAL_REASONS } from './removal-reason';
import type { ZmScope } from './zm-schedule-query.service';

export type ChangeKind = 'ADD' | 'REMOVE' | 'SWAP';

export interface DispatchChange {
  kind: ChangeKind;
  ticketId: string;
  /** Who did it. Never null on a returned row — a change with no actor is the engine, not a change. */
  actorId: string;
  /**
   * B7 — who that is, resolved to the name an operator knows.
   *
   * *"Ravi moved it"* is the operator-facing fact; a UUID is not, and the ledger published nothing but
   * the UUID. Null when the id resolves to no user (a system actor, or a deleted account) — the client
   * then falls back to the id rather than inventing a name.
   */
  actorName: string | null;
  at: string;
  reason: string | null;
  /** Where the work went (ADD, SWAP) and where it came from (REMOVE, SWAP). */
  toSeId: string | null;
  fromSeId: string | null;
  /** The door — one of `ADD_SOURCES` / `REMOVAL_REASONS`, whichever leg names this change. */
  via: string | null;
}

export interface DispatchChangesTodayView {
  operatingDay: string;
  zoneId: string;
  counts: { adds: number; removes: number; swaps: number; total: number };
  changes: DispatchChange[];
}

/**
 * What humans did to today's plan after it was dispatched (#284, for the Crew Deck's change ledger).
 *
 * **Why this is a new read rather than the existing Intra-day Queue.** `listIntradayUpdates` selects
 * `audit_logs WHERE action = 'MANUAL_ZM_UPDATE'` — rows written only by `POST /intraday-updates/*`,
 * which no admin code calls. The overrides an operator actually performs go through
 * `POST /batches/:id/override` and audit as `BATCH_OVERRIDE_*`, so the one surface that claims to
 * answer "what changed today" is structurally unable to see the changes the product makes. It is also
 * unbounded: no date filter and no limit, on a page whose empty state reads "yet today".
 *
 * **Why it is now a single-table read.** Before #283 this needed a three-way UNION across a
 * free-shape JSONB column, because the add side of an assignment recorded no actor. With
 * `added_by` / `add_source` / `add_reason` beside the existing `removed_by` / `removal_reason`, both
 * legs of every change live on `batch_assignment_tickets` and the query is one scan of an indexed
 * table.
 *
 * **Swaps count once.** A reassignment writes two rows — the source stamped `REASSIGNED` on removal,
 * the destination stamped `MANUAL_REASSIGN` on add. Reporting those as one add plus one remove would
 * double-count the operator's single decision, so they are paired by ticket within the window and
 * emitted as one `SWAP`.
 */
@Injectable()
export class DispatchChangesTodayService {
  constructor(private readonly prisma: PrismaService) {}

  async changesToday(scope: ZmScope, opts: { zoneId: bigint; now?: Date }): Promise<DispatchChangesTodayView> {
    const now = opts.now ?? new Date();
    const zoneId = opts.zoneId;
    if (scope.role === 'ZONAL_MANAGER' && scope.zoneId != null && BigInt(scope.zoneId) !== zoneId) {
      throw new ForbiddenException({ code: 'ZONE_SCOPE_VIOLATION' });
    }

    // `created_at` / `removed_at` are timestamptz, so the window is the real instant IST midnight
    // occurred — `istDayStartInstant`, not `istDate`, which is the @db.Date form.
    const dayStart = istDayStartInstant(now);
    const dayEnd = new Date(dayStart.getTime() + 86_400_000);
    const inZone = { batch: { schedule: { zoneId } } };

    const [added, removed] = await Promise.all([
      this.prisma.batchAssignmentTicket.findMany({
        // `addedBy: not null` is what separates a human change from the engine's own dispatch: the
        // engine writes `AUTO_DISPATCH` with a null actor by construction (#283), so the morning run
        // placing 200 tickets is not 200 "changes today".
        where: { ...inZone, createdAt: { gte: dayStart, lt: dayEnd }, addedBy: { not: null } },
        orderBy: { createdAt: 'asc' },
        include: { batch: { select: { seId: true } } },
      }),
      this.prisma.batchAssignmentTicket.findMany({
        where: { ...inZone, removedAt: { gte: dayStart, lt: dayEnd }, removedBy: { not: null } },
        orderBy: { removedAt: 'asc' },
        include: { batch: { select: { seId: true } } },
      }),
    ]);

    // Pair the two legs of a move. `REASSIGNED` is the only removal reason that promises a matching
    // add, so nothing else can be mistaken for half of a swap.
    const movedOut = new Map<string, (typeof removed)[number]>();
    for (const r of removed) {
      if (r.removalReason === REMOVAL_REASONS.REASSIGNED) movedOut.set(r.ticketId, r);
    }

    // The row's own autoincrement, carried only for ordering. Two changes written under one frozen
    // clock share an instant to the millisecond, and insertion order is the only thing that still
    // distinguishes "assigned, then moved" from "moved, then assigned".
    const seqOf = new Map<DispatchChange, bigint>();
    const changes: DispatchChange[] = [];
    const pairedTicketIds = new Set<string>();

    for (const a of added) {
      // Only a move's *destination* row pairs with the removal. Keying on the ticket alone was wrong:
      // an operator who assigns a ticket in the morning and moves it after lunch has made two
      // decisions, and the earlier plain assign is an ADD in its own right — it must not be absorbed
      // into the swap that happened later.
      const isMoveDestination =
        a.addSource === ADD_SOURCES.MANUAL_REASSIGN ||
        a.addSource === ADD_SOURCES.MANUAL_SPLIT ||
        // A cross-day move is a move: its two rows are one decision and must count once, exactly as a
        // reassignment's do. Omitting it here would report every day-move as an unexplained removal
        // plus an unexplained add — the double-counting this pairing exists to prevent. `via` still
        // carries `MANUAL_DAY_MOVE`, so a reader can tell which axis the work moved along.
        a.addSource === ADD_SOURCES.MANUAL_DAY_MOVE;
      const source = isMoveDestination ? movedOut.get(a.ticketId) : undefined;
      const change: DispatchChange = source
        ? {
            kind: 'SWAP',
            ticketId: a.ticketId,
            actorId: a.addedBy!,
            actorName: null,
            at: a.createdAt.toISOString(),
            reason: a.addReason ?? null,
            fromSeId: source.batch?.seId ?? null,
            toSeId: a.batch?.seId ?? null,
            via: a.addSource,
          }
        : {
            kind: 'ADD',
            ticketId: a.ticketId,
            actorId: a.addedBy!,
            actorName: null,
            at: a.createdAt.toISOString(),
            reason: a.addReason ?? null,
            fromSeId: null,
            toSeId: a.batch?.seId ?? null,
            via: a.addSource,
          };
      if (source) pairedTicketIds.add(a.ticketId);
      seqOf.set(change, a.id);
      changes.push(change);
    }

    for (const r of removed) {
      if (pairedTicketIds.has(r.ticketId)) continue;
      const change: DispatchChange = {
        kind: 'REMOVE',
        ticketId: r.ticketId,
        actorId: r.removedBy!,
        actorName: null,
        at: r.removedAt!.toISOString(),
        // Was hard-coded `null` while ADD and SWAP carried theirs, so a door that *refuses to commit
        // without a reason* published none. `via` keeps the closed predicate; this keeps the sentence.
        // Still null for a system removal and for pre-`removal_note` history — absence, never a guess.
        reason: r.removalNote ?? null,
        fromSeId: r.batch?.seId ?? null,
        toSeId: null,
        via: r.removalReason,
      };
      seqOf.set(change, r.id);
      changes.push(change);
    }

    changes.sort((x, y) => {
      const byTime = x.at.localeCompare(y.at);
      if (byTime !== 0) return byTime;
      const sx = seqOf.get(x) ?? 0n;
      const sy = seqOf.get(y) ?? 0n;
      return sx < sy ? -1 : sx > sy ? 1 : 0;
    });
    await this.nameActors(changes);

    const counts = {
      adds: changes.filter((c) => c.kind === 'ADD').length,
      removes: changes.filter((c) => c.kind === 'REMOVE').length,
      swaps: changes.filter((c) => c.kind === 'SWAP').length,
      total: changes.length,
    };

    return { operatingDay: istDate(now).toISOString().slice(0, 10), zoneId: String(zoneId), counts, changes };
  }

  /**
   * B7 — resolve the ledger's actor ids to names, in one query for the whole page.
   *
   * The ledger published bare UUIDs, so the change rail could say *"someone moved it"* and nothing
   * more. One `IN` over the distinct ids rather than a join on each leg: the two legs are read
   * separately and paired in memory, so a per-leg include would fetch the same user twice for every
   * swap and still leave the pairing to do the merging.
   *
   * An id that resolves to nothing stays null. That is a real case — a system actor, or a user since
   * removed — and the client renders the id rather than a fabricated name.
   */
  private async nameActors(changes: DispatchChange[]): Promise<void> {
    const ids = [...new Set(changes.map((c) => c.actorId).filter(Boolean))];
    if (ids.length === 0) return;
    const users = await this.prisma.user.findMany({
      where: { userId: { in: ids } },
      select: { userId: true, name: true },
    });
    const nameById = new Map(users.map((u) => [u.userId, u.name]));
    for (const c of changes) c.actorName = nameById.get(c.actorId) ?? null;
  }
}
