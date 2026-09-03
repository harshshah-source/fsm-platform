/**
 * #295 — **what the dispatcher needs to know about one card, in one word.**
 *
 * Three states, derived at read time and never stored — the same posture as `deriveActivityStatus`
 * (ADR-0023, `soft-state/activity-status.ts`), and for the same reason: a stored copy of a
 * time-dependent verdict is wrong the moment the clock moves past it. That module is the *engineer's*
 * label (`BUSY` when they hold any TROUBLESHOOT_STARTED) and cannot answer a per-ticket question, so
 * this is a sibling rather than a reuse.
 *
 * ## The two clocks, and why they must not be collapsed
 *
 * The card shows `Inactive 40h` — that is `device_states.inactivity_hours`, how long the *device*
 * has been silent. It is the reason the ticket exists. It is **not** the aging signal, and using it
 * as one was the tempting shortcut this module exists to refuse.
 *
 * What turns a card yellow is a different question: *how long has this assignment sat with nobody
 * touching it?* That clock starts at `batch_assignment_tickets.created_at` — the moment the work
 * became somebody's — which is the same window `#244` already treats as an attempt's start. A device
 * silent for 40 hours whose ticket was dispatched ten minutes ago is **red**: the fleet problem is
 * old, the dispatch decision is not, and nobody is owed a nudge yet.
 *
 * Reusing `se_assignment_threshold_hours` here would have been the closest-looking fit and is the
 * same mistake wearing a settings key: its clock is device silence, which starts long before the
 * ticket was assigned, so on the shipped default nearly every red would have been yellow the instant
 * it landed. `inactivity_threshold_hours` is worse still — it is a *measurement* definition that sets
 * `is_inactive` and the Fleet-Uptime denominator (`settings/assignment-threshold.ts` says so in as
 * many words), and moving it for a dispatch colour would restate every historical KPI.
 */
export type TicketActionStatus = 'IN_PROGRESS' | 'NOT_STARTED' | 'AGING_UNTOUCHED';

export interface TicketActionStatusInputs {
  /**
   * An **unresolved `TROUBLESHOOT_STARTED`** soft state exists for this ticket. Not `ON_SITE` — an
   * engineer standing at the plant who has not started work is not work in progress — and above all
   * not "it has been assigned", which is the one equation this whole field exists to break.
   */
  troubleshootingStarted: boolean;
  /** Hours since `batch_assignment_tickets.created_at`. See this module's docblock on which clock. */
  hoursSinceAssignment: number;
  /** The operator's threshold, published on the payload beside the status so no client re-derives it. */
  agingThresholdHours: number;
}

/**
 * Precedence, in one place: started wins, then aged, then not-aged.
 *
 * `>=` at the boundary, matching `overCapacity`'s `committed >= dailyCapacity` in the same payload —
 * one comparison for "has reached its limit" across the surface, so the operator who learnt the
 * capacity badge has already learnt this.
 */
export function deriveTicketActionStatus(input: TicketActionStatusInputs): TicketActionStatus {
  if (input.troubleshootingStarted) return 'IN_PROGRESS';
  if (input.hoursSinceAssignment >= input.agingThresholdHours) return 'AGING_UNTOUCHED';
  return 'NOT_STARTED';
}

/** Age of an assignment in hours. Negative under clock skew, which `deriveTicketActionStatus` reads
 *  as "not aged" rather than wrapping it into one. */
export function hoursSinceAssignment(assignedAt: Date, now: Date): number {
  return (now.getTime() - assignedAt.getTime()) / 3_600_000;
}
