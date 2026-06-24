/**
 * ON_SITE override-conflict seam (Issue 13a AC#5, LLD §12.4). Reports which of the given tickets an
 * SE currently holds an active ON_SITE / TROUBLESHOOT_STARTED soft state on. `soft_states` lands in
 * Issue 15; until then the default reports no conflict. Issue 15 swaps in a Postgres-backed adapter
 * without changing the override engine.
 */
export interface SoftStateConflictPort {
  activeOnSiteTicketIds(ticketIds: string[]): Promise<Set<string>> | Set<string>;
}

export const SOFT_STATE_CONFLICT = Symbol('SOFT_STATE_CONFLICT');

/** Default until soft_states exists (Issue 15): no active ON_SITE, so overrides never conflict. */
export class NoConflictSoftStatePort implements SoftStateConflictPort {
  activeOnSiteTicketIds(): Set<string> {
    return new Set();
  }
}
