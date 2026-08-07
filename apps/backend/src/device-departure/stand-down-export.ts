import { resolve } from 'node:path';
import type { PrismaService } from '../prisma/prisma.service';
import { TERMINAL_TICKET_STATUSES } from './device-departure.service';

/**
 * Issue 218c — the live-batch stand-down list.
 *
 * When the catch-up window departs a device it force-closes every open ticket that device holds
 * (`openDepartures`), but it does **not** touch the ticket's batch assignment. A ticket sitting on a
 * live batch (`removed_at IS NULL`) is therefore work an engineer still has on a day plan, backed by
 * a ticket that is about to disappear. Measured at Gate 3: **1,461** for the SOURCE_STATUS cohort,
 * plus the absence cohort. This produces the flat file dispatch stands those visits down from —
 * `ticket_id, device_id, vehicle_no, plant, batch_id`, no grouping by engineer or day (§9, settled).
 *
 * **Fidelity is the whole point.** The ticket predicate is not respelled here: it imports
 * {@link TERMINAL_TICKET_STATUSES} from the departure service, so the exported set is by construction
 * the set the window closes. Only the live-batch join narrows it.
 */
export interface StandDownRow {
  ticketId: string;
  deviceId: string;
  /** Vehicle the device is currently fitted to; blank when FSM holds no fitment. */
  vehicleNo: string;
  plant: string;
  /** BigInt rendered as a string — this goes to CSV, and JSON/Number would lose or mangle it. */
  batchId: string;
}

/**
 * One row per (ticket, live batch assignment) pair for the given departing devices. A ticket on two
 * live batches yields two rows on purpose: dispatch needs every batch the visit appears on.
 */
export async function buildStandDownRows(prisma: PrismaService, deviceIds: string[]): Promise<StandDownRow[]> {
  if (deviceIds.length === 0) return [];

  const assignments = await prisma.batchAssignmentTicket.findMany({
    where: {
      removedAt: null,
      ticket: { deviceId: { in: deviceIds }, status: { notIn: TERMINAL_TICKET_STATUSES } },
    },
    select: {
      batchId: true,
      ticket: {
        select: {
          ticketId: true,
          deviceId: true,
          vehicle: { select: { vehicleNo: true } },
          plant: { select: { name: true } },
        },
      },
    },
  });

  return assignments.map((a) => ({
    ticketId: a.ticket.ticketId,
    deviceId: a.ticket.deviceId,
    vehicleNo: a.ticket.vehicle?.vehicleNo ?? '',
    plant: a.ticket.plant.name,
    batchId: a.batchId.toString(),
  }));
}

/** Column order is the operator's agreed contract (§9): ticket_id, device_id, vehicle_no, plant, batch_id. */
const STAND_DOWN_HEADER = 'ticket_id,device_id,vehicle_no,plant,batch_id';

/** RFC-4180 field escaping. Plant names legitimately carry commas ("Satna, MP"), and an unquoted one
 * silently shifts every later column — on a file dispatch reads to cancel visits. */
function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Serialise to CSV. The header is always emitted — an empty file and a file that was never written
 * look identical, and "no visits to stand down" is a result the operator needs to be able to see. */
export function toStandDownCsv(rows: readonly StandDownRow[]): string {
  return [
    STAND_DOWN_HEADER,
    ...rows.map((r) => [r.ticketId, r.deviceId, r.vehicleNo, r.plant, r.batchId].map(csvField).join(',')),
  ].join('\n');
}

/**
 * `--export-standdown <path>` for the dry-run CLI, absent unless the operator asks for it. Lives here
 * rather than in the CLI file so it is reachable by a test: importing the CLI module would execute it.
 * Throws rather than defaulting — a missing path must not become a file named `--verbose`, and the
 * dry-run must not complete a ~26k-row source read before reporting a typo.
 */
export function readStandDownPathArg(argv: readonly string[]): string | null {
  const i = argv.indexOf('--export-standdown');
  if (i === -1) return null;
  const path = argv[i + 1];
  if (path === undefined || path.startsWith('--')) {
    throw new Error('--export-standdown requires a file path, e.g. --export-standdown standdown.csv');
  }
  return resolve(path);
}
