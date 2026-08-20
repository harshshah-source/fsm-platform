import 'dotenv/config';
import { PrismaService } from '../prisma/prisma.service';
import { RESOLVED_TICKET_STATUSES } from '../ticketing/resolved-ticket-status';
import { retireAssignmentOnClosure } from './close-assignment';

/**
 * #178 — backfill for the assignments that terminal closure never ended.
 *
 * **READ-ONLY BY DEFAULT.** Run with no arguments and this tool writes nothing; it measures the
 * population and prints it.
 *
 *   npm run closure-backfill:probe          # measure only — safe, writes nothing
 *   npm run closure-backfill:probe -- --apply   # perform the backfill
 *
 * **Probe before you apply, every time.** The issue recorded 351 such tickets on 2026-07-29. That
 * number is a measurement, not a constant: #241 and #242 have since landed (the nightly straggler
 * sweep now stamps `RESOLVED_AT_CLOSURE` on rows sitting on *stale* schedules), and the closure paths
 * themselves are fixed as of this slice, so the residue can only be historical rows on still-live
 * schedules. Re-measure and compare against what you expect before writing anything.
 *
 * **Why this is safe to apply twice.** The write goes through the same {@link retireAssignmentOnClosure}
 * the live closure paths use, whose `removed_at IS NULL` predicate makes it idempotent: a row already
 * retired — by this tool, by a ZM, or by the nightly sweep — is left exactly as whoever closed it left
 * it, with their actor and their reason intact.
 *
 * **What it does not touch.** Only tickets whose status is terminal. A live ticket's assignment is
 * real work and is never in scope, no matter how old. And because `TICKET_RESOLVED` is not a member of
 * #244's countable allow-list, stamping these rows cannot reclassify any ticket as Special — before the
 * backfill they were live (no reason at all, so not countable); after it they carry an excluded reason.
 */
interface Population {
  liveRowsOnResolvedTickets: number;
  ticketsAffected: number;
  assignedStateOnResolvedTickets: number;
}

async function measure(prisma: PrismaService): Promise<Population> {
  const rows = await prisma.batchAssignmentTicket.findMany({
    where: { removedAt: null, ticket: { status: { in: [...RESOLVED_TICKET_STATUSES] } } },
    select: { ticketId: true },
  });
  const assignedStateOnResolvedTickets = await prisma.ticket.count({
    where: { status: { in: [...RESOLVED_TICKET_STATUSES] }, assignmentState: 'FORMALLY_ASSIGNED' },
  });
  return {
    liveRowsOnResolvedTickets: rows.length,
    ticketsAffected: new Set(rows.map((r) => r.ticketId)).size,
    assignedStateOnResolvedTickets,
  };
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const prisma = new PrismaService();
  await prisma.onModuleInit();
  try {
    const before = await measure(prisma);
    console.log('#178 closure-assignment backfill — BEFORE');
    console.table(before);

    if (!apply) {
      console.log('\nDRY RUN — nothing was written. Re-run with `-- --apply` to perform the backfill.');
      return;
    }

    const ticketIds = (
      await prisma.batchAssignmentTicket.findMany({
        where: { removedAt: null, ticket: { status: { in: [...RESOLVED_TICKET_STATUSES] } } },
        select: { ticketId: true },
      })
    ).map((r) => r.ticketId);

    // Chunked so one statement never carries the whole backlog, and so a failure part-way leaves a
    // consistent prefix rather than an aborted whole. Each chunk is its own transaction.
    const CHUNK = 500;
    let stamped = 0;
    for (let i = 0; i < ticketIds.length; i += CHUNK) {
      const slice = ticketIds.slice(i, i + CHUNK);
      stamped += await prisma.$transaction((tx) => retireAssignmentOnClosure(tx, slice, new Date()));
      console.log(`  … ${Math.min(i + CHUNK, ticketIds.length)}/${ticketIds.length}`);
    }

    const after = await measure(prisma);
    console.log(`\n#178 closure-assignment backfill — APPLIED (${stamped} rows stamped)`);
    console.table(after);
    if (after.liveRowsOnResolvedTickets !== 0 || after.assignedStateOnResolvedTickets !== 0) {
      console.warn(
        '\nWARNING: residue remains. Expected zero on both counts — investigate before re-running,' +
          ' since a non-zero tail means something re-created the rows while this was running.',
      );
    }
  } finally {
    await prisma.onModuleDestroy();
  }
}

void main();
