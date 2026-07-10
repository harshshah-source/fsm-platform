# ADR-0019: Day Plan Approval SLA — Pending-Visible, Read-Receipt Flag Clear, Always-Overridable

## Status

**Superseded (2026-06-08)** — the entire Day Plan *approval* model is removed. There is no pending-visible state, no read-receipt flag clear, and no approval gate: system-generated Plant-wise Batch Assignments **auto-dispatch** directly to the SE Day Plan as Formal Assignments (`AUTO_ASSIGNED`) and are immediately actionable. The Zonal Manager monitors and **overrides post-hoc** (`OVERRIDDEN`) at a flexible cadence; the always-overridable + ON_SITE-conflict-warning portion of this ADR survives in that override path. See `CONTEXT.md` Decisions §2 & §7 and the 2026-06-08 business edits.

The decision below — a *pending-but-visible* Day Plan gated behind Zonal Manager approval / 08:00 IST auto-approve, with `day_plan.status IN (APPROVED, AUTO_APPROVED)` and a `reviewed_at` read-receipt — is **no longer in force**. There is **no approval gate**: system-generated Plant-wise Batch Assignments **auto-dispatch** directly to the SE Day Plan as Formal Assignments (`AUTO_ASSIGNED`); the SE can act immediately; the Zonal Manager **overrides post-hoc** (`OVERRIDDEN`). The `DAY_PLAN.status` / `auto_approved` / `approved_at` fields, the 08:00 IST gate, and the pending-action lock are all removed. **Still in force:** override is allowed at any time, including after an SE holds `ON_SITE`, with the dashboard surfacing an explicit conflict warning before the override commits.

_Original status: Accepted._

## Context

ADR-0007 established the 08:00 IST auto-approve safety net but left three implementation details unresolved:
1. What the SE sees before the Zonal Manager approves.
2. What clears the "unreviewed" flag once auto-approve fires.
3. Whether the Zonal Manager can override a Day Plan after the SE is already ON_SITE.

These details matter because: locking SEs out before 08:00 creates a dead zone; requiring an explicit manager action to clear the unreviewed flag adds friction without value; and hard-blocking override once an SE is on-site removes the manager's ability to catch a badly-generated plan mid-morning.

## Decision

- **Before 08:00 IST (pending state):** The SE's mobile home screen shows the Day Plan in a *pending-but-visible* state — the SE can see the plan but cannot act on any Ticket (no VIEWED, no ON_SITE) until the Zonal Manager approves or 08:00 fires auto-approve.
- **Unreviewed flag:** Clears when the Zonal Manager **opens** the Day Plan screen for that SE on that date — a read receipt. No explicit approval action is required to clear the flag. Reports can answer "auto-approved and never reviewed" vs "auto-approved but reviewed post-08:00."
- **Override after ON_SITE:** Override is allowed at any point — including after the SE holds an active ON_SITE soft state. The Zonal Manager dashboard **explicitly surfaces the SE's physical presence** when ON_SITE is active, making the override a deliberate informed action rather than an accidental disruption. No hard lock exists at any stage.

## Consequences

- Mobile app must enforce the pending gate: Ticket actions disabled until `day_plan.status IN (APPROVED, AUTO_APPROVED)`.
- `DAY_PLAN` table carries: `reviewed_at` (nullable — set on first manager open), `auto_approved` (boolean), `approved_at`.
- Zonal Manager dashboard shows ON_SITE soft-state duration as a disruption warning banner when the manager initiates an override on an active ticket.
- "Unreviewed auto-approved Day Plans" is a reportable metric for Operations Head — a zone with persistent unreviewed plans is a Zonal Manager capacity or engagement signal.
