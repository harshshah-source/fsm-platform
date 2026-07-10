# ADR-0007: Morning Batch Is Per-SE Day Plan One-Click Approval; Intra-day Uses SE Acceptance Flow

## Status

**Superseded (2026-06-08)** — the per-SE one-click *approval* gate is removed. System-generated Plant-wise Batch Assignments now **auto-dispatch** directly to the SE Day Plan as Formal Assignments (status `AUTO_ASSIGNED`); the Zonal Manager monitors and **overrides post-hoc** (`OVERRIDDEN`). No Approve action, no `PENDING_REVIEW`, no auto-approve timer. Intra-day urgent CRITICAL/HIGH_CRITICAL insertions still require SE Acceptance. See CONTEXT.md Decisions §2 & §7 and the 2026-06-08 business edits. The intra-day SE-Acceptance portion of this ADR remains in force.

## Context

Two approval granularities were considered for the Morning Batch: per-Ticket (too granular at ~50–200 rows/day/zone) and zone-wide batch (one bad row taints the whole batch, manager hesitates). Per-SE is the natural match for how operations thinks about field-day allocation.

For intra-day CRITICAL insertions, the prior model (auto-approve + Manager Revert Window) was replaced because mid-day insertions land on SEs already mid-route — making the manager the commit authority for something the SE hadn't agreed to was the wrong abstraction.

## Decision

- **Morning Batch**: the Zonal Manager approves one SE Day Plan at a time — the entire route for an SE is reviewed and committed in a single Approve action. Overrides (swap SE, remove Ticket, reorder, defer) happen inside the per-SE screen before Approve.
- **Intra-day CRITICAL insertions**: follow the SE Acceptance flow detailed in ADR-0016 — the assignment is not committed until the SE explicitly accepts in-app.
- **Auto-approve SLA**: if the Morning Day Plan is unreviewed by 08:00 IST, it tentatively auto-approves so SEs aren't blocked; the "unreviewed" flag stays visible.
- **Manager Revert Window** concept is **removed**. Manager override of an SE-accepted assignment happens through the normal override UI at any time before the SE departs for the inserted Plant.

## Consequences

- `RECOMMENDATION_HISTORY` immutable rows track: `Recommendation → ManagerApproved → SEAccepted → OnSite → Closed` for the morning path; `Recommendation → SEAccepted (or retried) → OnSite → Closed` for the intra-day path.
- A Ticket where the chosen SE declines or times out three times escalates to explicit manager assignment — never auto-loops.
- Morning Day Plan has a manager-review SLA (08:00 IST) with tentative auto-approve as the safety net.
