# ADR-0015: Role Hierarchy Is Operations Head → Central Service Manager → Zonal Manager; Backup Cascades Up the Chain

## Status

Accepted

## Context

Zonal Managers can be unavailable (leave, illness, network loss). The system needs a defined backup chain. Options evaluated: peer-Zonal-Manager deputy models (Operations-Head-designates, self-nominate, round-robin), and Operations-Head-as-direct-primary-backup. Peer models invent governance that doesn't exist on the ground and create cross-zone deputisation politics. Direct Operations Head backup bypasses Central Service Manager's normal role and turns the Operations Head into a daily approver.

## Decision

Three operational role layers with strict upward cascade:

1. **Zonal Manager unavailable** → **Central Service Manager** acts with full Zonal-Manager authority for that Zone.
2. **Both Zonal Manager and Central Service Manager unavailable** → **Operations Head** acts directly.
3. Operations Head is always the last line.

There are **no peer deputies** among Zonal Managers.

**Activation triggers** (same for each layer):
- Role-holder sets their own planned-leave window in `ROLE_UNAVAILABILITY`.
- A higher role marks them unavailable.
- Heartbeat absence >24h auto-activates with notification to the next layer up.

While activated, all higher-layer actions in the substituted scope carry `acted_by_engineer_id` plus `acted_as_role` (e.g., `CENTRAL_SERVICE_MANAGER` acting in Zonal Manager scope) so every audit row identifies both the actor and the role exercised.

## Consequences

- A new `ROLE_UNAVAILABILITY` table (separate from `SE_AVAILABILITY` — the routing semantics differ: *all of this role's queued actions* re-route, not just Recommender candidate scoring).
- Notifications on activation: down-layer ("you're out") + up-layer ("you're acting in [Scope]").
- Reports surface "% of [Zone] approvals this month performed by Central Service Manager" — a Zone hitting many substitutions is a capacity-planning signal for Operations Head.
- Cross-zone escalations from ADR-0018: routine cross-zone → Central Service Manager; strategic cross-zone or both-layers-unavailable → Operations Head.
- The manager-revert action on auto-approved intra-day insertions (ADR-0007) is exercised by whoever is currently acting in the Zonal Manager scope.
