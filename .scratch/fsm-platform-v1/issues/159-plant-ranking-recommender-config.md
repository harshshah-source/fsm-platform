# 159 — Admin-editable plant ranking in the recommender (the split-off half of #157)

Status: needs-triage
Type: HITL

> Filed 2026-07-27 from **[#157](./157-company-priority-plant-ranking-admin-config.md) Q-F**
> ("plant ranking split to its own issue … file the stub when it proceeds; #157 ships tiers only").
> #157 is DONE and shipped the *company-tier* half end-to-end; this issue owns the deferred
> *plant-ranking* half. **No code exists for plant ranking anywhere in the repo** (zero grep hits for
> `plant_rank` / `plants.priority_rank` as of 2026-07) — this is greenfield, not a repair.

## What to build

Make a plant's **priority** influence recommender dispatch, admin-editable and FSM-owned (a plant's
rank must **never** be in the AutoPlant master-sync update set — same anti-drift rule as
`plant_zone_overrides` and `company_tier_overrides`). The concrete shape is **not yet decided** — the
four questions below must be answered first — but the objective is: an operator can set a plant's
priority and it **demonstrably moves dispatch**, observably (stamped in `scoreBreakdown`, captured in
`dispatch_runs.config_snapshot`), the way company tier/rank already are after #157.

**Hard non-goal (settled): do NOT resurrect the vetoed weight-0 seam.** #157's original design carried
a `plants.priority_rank` column wired into a **weight-0-seeded** `plant_rank` scoring component — a
dormant knob that ships config now and wires the engine "later." That middle path was **vetoed
2026-07-23** as the ship-config-now-wire-later anti-pattern (the #130 / run-65 family: a control that
appears live but changes nothing). Whatever lands here must be **wired and observable on day one**, or
not shipped.

## Open design questions (HITL — resolve before any code)

1. **Per-zone or global?** Is plant priority ever **per-zone** in the business, or a single **global**
   value per plant? (Mirrors #157's global-vs-per-zone tier question; determines the data model — a
   column on `plants` vs a scoped override table.)
2. **Engine move, or tiebreaker reframe?** Must plant priority be a **new scoring component / sort
   key that reorders dispatch**, or is it better framed as a **tiebreaker ordering** slotted into the
   existing canonical sort (Company Tier → Device Bucket → Company Priority Rank → Oldest Inactive →
   Device ID, Decision §17 `CONTEXT.md:761-769`)? This decides whether it is an engine change or a
   sort refinement — and it is the question the vetoed weight-0 seam dodged.
3. **#158 interaction (only live if Q1 = per-zone).** A plant zone move (#158) re-scopes the plant, so
   a per-zone plant rank would silently re-attach exactly like #157 overrides — it would then need the
   same `zoneChangeImpact` warning treatment (#157 S6 / AC-9) extended to name plant-rank changes.
4. **Authority.** Who edits it — OH-only (matching Company Priority Rank, managed in Settings per
   `26-settings.png`), or an extended CSM/ZM authority like #157's overrides? Record the decision in
   `CONTEXT.md`/PRD if it extends documented authority.

## Acceptance criteria

**DRAFT — gated on the four questions above; do not build until they are answered.** Provisional:

- [ ] Plant priority is admin-editable and **FSM-owned** — never overwritten by master sync (drift test).
- [ ] It **demonstrably changes dispatch ordering** — a real reorder test at the `runForZone` boundary,
      not a dormant/weight-0 knob (the veto).
- [ ] Stamped in `scoreBreakdown` and captured in `dispatch_runs.config_snapshot`, like company tier/rank.
- [ ] Admin surface honours the Parity gate (`docs/agents/workflow.md`); see `## Reference`.
- [ ] If per-zone (Q1): the #158 `zoneChangeImpact` + Plant Zones confirm dialog name plant-rank changes
      a move detaches/attaches (reuse the #157 AC-9 pattern).

## UI surfaces

TBD — pending Q2/Q4. If it ships as an admin-editable field, an OH (or CSM/ZM) config surface, most
likely in Settings alongside Company Priority Rank, or on a plant-scoped page. Named in the design
when the issue proceeds; subject to the Parity gate — no silent UI deferral.

## Reference

n/a today — **no v2-reference surface exists for plant ranking.** The Settings console
(`docs/ui/desktop/v2-reference/26-settings.png`) covers *company* tier/priority-rank config only; its
footnote lists "Company Tier / Priority Rank … managed here in the full product" — not plant ranking.
A surface (and its reference disposition, matching #157/#158's documented-discrepancy handling if none
exists) is specified when the issue proceeds.

## Blocked by

Not technically blocked, but **gated on the four HITL design decisions above** (Q1–Q4). Parent: #157
(Q-F). Independent of the shipped #157 tier work.
