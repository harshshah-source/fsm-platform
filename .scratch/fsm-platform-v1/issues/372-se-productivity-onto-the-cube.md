# 372 — Move SE productivity onto the summary cube

Status: `ready-for-agent` — filed 2026-09-04. Restores the one AC clause [#365](./365-se-productivity-report.md) could not meet.

**Blocked by:** nothing (#365 and #366 both landed; the schema is free again).
**Design:** [`se-productivity-report.html`](../../../docs/ui/desktop/approved-designs/se-productivity-report.html) — unchanged; this is a source change, not a surface change.

## Why this exists

#365's AC1 says the report is "computed from the summary tables", and decision record
[#368](./368-decision-se-productivity-report.md) says **no live recomputation**, so the page cannot
disagree with the ZM scorecard beside it. #365 met the report and the design but **not that clause**,
for a reason it verified rather than assumed:

> The efficiency cube's `se_id` dimension is populated by **legs 5 and 7 only** (auto-assignments,
> overrides). Legs 3 (first-time fixes), 4 (failed verifications) and 8 (on-site → submission) all
> write `se_id = NULL`, and **no cube carries a closure-type split at all.**

Serving it from a cube therefore needs new columns, and `schema.prisma` belonged to #366 that round.
#365 shipped a bounded live read in the shape `workTypeMix` and `verificationOutcomes` already use,
with an honest `dataAsOf` (the instant the server answered, never a fabricated cube stamp), and
answered the design's *actual* concern directly: the first-time-fix predicate is character-for-character
the cube's own leg 3.

**So this is not a correctness bug — it is a cost and consistency debt**, and it should be closed
deliberately rather than left to be rediscovered as "why is this page slower than its siblings".

## Acceptance criteria

- [ ] The cube carries the per-SE dimension the report needs: first-time fixes, failed verifications
      and on-site → submission populated with `se_id`, plus a **closure-type split** so
      `se_repaired_closures` and departure closures are separately readable.
- [ ] `GET /api/reports/se-productivity` reads the cube. Its response shape does not change.
- [ ] `dataAsOf` becomes the cube's `MAX(computed_at)` over exactly the rows read — the #347 rule —
      instead of the query instant.
- [ ] **The numbers do not move.** Pin it: the same window through the old live read and the new
      cube read must agree, engineer for engineer. That equality is the whole reason to do this.
- [ ] The small-sample suppression stays enforced in the **service**, not the view (a CSV export must
      not carry a rate the page refuses to draw).

## Notes for whoever takes it

- **F7 is already fixed** in `fleet-uptime-aggregation.service.ts` (#365): closures are classified by
  kind and `se_repaired_closures` counts `SE_REPAIR` alone. The cube work extends that classification;
  it must not re-merge the kinds.
- Related debt #365 also left: the departure **count** is not stored on
  `device_downtime_summary_monthly`, so Fleet Uptime cannot yet show "and this many closed because
  vehicles left". The aggregation already classifies all four kinds — a column is the only missing
  piece, and this is the natural slice to add it in.
- Also unresolved and worth a ruling while you are here: `OPERATIONS_HEAD_OVERRIDE_CLOSE` closures
  appear on neither surface — correctly, since they are neither repairs nor departures — but somebody
  should decide whether a third column is owed.
- Migration: hand-write it and rely on the suite (standing operator decision); the drift gate cannot
  run on this box. Do **not** regenerate `prisma/drift-baseline.txt`.
