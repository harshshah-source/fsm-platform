# 14 (14a) — SE Planner CRUD + recommender bias

Status: done
Type: AFK
Progress: docs/progress/14a-se-planner-crud-bias.md — se_planner schema + ZM-scoped CRUD API + recommender soft bias; all 5 ACs green. Grid UI is 14b.

> **Scope note (2026-06-21):** split into **14a** (this issue — `se_planner` schema, CRUD API,
> recommender soft-bias + contract tests) and **14b** (the React drag-to-assign grid UI;
> `14b-se-planner-grid-ui.md`). The grid ACs moved to 14b.

## What to build

The SE Planner backend: the `se_planner` table, a ZM-scoped CRUD API (`/api/planner`) for plant-visit
intents (SE × plant × date), and the **soft bias** into the batch run — when the planner names an SE
to visit a plant on the run date, the Recommender **prefers** that SE among the eligible candidates for
that plant (ADR-0022). It is **not** a hard constraint: if the planned SE is ineligible (hard filter /
capacity) the Recommender falls back to strict precedence, and a more urgent routing still wins. The
biased assignment lands in the SE's dispatched batch and stays overridable (Issue 13a).

End-to-end: a ZM records plant-visit intents; the next batch run prefers those SEs for those plants,
and the assignment surfaces in the affected SE's batch.

## Acceptance criteria

- [x] `se_planner` entries persisted (schema + migration)
- [x] ZM-scoped CRUD API for planner entries (create / list / delete), own zone only
- [x] Planner entries bias the next batch run (soft: prefer planned SE among eligible, not a hard filter)
- [x] The planner-biased assignment surfaces in the corresponding Batch Schedule and remains overridable *(biased SE's recommendation flows through dispatch into that SE's batch; overridable via 13a)*
- [x] ZM scoped to own zone

## Blocked by

- #11
