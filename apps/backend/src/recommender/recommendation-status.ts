/**
 * `recommendations.status` is a plain TEXT column, not an enum — so the one place its values are
 * agreed is here, and the vocabulary is small enough to state in full (#286).
 *
 * | Value | Meaning |
 * |---|---|
 * | `SUGGESTED` | live: this ticket is offered to this SE and nothing has consumed it. **At most one per ticket**, by the partial unique `recommendations_one_suggested_per_ticket`. |
 * | `DISPATCHED` | consumed: the dispatch transaction placed it on a Day Plan. |
 * | `UNASSIGNABLE` | the engine considered the ticket and could place it nowhere (`seId` null, with a `poolEmptyReason` on the trace). |
 * | `RETIRED` | superseded: it was live when the run owning it stopped being live, so it was cleared to let the next run re-evaluate the ticket. |
 *
 * `RETIRED` exists because the alternative was DELETE, and `dispatch_decision_traces` cascades on
 * delete — so clearing a crashed run's leftovers destroyed the record of what that run intended. A
 * retired row is inert everywhere a live one is read (every reader names `SUGGESTED` explicitly) and
 * frees the partial unique identically, because that index is `WHERE status = 'SUGGESTED'`.
 */
export const RETIRED_RECOMMENDATION_STATUS = 'RETIRED';

/**
 * The statuses a "latest reasoning for this ticket" read must skip.
 *
 * Retiring rather than deleting changed what `ORDER BY recommendation_id DESC LIMIT 1` returns: a
 * retired row is newer than the DISPATCHED row that actually explains the ticket's placement, so a
 * naive latest-wins read would start answering "why is this here?" with the reasoning of a run that
 * placed nothing. Excluding it restores exactly the answer those readers gave when the row was deleted.
 */
export const SUPERSEDED_RECOMMENDATION_STATUSES = [RETIRED_RECOMMENDATION_STATUS];
