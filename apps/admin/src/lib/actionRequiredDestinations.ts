/**
 * Where the work behind each Action Required card actually lives — **one map, two readers**.
 *
 * It was written for the Scheduler Console's attention band (`dispatch/console/AttentionBand.tsx`) and
 * extracted here unchanged by **#350**, which needed the same answer on the dashboard's Action Required
 * panel. Two copies would have drifted the first time a route moved, and the two surfaces would then
 * have disagreed about where a manager goes to do the same job.
 *
 * Every path is checked against `AppRoutes.tsx`.
 *
 * **A missing entry is a statement.** `undefined` means *no surface lists these rows yet* — the reader
 * says so out loud rather than inventing a link that lands somewhere plausible and wrong. Nine of nine
 * cards have a destination today; the shape stays because the day a tenth card arrives ahead of its
 * page, the distinction has to exist to be used.
 *
 * **Filters ride in the path, not in a query string the page ignores.** Where a destination page reads
 * its filter from the URL, the entry carries it; where the page IS the filter (`/component-blocked`
 * lists open blocks and nothing else, `/verification` lists the review queue), the bare path is the
 * filtered surface and adding a decorative `?status=` would only imply a control that does not exist.
 * `recovery_stalled` deliberately lands on the unfiltered ticket list: the Ticket List's filters are
 * component state, not URL state, so a `?` there would be read by nobody (noted in Phase 3.2 and still
 * true — see #351, which owns the `/assign` URL preset).
 */
export interface ActionRequiredDestination {
  /** Router path, filter included where the destination reads one. */
  to: string;
  /** The imperative the link renders — what the manager is about to do, not where they are going. */
  verb: string;
}

export const ACTION_REQUIRED_DESTINATIONS: Record<string, ActionRequiredDestination | undefined> = {
  // Batches dispatched today — the Batch Schedule Review board, opened on today's window.
  unreviewed_batches: { to: '/dispatch/today', verb: 'Review today’s dispatch' },
  vehicle_unavailability: { to: '/readiness/vehicle-unavailability', verb: 'Review reports' },
  failed_verification: { to: '/verification', verb: 'Review verifications' },
  waiting_component_overdue: { to: '/component-requests', verb: 'Chase components' },
  recovery_stalled: { to: '/tickets', verb: 'Open tickets' },
  component_blocked: { to: '/component-blocked', verb: 'Open the queue' },
  non_op_awaiting_manager: { to: '/readiness/non-operational', verb: 'Confirm requests' },
  // #350 — renamed from `critical_insertions_awaiting_accept`. CONTEXT §21 retired SE Acceptance, so
  // nothing is "awaiting accept"; these are escalations parked for a manager to place by hand.
  critical_escalations_pending: { to: '/intraday', verb: 'Open the intraday queue' },
  manual_assignment_required: { to: '/assign', verb: 'Assign the work' },
};

/** The destination for a card key, or `undefined` when no surface lists its rows yet. */
export function destinationFor(key: string): ActionRequiredDestination | undefined {
  return ACTION_REQUIRED_DESTINATIONS[key];
}
