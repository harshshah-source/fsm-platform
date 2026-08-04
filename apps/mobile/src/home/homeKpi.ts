import type { MeTicketRow } from '@fsm/shared';

export interface HomeKpis {
  started: number;
  completed: number;
  verified: number;
  failed: number;
}

const COMPLETED_STATUSES = new Set(['CLOSED', 'CLOSED_AUTO_RECOVERY']);
const FAILED_STATUSES = new Set(['FAILED_VERIFICATION', 'FAILED_ACTIVATION', 'ESCALATED']);

/**
 * Home's 4-tile KPI strip (docs/ui/mobile/home-dashboard.png). Definitions confirmed by the
 * operator 2026-08-04 (this tile taxonomy has no PRD/enum source — #55's own comment):
 *
 * - STARTED: `workState === 'IN_WORK'` — the SE is actively on this ticket right now.
 * - COMPLETED: `status` is `CLOSED` or `CLOSED_AUTO_RECOVERY`. Deliberately excludes
 *   `CLOSED_NON_OPERATIONAL` (a vehicle written off, not work completed) and INSTALL's
 *   `FITTED`/`ACTIVATED` (a different lifecycle, not folded into this count).
 * - VERIFIED: `CLOSED` **and** `workType === 'TROUBLESHOOT'` — only TROUBLESHOOT tickets go
 *   through the three-phase auto-verification pipeline (CONTEXT: `OPEN -> SUBMITTED ->
 *   VERIFICATION_PENDING -> CLOSED`), so reaching `CLOSED` on that path *is* "passed
 *   verification" by construction of the state machine — no separate verification-run lookup
 *   needed. Deliberately a subset of COMPLETED (same ticket can count in both tiles), not
 *   mid-flight `VERIFICATION_PENDING`.
 * - FAILED: `status` is `FAILED_VERIFICATION`, `FAILED_ACTIVATION`, or `ESCALATED`.
 *
 * Scope: only `assigned: true` rows count (today's day-plan) — a shared-pool ticket is not this
 * SE's work yet and never counts, regardless of its status.
 */
export function computeHomeKpis(rows: MeTicketRow[]): HomeKpis {
  const kpis: HomeKpis = { started: 0, completed: 0, verified: 0, failed: 0 };
  for (const row of rows) {
    if (!row.assigned) continue;
    if (row.workState === 'IN_WORK') kpis.started += 1;
    if (COMPLETED_STATUSES.has(row.status)) kpis.completed += 1;
    if (row.status === 'CLOSED' && row.workType === 'TROUBLESHOOT') kpis.verified += 1;
    if (FAILED_STATUSES.has(row.status)) kpis.failed += 1;
  }
  return kpis;
}
