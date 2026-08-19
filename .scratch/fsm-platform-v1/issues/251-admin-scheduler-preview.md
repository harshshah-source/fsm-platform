# 251 — Admin scheduler preview: non-blocking plan projection, stale-token safety, pre-run holds

Status: ready-for-agent
Type: AFK · Backend + Admin

Filed 2026-08-19. Approved Decision 1/18: Admin sees tomorrow's proposed plan and may place holds;
Admin approval is never required — inaction means the 05:00 run proceeds normally, and manual runs
keep working. Pre-run changes are **holds only** (the recorded interpretation: the only pre-run
change the current data model expresses).

## What to build

### Current behaviour (verified)

No preview exists; the only projection pattern in the repo is `BulkUnassignService` (#179):
HMAC-SHA256 token over a `countsByZone` snapshot (`signPreviewToken`/`verifyPreviewToken`,
`bulk-unassign.service.ts:97-130` — **module-private**, 10-min TTL `:82`), outcomes
`TOKEN_REQUIRED | TOKEN_INVALID | TOKEN_STALE` with `TOKEN_STALE` returning a fresh preview, admin
page precedent `apps/admin/src/pages/admin/BulkUnassignPage.tsx`. The hold primitive
(`tickets.deferred_until` + inclusive `notDeferredOn`) exists and is unused (0 rows) — but the only
hold writer, `DEFER_TICKET`, requires a **live batch row**, so an *unassigned* ticket cannot be held
pre-run today. Holds and the 05:00 run are verified non-interfering (disjoint writes; the run's
advisory lock covers scheduling tables only).

### Required change

**1. Token module extraction:** lift sign/verify/TTL out of `bulk-unassign.service.ts` into a shared
`scheduling/preview-token.ts` (same HMAC secret source, same semantics); bulk-unassign consumes the
shared module — no fork, behaviour pinned by its existing e2e.

**2. Preview endpoint:** `GET /api/schedules/preview?date=D` (roles OH/CSM; ZM read scoped to their
zone) → #250's dry-run orchestration → `{ zones: se → plant → tickets projection, withheld/
unassignable counts, holds in force for D, bucketsAsOf, previewToken }`. The token binds a snapshot
of the projection's per-zone counts; execution never happens *from* the preview (the 05:00/manual
run is the executor), so the token's job here is staleness *display*: a re-poll returning
`TOKEN_STALE` tells the admin the world moved and hands them a fresh projection.

**3. Pre-run hold endpoint** — the one genuinely new write path:
`POST /api/schedules/holds { ticketId, holdUntilDate, reasonCode }` (+ release), for **OPEN +
UNASSIGNED** tickets — an audited bare write of `tickets.deferred_until` (no batch row involved).
Refusal/warning branch: a ticket whose deferral derives from an OPEN vehicle-unavailability report
(#246) is refused with the return-date context unless explicitly confirmed — a scheduler hold must
never silently overwrite a vehicle-return decision (Decision 13 separation). Holds on assigned
tickets remain `DEFER_TICKET`'s job (existing).

**4. Admin page** — "Scheduler Preview" (new, nav for OH/CSM/ZM per read scope):
date picker (default tomorrow) → projected plan grouped SE → plant → tickets with drop/withheld
counts; the **as-of caveat rendered verbatim** ("severity buckets as of {bucketsAsOf} — the run
re-evaluates at dispatch"); per-ticket Hold/Release actions with reason; a stale banner + refresh on
`TOKEN_STALE`; links into the existing dispatch-transparency page for post-run comparison. UI
precedent: `BulkUnassignPage` (flow) + the dispatch transparency pages (layout).

**5. Non-blocking guarantees (pinned, not assumed):** with zero admin action the 05:00 run's
output is bit-identical to a world where the preview was never opened; manual
`POST /api/schedules/dispatch-run` behaviour unchanged; a preview during a live dispatch neither
blocks nor is blocked (#250 AC1).

### Existing code to reuse

#250's seam; `bulk-unassign` token + page patterns; `deferral.ts`; `AuditService.withAudit`
(hold/release audit rows); dispatch transparency UI components; `schedules.controller.ts`.

### Tests

- e2e: preview for D+1 reflects a hold placed now (held ticket absent from D+1's projection);
  release restores it; hold on a VU-deferred ticket refused without confirm; hold on an assigned
  ticket refused (pointing at DEFER_TICKET); admin-inaction parity (projection then real run —
  run output identical to a no-preview control); token staleness (world moves → `TOKEN_STALE` +
  fresh projection); role scoping (ZM sees own zone only).
- Bulk-unassign e2e still green on the extracted token module.
- Admin: page render, hold/release flow, caveat text, stale banner, nav visibility.

### Risks / rollback

Read-only projection + one audited date column write — low blast radius. Feature-flag/nav-gate the
page if staged. Rollback: remove endpoint + page; holds are just dates, releasable.

## Acceptance criteria

- [ ] AC1 — An OH/CSM (and zone-scoped ZM) can view the projected plan for today or a future date
      without any write occurring anywhere (count-pinned via #250).
- [ ] AC2 — Holds placed from the preview exclude the ticket from the target day's run through the
      existing predicate; releasing restores it; both audited with reason.
- [ ] AC3 — Admin inaction changes nothing: the 05:00 and manual runs are byte-equivalent to the
      no-preview control (pinned).
- [ ] AC4 — A hold can never silently overwrite a vehicle-return deferral (refusal + confirm
      branch, Decision 13).
- [ ] AC5 — Stale previews are detected and refreshed via the shared token module; bulk-unassign's
      behaviour is unchanged by the extraction.
- [ ] AC6 — The as-of-recompute caveat is displayed with the actual watermark; no UI claim implies
      future-date severity is being predicted.

## UI surfaces

Admin: Scheduler Preview (new page + nav entry). Mobile: n/a.

## Reference

No v2-reference image exists for this new surface (same posture as `BulkUnassignPage`); layout
follows `apps/admin/src/pages/dispatch/*` (transparency) + `BulkUnassignPage.tsx` patterns — no
novel visual language.

## Blocked by

#250 (seam). The VU-refusal branch additionally needs #246 (can land behind a guard if #251 ships
first).
