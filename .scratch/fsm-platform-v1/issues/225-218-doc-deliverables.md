# 225 — #218's two documentation deliverables are unwritten

Status: ready-for-agent
Type: Docs
Filed: 2026-08-07
Origin: `/code-review` of the uncommitted [#218](./218-lifecycle-drift-detection.md) work, Spec axis

## Problem

`FIX-PLAN.md` §8 lists the docs #218 must update. Four of six were done (INDEX.md, SYSTEM-STATE §6.1,
the issue file, and the FIX-PLAN itself). **Two were not:**

> - `docs/kpi-definitions.md` — the lifecycle-drift check, if §5 grows an identity
> - `docs/progress/218-*.md` — TDD completion report, written once

§5 did grow an identity (`lifecycleConsistency`, the 9th), so the `kpi-definitions.md` condition is
met and the doc has no `lifecycle` mention today.

## Acceptance criteria

**`docs/kpi-definitions.md`** — document the lifecycle contradiction check:
- `drift` compares `vehicles.status` against `device_states.is_departed`, **excluding** devices with
  an open `ABSENT_FROM_READ` departure, so its correct value is exactly **0**. State plainly that this
  is a *contradiction*, not a measurement: it has no acceptable non-zero value and no tolerance knob,
  which is what distinguishes it from `INGESTION_RECON_MAX_DRIFT`.
- `missingFromSource` — the excluded population, surfaced beside `drift` rather than hidden.
- `quietRuns` / `INGESTION_LIFECYCLE_QUIET_RUNS` — a *patience* knob, never a tolerance on `drift`.
  Record the current semantics honestly: `quietRunsAlert` fires when `quietRuns > threshold`, so the
  default 3 alerts on the **4th** consecutive quiet run. FIX-PLAN §4.4's wording ("flag when N
  consecutive SUCCESS runs record zero") reads as alerting *at* N — the code and its spec are
  self-consistent and deliberately assert `atThreshold.quietRunsAlert === false`, so **either** align
  the doc to the code or change both together. Do not leave the two disagreeing.
- Whether `healthy + inactive = operational` and the other §5 identities are affected: they are not —
  this metric is orthogonal to the fleet-count identities and must not be added to them.

**`docs/progress/218-*.md`** — the TDD completion report, in the existing format, frozen once written
(per CLAUDE.md: corrections go to INDEX/SYSTEM-STATE, not into the report). It should cover 218a, 218b,
the Gate-0/2/3 results, and the three pre-window deliverables. The material already exists in the issue
file and INDEX session log — this is assembly, not new investigation.

## Note

Write this **after** #218c runs, not before: the completion report should carry the window's actual
post-run readings against the falsifiable predictions (`drift → 0`, `quietRuns → 0`,
`missingFromSource → ~2,436`, Nuvista ~7,705), which is the whole acceptance test. Writing it now
would freeze a report that is missing its own verdict.
