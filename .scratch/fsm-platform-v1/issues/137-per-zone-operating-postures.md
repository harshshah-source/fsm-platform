# 137 — Per-zone operating postures (ZM-tunable, OH-bounded) — DEFERRED

Status: deferred
Type: HITL-gated

> **DEFERRED STUB — do not build.** Gated on evidenced operator demand **and** Operations-Head
> sign-off. This is P2 of `docs/proposals/zone-engine-customization-2026-07-21.md` (commit `f0f3dcb`,
> §4 Approach B / §5). Filed so the option is captured, not lost — not so it gets built speculatively.
> Building it without the gate below being met is YAGNI (proposal §5) and this stub says so on purpose.

## The idea (if ever unblocked)

Expose **at most two** recommender-*local* dials to a ZM as named **operational postures** — never raw
numbers, never engine vocabulary:

- **Staffing-pressure sensitivity** — how readily the zone flips into "Catch-up" work (the per-zone
  deficit threshold, `DEFAULT_DEFICIT_THRESHOLD_PCT`, `apps/backend/src/reports/soft-inactive-count.service.ts:9`).
  Choices e.g. *Relaxed / Balanced / Sensitive*.
- **Group nearby jobs** — how strongly an SE's day clusters at the same plant (the Plant Cluster
  Multiplier, `apps/backend/src/recommender/recommender.service.ts:522-526`). Choices e.g.
  *Off / Normal / Strong*.

Both are recommender-local: they change only how *this zone's* recommender orders *this zone's* SEs on
*this zone's* run. Neither feeds a cross-zone KPI denominator nor a business tier (proposal §3.2–§3.3).

## Why it is gated, not scheduled

- The two postures re-order dispatch but do not solve any *observed* problem yet. The ZM already has
  per-instance control (override / same-day / SE-planner / capacity) and, once **#136** ships, full
  visibility of the per-zone mode. Postures are only worth building if a ZM demonstrates a real need
  those levers + #136 cannot meet.
- "Sensitivity" reads the same Soft Inactive Count that feeds the graded KPI, so even this bounded knob
  drifts toward the self-grading problem (proposal §3.1) unless OH owns the bounds and the
  posture-in-effect is recorded.

## Gate — ALL must hold before this leaves "deferred"

1. **Evidenced demand** — a specific ZM operational need that override/same-day/planner/capacity +
   #136 legibility provably cannot meet (not a hypothetical "configurability is nice").
2. **OH sign-off on bounds** — Operations Head owns and approves the enum→number mapping and the
   min/max ranges each posture may span. ZMs pick a named choice; they never see or set a number.
3. **#136 shipped** — legibility must exist first; a posture is unintelligible without the ZM being
   able to see what mode they're in and why.

## Non-negotiable exclusions (even when unblocked)

Never expose, per-zone or otherwise, to a ZM: `inactivity_threshold_hours`, `eligibility_mode`,
scoring weights (`priority_rule_config`), or SLA bands (`SLA_BANDS`). These define KPI denominators and
business tiers and are Operations-Head-owned platform invariants (proposal §3, §3.3). The code already
gates them OH-only (`settings.controller.ts:11`, `scoring-weights.controller.ts:16`).

## Requirements when built (from proposal §6)

- OH-bounded named enums (no numbers in the ZM UI); values resolved from OH-owned config.
- `ZoneScopeGuard`-clamped writes (a ZM may set only their own zone), audited via the existing
  `withAudit` pattern.
- Posture-in-effect **stamped on the dispatch-run ledger** (extend the existing `weightSetRef`/`mode`
  stamp, `recommender.service.ts:387`) so the ZM scorecard stays auditable — you must be able to say
  which posture was active for any graded period.

## Dependencies

- **Blocked-by (gate):** evidenced demand + OH sign-off + **#136** shipped.
- **Reference:** proposal `docs/proposals/zone-engine-customization-2026-07-21.md` §4 (Approach B), §5
  (recommendation), §6 (open questions). Recorded in the INDEX "Deferred / decided-against" section.
