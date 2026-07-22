# 145 — Audit-trail viewer: parity-gate violation on Issue 03 AC#18
Status: ready-for-agent
Type: AFK

> Source: `docs/audits/2026-07-22-adversarial-review-admin-backend.md` §4.4 (N2, `needs-changes`).
> Follow-up to [#03](./03-notifications-audit-spine.md) — the parent stays **accepted**; per
> `docs/agents/issue-tracker.md` "accepted-with-follow-up", it is **not** reopened.

## Background

PRD user story **73** (`docs/PRD-fsm-admin-dashboard.md:214`):

> *"As any role, I want to see the full audit trail for any Ticket (Recommendation → BatchApproved →
> SEAccepted → OnSite → Closed, or the intra-day retry chain; `closure_type` and reason on every
> Recovery Ticket close), so that post-incident review has a complete record."*

The business workflow makes it a headline before/after (`fsm-business-technical-workflow.md:54`):
*"No audit trail; no way to know who approved what or when"* → *"Every state change, approval,
override, and close action recorded with actor, role, timestamp, and reason."*

Issue 03's own scope line (`:8`) promises *"**A reusable audit-trail viewer** that renders the full
chain for any Ticket."*

## Problem

Issue 03 AC#18 is marked **`- [x]`** — *"Audit-trail viewer renders the full transition chain for any
Ticket with actor, role, timestamp"* — on the strength of a shipped endpoint. **Only the API exists.**

## Root Cause

The acceptance criterion was closed against the backend deliverable. The genuinely deferred part of
Issue 03 was the external FCM/APNs/WhatsApp/SMS/SMTP adapters (→ [#76](./76-notification-spine-adoption-external-adapters.md)),
which is a legitimate external-integration seam. The **viewer** was swept along with that deferral
even though it consumes an endpoint already implemented in this repo.

`CLAUDE.md` is explicit that this is not permitted: *"'Build the seam' applies to **external
integrations** (FCM/APNs/WhatsApp/SAP/AutoPlant) — **not** to admin pages or mobile screens that
consume endpoints already implemented in this repo."*

## Evidence

- `apps/backend/src/audit/audit-trail.controller.ts` exists. `AuditTrailService` merges
  `ticket_events` (state transitions + `closure_type`/reason) with the ticket's `audit_logs` into one
  time-ordered chain carrying actor / role / **`acted_as_role`**; manager roles, ZM zone-scoped,
  out-of-zone → 404 (issue 03 disposition, `:43-45`).
- `grep -ri "audit-trail|auditTrail|AuditTrail" apps/admin/src` → **zero hits** (verified 2026-07-22).
- **The last navigational affordance was deliberately removed.** INDEX:92:
  > *"Footer columns converted from dead text to router `Link`s (16 links …; dead labels Stock/Role
  > Access/**Audit Trail** → Component Blocked/Manage SEs/**Exports**)."*

  Correct at the time — the label led nowhere — but nothing replaced it.

**Why this blocks under the parity gate.** `CLAUDE.md` permits an unbuilt in-scope UI AC only if
**(a)** a follow-up issue is filed and linked in INDEX **and** **(b)** the deferral reason is an
external-integration blocker.

- **(a) is absent** — unlike the zone-mapping UI, which correctly has [#120](./120-zone-mapping-admin-ui.md).
- **(b) does not apply** — rendering a ticket's audit chain consumes an in-repo endpoint.

This is the **second** instance of the pattern the audit put on its kill list (*"Marking UI acceptance
criteria `[x]` on the strength of a shipped endpoint"*); #120 was the first, and that one at least got
filed.

## Current Behaviour

No operator can view a ticket's audit chain anywhere in the admin app. The acceptance criterion claims
otherwise, and the footer link that once pointed at it was repointed to Exports.

## Expected Behaviour

Either the viewer renders, or AC#18 is honestly `[~]` with a linked, INDEX-tracked owner. **Slice 1
delivers the honesty half and closes the parity-gate violation on its own**; Slices 2–3 deliver the
viewer.

## What to build

1. Correct Issue 03 AC#18 to `[~]` with a pointer to this issue, and register this issue in INDEX's
   Follow-ups section. (Parent stays `accepted` — do **not** reopen #03.)
2. A typed client + reusable presentational timeline over `GET /api/audit-trail/tickets/:ticketId`.
3. Mount it as a tab on the Ticket Detail Drawer, following the existing Lifecycle /
   Assignment-History tab pattern established by the 2026-07-15 drawer restyle. **Do not invent a new
   surface.**

Presentation-only. **Zero backend change.**

## Acceptance criteria

- [ ] Issue 03 AC#18 reads `[~]` with a pointer to this issue; `INDEX.md` Follow-ups gains `145 — Audit-trail viewer → 03`. Parent #03 remains `accepted`.
- [ ] A reusable viewer renders the merged chain for any ticket: actor, role, **`acted_as_role`** where applicable, timestamp, action/transition, and `closure_type` + reason where present.
- [ ] Mounted as a tab on the Ticket Detail Drawer, matching the existing pill-tab pattern (raised header band, mono id, StatusPill) rather than a new page or route.
- [ ] Role visibility matches the API exactly: manager roles only; ZM zone-scoped. An out-of-zone ticket renders an **explicit denied state**, never an empty timeline (a 404 must not read as "this ticket has no history").
- [ ] Loading / empty / error states present, following the `DataTable` error+Retry precedent from the 2026-07-14 hardening — **no fake empty state**.
- [ ] Reference images checked before building, per the surfacing rule.
- [ ] Admin suite green.

## TDD Strategy

**Slice 1 is documentation — no test.** Verification is reading the corrected AC line and the INDEX
Follow-ups entry.

**Slices 2–3 are strict TDD**, RED → GREEN per slice, over stubbed `fetch` (the established admin
pattern — 61 of 82 specs use `vi.stubGlobal('fetch', …)`).

- **Slice 2 RED:** render `AuditTrailTimeline` with a stubbed two-event chain and assert
  chronological order, `acted_as_role` rendered when present, and `closure_type` + reason rendered.
  *Fails today* because the component does not exist (module resolution error).
  *Passes* once the component maps the API shape to timeline rows.
- **Slice 3 RED:** open the drawer as a ZM on an in-zone ticket and assert the Audit Trail tab
  renders the chain; then as a ZM on an out-of-zone ticket (stubbed 404) and assert the **denied**
  state, not an empty list. *Fails today* because no tab is registered.
  *Passes* once the tab is wired and the 404 branch is mapped to the denied state.

The 404-vs-empty distinction is the assertion most worth writing first — it is the one a
"just render the array" implementation gets wrong.

## Implementation Slices

### Slice 1 — Honesty first (no code)

- **Objective:** close the parity-gate violation immediately.
- **Files:** `.scratch/fsm-platform-v1/issues/03-notifications-audit-spine.md` (AC#18 → `[~]` + pointer),
  `.scratch/fsm-platform-v1/INDEX.md` (Follow-ups entry).
- **Services / Database / Frontend / Tests:** none.
- **Acceptance criteria:** AC 1.
- **Definition of Done:** AC#18 reads `[~]` with a pointer; INDEX Follow-ups links #145; #03 still
  `accepted`. **Mergeable and valuable alone — 15 minutes.**

### Slice 2 — Typed client + timeline component

- **Objective:** a reusable, tested viewer that renders in isolation.
- **Files:** `apps/admin/src/api/auditTrail.ts` *(new)*,
  `apps/admin/src/components/domain/AuditTrailTimeline.tsx` *(new)*,
  `apps/admin/src/components/domain/index.ts` (export).
- **Services:** none — consumes `GET /api/audit-trail/tickets/:ticketId`.
- **Database:** none.
- **Frontend:** presentational timeline; design tokens only, no new palette.
- **Tests:** component spec over stubbed fetch — order, `acted_as_role`, `closure_type` + reason,
  empty state, error state.
- **Acceptance criteria:** AC 2, 5.
- **Definition of Done:** component green in isolation, not yet mounted.

### Slice 3 — Mount on the Ticket Detail Drawer

- **Objective:** the viewer is reachable by an operator.
- **Files:** Ticket Detail Drawer + tab registration.
- **Services / Database:** none.
- **Frontend:** new pill tab following the existing Lifecycle / Assignment-History pattern.
- **Tests:** tab renders for ZM (in-zone) / CSM / OH; out-of-zone renders the denied state; SE n/a.
- **Acceptance criteria:** AC 3, 4, 6, 7.
- **Definition of Done:** admin suite green; layout checked against the reference images.

## Rollback Plan

Slice 1 is a docs revert. Slice 3 removes the tab registration (one file). Slice 2's client and
component are additive and unreferenced once the tab is gone — safe to leave or revert independently.
No backend surface is touched, so nothing to roll back server-side.

## Dependencies

None. The API is complete and audited (13 e2e in Issue 03, 5 of them audit-trail). The host surface
(Ticket Detail Drawer, Issue 07) exists and was restyled 2026-07-15.

## Estimated Effort

Slice 1: 15 minutes. Slices 2–3: ~1 day. **Priority: P2** — but Slice 1 should land early and cheaply,
since the checked-but-unbuilt AC is the actual defect.

## UI surfaces

Admin: **Ticket Detail Drawer** — new "Audit Trail" tab (manager roles; ZM zone-scoped).
Mobile: n/a.

## Reference

- `docs/ui/desktop/v2-reference/28-tickets-drawer.png` (drawer + tab pattern)
- `docs/ui/desktop/v2-reference/08-ticket-detail.png` (ticket detail composition)

## Blocked by
None.
