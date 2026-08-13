import type { MeTicketRow, SlaBucket } from '@fsm/shared';

/**
 * The SLA bands Home calls "urgent" — CRITICAL (24h) and everything above it. Taken from
 * `SLA_BANDS`' own ordering (`@fsm/shared`): the bands at or past the 24-hour bound are the ones the
 * platform escalates on, and 24h is where the naming itself turns from RISK to CRITICAL. Below that
 * a device is inactive but still inside the day it went quiet.
 */
const URGENT_BUCKETS: ReadonlySet<string> = new Set<SlaBucket>([
  'CRITICAL',
  'HIGH_CRITICAL',
  'SEVERE',
  'VERY_SEVERE',
  'LONG_PENDING',
]);

/** Same closure states as the KPI strip's COMPLETED tile (`homeKpi.ts`) — one definition of "done"
 *  for the whole screen, so the tile, the Plant Workload ring and the chart cannot contradict.
 *  `CLOSED_AUTO_RECOVERY` left all three on 2026-08-10 together (#229 D6): a self-healed device is
 *  not work an SE did. */
const DONE_STATUSES: ReadonlySet<string> = new Set(['CLOSED']);

export interface PlantSummary {
  /** Tickets at this plant. Every one is raised against a device that has gone silent, which is what
   *  the reference image's "N inactive" counts. */
  inactive: number;
  /** Of those, the ones whose device is in an urgent SLA band. */
  urgent: number;
  /** Of those, the ones the SE has actually started (`workState === 'IN_WORK'`). */
  inWork: number;
  /** Of those, the ones that reached a completed state. */
  done: number;
  total: number;
}

/**
 * Roll up one plant stop's tickets for Home's Next Visit subline (`4 inactive · 3 urgent · 2 in work`)
 * and its Plant Workload card (`2/4`, `50%`) — one derivation feeding both, so the two cards on the
 * same screen describe the same plant identically.
 *
 * Takes the already-fetched `GET /api/me/tickets` rows filtered to the stop, not a second fetch:
 * everything here is a field the row already carries.
 */
export function summarisePlant(rows: MeTicketRow[]): PlantSummary {
  const summary: PlantSummary = { inactive: rows.length, urgent: 0, inWork: 0, done: 0, total: rows.length };
  for (const row of rows) {
    if (row.slaBucket != null && URGENT_BUCKETS.has(row.slaBucket)) summary.urgent += 1;
    if (row.workState === 'IN_WORK') summary.inWork += 1;
    if (DONE_STATUSES.has(row.status)) summary.done += 1;
  }
  return summary;
}
