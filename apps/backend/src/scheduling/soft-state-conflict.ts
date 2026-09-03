/**
 * ON_SITE override-conflict seam (Issue 13a AC#5, LLD §12.4). Reports which of the given tickets an
 * SE currently holds an active ON_SITE / TROUBLESHOOT_STARTED soft state on. `soft_states` lands in
 * Issue 15; until then the default reports no conflict. Issue 15 swaps in a Postgres-backed adapter
 * without changing the override engine.
 */
export interface SoftStateConflictPort {
  activeOnSiteTicketIds(ticketIds: string[]): Promise<Set<string>> | Set<string>;
  /**
   * #295 — the same table asked a **narrower** question: which of these tickets has an unresolved
   * `TROUBLESHOOT_STARTED`, and nothing else.
   *
   * Deliberately not a parameter on the method above. That one unions ON_SITE with
   * TROUBLESHOOT_STARTED because an override that disturbs an engineer standing at the plant is a
   * conflict either way — the union is its whole point. The dispatch board asks something different:
   * *has somebody actually started the work?* An engineer who has arrived and not begun has not, and
   * a green card claiming otherwise would misinform the dispatcher about the one fact the colour
   * exists to carry. Two questions, two methods — the same rule that keeps `decidedBy` and
   * `deferredBy` apart on `TodayHold`.
   */
  activeTroubleshootStartedTicketIds(ticketIds: string[]): Promise<Set<string>> | Set<string>;
}

export const SOFT_STATE_CONFLICT = Symbol('SOFT_STATE_CONFLICT');

/** Default until soft_states exists (Issue 15): no active ON_SITE, so overrides never conflict.
 *  Also the fallback for callers constructed without the port at all — a board that cannot read
 *  soft states reports nothing started, which renders as untouched rather than as a fabricated green. */
export class NoConflictSoftStatePort implements SoftStateConflictPort {
  activeOnSiteTicketIds(): Set<string> {
    return new Set();
  }

  activeTroubleshootStartedTicketIds(): Set<string> {
    return new Set();
  }
}
