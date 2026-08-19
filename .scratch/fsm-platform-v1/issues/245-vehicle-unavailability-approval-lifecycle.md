# 245 — Vehicle-unavailability lifecycle: one open report, supersession, audited proposal → approval / override

Status: ready-for-agent
Type: AFK · Backend + Admin

Filed 2026-08-19. Approved Decisions 11/12/13 with the two gate answers recorded below
(operator, 2026-08-19). The report becomes the system of record for the return-date decision;
scheduling wiring is #246.

## Approved authority decisions (recorded — do not re-litigate)

- **Q1 (pending-approval effect): (a)** — the SE's proposed date takes effect **immediately as a
  provisional deferral**; managerial review confirms or rewrites the date. Review changes the date;
  it never "un-waits" the ticket into a wasted dispatch.
- **Q2 (cross-role supersession): (a)** — **the latest valid in-scope managerial action supersedes,
  regardless of role.** Scope per the verified model: ZM = the ticket's zone
  (`isManagerForTicket` / `resolveManagerScope` semantics), CSM/OH = global. No role rank, no lock —
  the audit trail (decider, role, timestamp, reason, full history) carries accountability.

## What to build

### Current behaviour (verified)

`vehicle_unavailability_reports`: `fileReport` always `create`s (N OPEN rows per ticket possible);
`expectedFrom` is the SE's date, mutable in place by `confirmDate`
(`vehicle-unavailability.service.ts:178-184` — **one column, no audit row, no history**);
`resumeSla` is the only path to `RESOLVED`; `expectedTo` has zero readers; the schema/migration
comments falsely claim "the Ticket resurfaces at the expected-availability date" (never built —
corrected in this slice). Statuses: `OPEN | RESOLVED` only.

### Required change

**Data model (migration described in-slice):**
- Partial unique: one `OPEN` report per ticket.
- New status value `SUPERSEDED`.
- New columns: `proposed_from` (immutable copy of the SE's entry; existing `expected_from` becomes
  the **authoritative** date), `decided_by`, `decided_by_role`, `decided_at`, `decision`
  (`APPROVED | OVERRIDDEN`), `override_reason` (required when overriding).
- Backfill: trivial (0 rows in dev).

**Service:**
- `fileReport`: if an OPEN report exists for the ticket → mark it `SUPERSEDED` and create the new
  one in the same transaction (Decision 16: a new absence = a new report). `proposed_from` =
  `expected_from` = the SE's date at creation (provisional-authoritative per Q1(a)).
- New audited manager actions replacing `confirmDate`: **approve** (stamps decision columns,
  authoritative date = proposed date) and **override** (authoritative date = the manager's date,
  `override_reason` required). Both via `AuditService.withAudit`; both restricted to in-scope
  managers (`@Roles(ZM, CSM, OH)` + zone clamp for ZM); each later valid action overwrites the
  decision columns — history lives in `audit_logs` + `setting_changes`-style immutability is NOT
  needed because `proposed_from` is immutable and every decision is an audit row. The
  `POST /:id/confirm-date` endpoint is retired (410 or removed; admin client updated).
- Resolution: `RESOLVED` on `resumeSla` (existing), on supersession (`SUPERSEDED`), and on a
  troubleshooting submission for the ticket (Decision 16) — wired in `TroubleshootSubmissionService`.
- Correct the false schema/migration doc comments.

**Admin UI (`pages/readiness/VehicleUnavailabilityPage.tsx`, extended):**
- Review queue: proposed date vs authoritative date, decision state (undecided / approved /
  overridden by whom, when, why), approve + override-with-date+reason actions for in-scope managers,
  full per-ticket report history (superseded chain).

**Mobile:** entry unchanged this slice (#246 widens the date picker); the SE's read of "returns on
{date}" also lands in #246.

### Existing code to reuse

`VehicleUnavailabilityService` (+ `isManagerForTicket`), `AuditService.withAudit`,
`@@index([status, expectedFrom])` (finally gets queries), `apps/admin/src/api/vehicleUnavailability.ts`,
`VehicleUnavailabilityPage.tsx`.

### Tests

- e2e: one-OPEN-per-ticket enforced; supersession chain; approve and override stamp all decision
  columns + audit rows; ZM out-of-zone refused; a later CSM action supersedes an earlier ZM action
  and vice versa (Q2(a) pinned); submission resolves the report; retired endpoint refused.
- Admin: review-queue render, decide actions, role gating, history display.

### Risks / rollback

Additive columns + one partial unique (guarded creation handles the race). `confirmDate` retirement
is a breaking admin-API change — admin client updated in the same slice (no other consumers exist,
verified).

## Acceptance criteria

- [ ] AC1 — Exactly one OPEN report per ticket is possible; a new filing supersedes the old in one
      transaction and both remain readable as history.
- [ ] AC2 — The SE's `proposed_from` is immutable; the authoritative `expected_from` starts equal to
      it (Q1(a)) and changes only through audited approve/override actions.
- [ ] AC3 — Approve/override record decider, role, timestamp, decision, and (for override) a
      required reason — in the row and in `audit_logs`.
- [ ] AC4 — Latest valid in-scope action supersedes regardless of role (Q2(a)); ZM actions are
      zone-clamped; CSM/OH are global — all pinned by tests.
- [ ] AC5 — A troubleshooting submission resolves the ticket's OPEN report.
- [ ] AC6 — `confirmDate` is retired; no unaudited path can change the authoritative date.
- [ ] AC7 — The false "resurfaces at the expected-availability date" doc comments are corrected
      (made true by #246, but this slice must not leave the claim dangling on its own columns).
- [ ] AC8 — Admin review queue shows proposed vs authoritative vs decision state and supports both
      actions for the three manager roles per scope.

## UI surfaces

Admin: Vehicle Unavailability page (review queue + decision actions, modified). Mobile: n/a this
slice.

## Reference

The existing `VehicleUnavailabilityPage` (built without a v2-reference image — same posture;
extend its table/drawer patterns, no redesign).

## Blocked by

Nothing (gate answers recorded above). Blocks #246.
