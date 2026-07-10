# ADR-0004: Installs and Troubleshoots Share One Ticket Entity Distinguished by `work_type`

## Status

Accepted

## Context

Two work categories land on the same 40-SE pool: new-device installations (`INSTALL`) and inactive-device troubleshooting (`TROUBLESHOOT`). Modelling them as separate entities (e.g., `Installation` vs `Ticket`) would require split capacity allocation ("10 installs / 30 repairs"), which breaks whenever an install backlog spikes or a critical-device wave hits. A single entity with no sub-type distinction loses governance value — lifecycle states, verification rules, and warranty semantics genuinely differ.

## Decision

Both work categories are the same `Ticket` entity carrying an immutable `work_type` discriminator:

- `TROUBLESHOOT` — inactive-device repair, always parented by a Failure Cycle. Lifecycle: `OPEN → SUBMITTED → VERIFICATION_PENDING → CLOSED` (or `FAILED_VERIFICATION` / `ESCALATED`).
- `INSTALL` — first-time device fitting, no Failure Cycle parent. Lifecycle: `REQUESTED → SCHEDULED → ON_SITE → FITTED → ACTIVATED → CLOSED` (or `FAILED_ACTIVATION`). `ACTIVATED` timestamp anchors warranty start.
- `RECOVERY` — physical retrieval of a provider-owned Device after Non-Operational marking under a recurring deal. Lifecycle: `REQUESTED → SCHEDULED → ON_SITE → COLLECTED → RECEIVED_AT_WAREHOUSE → CLOSED`.

The Recommender, Day Plan, Zonal Manager approval flow, SE mobile UX, soft states, audit log, and SE capacity pool are **shared**. Sub-type-specific fields live in `INSTALL_DETAILS` / `TROUBLESHOOT_DETAILS` 1:1 child tables. `work_type` is **immutable** — a Troubleshoot cannot transition into an Install.

## Consequences

- Auto-verification branches on `work_type`: Install needs the **first** valid GPS ping post-fitment; Troubleshoot needs **recovery** pings after the parent Failure Cycle's submission timestamp.
- Warranty start = `Ticket.activated_at` for Installs.
- All reports must always group/filter by `work_type` to avoid conflation.
- The SLA tier gate naturally lets a CRITICAL inactive Device pre-empt routine Installs on the same Day Plan.
- `Recovery` Tickets are filtered from Fleet Uptime KPIs but appear in SE workload reports since they consume Day Plan capacity.
