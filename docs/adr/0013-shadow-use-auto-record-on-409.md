# ADR-0013: Rejected-on-409 SE's Physical Component Use Is Auto-Recorded as Shadow Use

## Status

Accepted

## Context

When two SEs both physically work the same Ticket concurrently, the second submission is rejected with 409 Conflict. The components the second SE used are physically gone from their van. Options evaluated: require the SE to file a manual physical-use claim (friction predicts skipped filings — and a skipped filing reintroduces the inventory leak with worse audit trail), soft-lock at `ON_SITE` (breaks the shared-pool fallback flexibility the system deliberately preserves per ADR-0001 and ADR-0003), or accept the leak (silent component drift breaks Common Kit checks downstream at scale).

## Decision

When a submission is rejected with 409 Conflict, the server inspects the rejected `TROUBLESHOOTING_FORM_SUBMISSION.component_used` rows and writes a parallel `INVENTORY_TRANSACTION` for each component with:
- `status = SHADOW_USE`
- `rejection_reason = DUPLICATE_SUBMISSION`
- Linked to the original Ticket and the rejected `submission_id`.

Components **are** decremented from `SE_VAN_STOCK` — they're physically gone, and pretending otherwise corrupts the next day's Common Kit Hard Filter (ADR-0012).

The mobile app surfaces the rejection with: *"This Ticket was already closed by [SE name]. Your components have been logged for warehouse reconciliation."*

A **Shadow Use Queue** on the Warehouse Manager dashboard collects pending reconciliations. The manager marks each:
- `RECONCILED` — genuine duplicate effort.
- `DISPUTED` — mismatch with winning SE's report, escalates to Zonal Manager.

## Consequences

- `INVENTORY_TRANSACTION.status` enum gains `SHADOW_USE`; the row carries both `ticket_id` and the rejected `submission_id` for forensics.
- `SE_VAN_STOCK` decrements regardless of submission acceptance.
- Per-SE shadow-use frequency is a surfaced metric — repeat patterns (same SE shadow-claiming weekly) trigger Operations Head review for potential fraud or coordination failure.
- Disputed rows flow to the Zonal Manager via the same notification channel as readiness conflicts.
- The 409 conflict response carries `shadow_use_recorded = true` so the mobile app can confirm the SE's parts won't disappear from accounting.
