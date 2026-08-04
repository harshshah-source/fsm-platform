import type { MeTicketRow } from '@fsm/shared';

let previousAssignedRows: Map<string, MeTicketRow> | null = null;
let removedRowsThisSession: MeTicketRow[] = [];

export interface PlanCues {
  addedIds: Set<string>;
  removedRows: MeTicketRow[];
}

/**
 * #66 (Option A, adopted 2026-07-28, `docs/status/...` Issue-31-AC#5 decision) — client-side
 * set-diff against the previous fetch's assigned-ticket set, since the server has no "added/removed
 * since" signal (`GET /api/schedules/me` returns only live rows; `/api/intraday-updates` is
 * manager-only). In-memory only, resets on cold start — "one session" = until the next cold app
 * open. First-ever call has no prior snapshot, so no cues (nothing to diff against, per the issue's
 * own AC), and `removedRowsThisSession` accumulates across calls within the session rather than only
 * reflecting the most recent diff, so a removed ticket keeps its label through later refreshes too.
 */
export function computePlanCues(current: MeTicketRow[]): PlanCues {
  const currentAssigned = new Map(current.filter((t) => t.assigned).map((t) => [t.ticketId, t] as const));

  if (previousAssignedRows === null) {
    previousAssignedRows = currentAssigned;
    return { addedIds: new Set(), removedRows: [] };
  }

  const addedIds = new Set<string>();
  for (const id of currentAssigned.keys()) {
    if (!previousAssignedRows.has(id)) addedIds.add(id);
  }
  const alreadyFlagged = new Set(removedRowsThisSession.map((r) => r.ticketId));
  for (const [id, row] of previousAssignedRows) {
    if (!currentAssigned.has(id) && !alreadyFlagged.has(id)) {
      removedRowsThisSession = [...removedRowsThisSession, row];
    }
  }

  previousAssignedRows = currentAssigned;
  return { addedIds, removedRows: removedRowsThisSession };
}

/** Test-only reset — the module cache is otherwise cleared solely by a cold app start. */
export function __resetPlanCuesForTests(): void {
  previousAssignedRows = null;
  removedRowsThisSession = [];
}
