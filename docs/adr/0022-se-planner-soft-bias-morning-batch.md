# ADR-0022: SE Planner Is a Soft Morning Batch Bias Signal, Not a Hard Constraint

## Status

Accepted

## Context

The SE Planner is a weekly plant-visit scheduling tool used by the Zonal Manager — a plant-vs-date grid where the manager assigns which SE visits which plant on which day. It is distinct from the Day Plan (the Recommender's daily ticket-level output).

Three possible relationships between SE Planner and the Morning Batch Recommender were considered:
1. **No connection** — Planner is display-only; Recommender ignores it.
2. **Soft bias** — Planner entries bias the Recommender toward routing planned-plant tickets to the planned SE, but Recommender can deviate if scoring demands it.
3. **Hard constraint** — Planner entries force the Recommender to route planned-plant tickets to the planned SE regardless of score.

A hard constraint removes the Recommender's ability to respond to field reality (a CRITICAL device at Plant B may be more urgent than the planned Plant A visit). A no-connection model wastes the manager's planning intent — the Recommender would ignore a deliberate coordination decision. A soft bias preserves both.

## Decision

- **SE Planner entries act as a soft bias signal** to the Morning Batch Recommender. When the Zonal Manager schedules SE X to visit Plant A on day D, the Recommender applies a plant-affinity boost to Plant A tickets when scoring SE X's Day Plan for day D — similar in mechanism to the Plant Cluster Multiplier (ADR-0003).
- The bias is **not a hard constraint**: if scoring or Hard Filters demand a different routing (e.g., a CRITICAL device at Plant B outranks anything at Plant A), the Recommender can and will deviate.
- **Planner entries automatically surface in the resulting Day Plan** for review. The Zonal Manager sees the planned visit in the Day Plan and can override before approving.
- SE Planner operates at **plant level** (which SE visits which plant, when). Day Plan operates at **ticket level** (which specific tickets an SE handles that day). They are separate tools, separate entities, separate screens.

## Consequences

- The Morning Batch must read `SE_PLANNER` entries for the current day before scoring, applying a configurable `planner_affinity_weight` (Admin-configured, same settings surface as other Recommender weights).
- `SE_PLANNER` entries appear in the Day Plan as pre-populated plant-visit intent rows. The Zonal Manager can remove or reorder them during the approval review.
- If the Recommender deviates from a Planner entry (scoring routed a different SE to Plant A), the deviation is logged in `RECOMMENDATION_HISTORY` with `planner_deviation = true` so the Zonal Manager can see why their plan was not followed.
- MVP scope: SE Planner history stored in-memory / localStorage only; persistence to database (`SE_ASSIGNMENT_HISTORY`) is post-MVP.
