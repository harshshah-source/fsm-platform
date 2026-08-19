# #251 — Admin Scheduler Preview: projection, stale-token safety, pre-run holds

**Done 2026-08-19.** Backend + Admin — one vertical slice. Built on #250's dry-run seam; the last
issue in the preview track.

## The shape of the decision

Approved Decision 1/18: the admin sees what the next run would do and may place holds, but **admin
approval is never required**. Inaction means the 05:00 run proceeds exactly as if nobody looked, and
manual runs keep working. That single sentence determines almost everything here — there is no
Approve button, no countdown, no submit, and the page says so outright rather than leaving an
operator to infer it from a missing control.

**Why holds are the only pre-run change.** They are the only one the current data model expresses.
`tickets.deferred_until` already exists and is already read by every unassigned-work reader through
`notDeferredOn`. Anything richer — "move this ticket to another SE before the run" — would invent
pre-run assignment state the run would then have to honour, which is a second scheduling authority:
exactly what Decision 1/18 refuses.

**Why holds needed a new writer at all.** The existing hold writer, `DEFER_TICKET`, requires a live
`batch_assignment_tickets` row — it defers work *off a day plan*. An undispatched ticket has no such
row, so before this an unassigned ticket simply could not be held. This is that missing write: a
bare, audited `deferred_until` on an OPEN + UNASSIGNED ticket.

## UI discovery — a correction to the issue's own Reference section

The issue states *"No v2-reference image exists for this new surface"* and points at
`BulkUnassignPage`. That is true of a *preview* page, but the discovery step turned up
**`docs/ui/desktop/v2-reference/12-batch-schedule-review.png`**, which is the authoritative reference
for exactly the data shape this page renders, and a much closer precedent:

- master-detail — a left rail of SE cards (id, zone, date range, "N plants · N tickets", critical+
  count, review state) feeding a right panel of numbered plant stops with ticket rows carrying
  work-type and severity badges;
- a KPI strip above;
- and its framing sentence is this page's policy seen from the other side: *"auto-dispatched into
  each SE Day Plan… override post-hoc — there is no pre-dispatch approval gate."*

Reference 12 is the **post**-dispatch twin of this page. Matching its layout is what makes the two
read as one workflow instead of two designs, so that is what was built — no novel visual language,
using the design-system components the shipped `SchedulesPage` already uses.

## What was built

### 1. `scheduling/preview-token.ts` (AC-5)

#179's HMAC token lifted out of `bulk-unassign.service.ts` (it was module-private) and generalised:
each consumer supplies its own payload type, the module owns the envelope (`iat`/`exp`), the
signature, and the constant-time compare. A security primitive that gets copied is one that drifts —
two copies would eventually mean two TTLs and two notions of "stale".

Deliberately not a JWT: no algorithm field to confuse and no third-party parser, so the `alg: none`
class of mistake is unavailable by construction. Every rejection path returns `null` rather than a
reason, because operationally they all mean "get a fresh preview" and distinguishing them would tell
a forger which half they got wrong.

Bulk-unassign now consumes it. Its four existing e2e specs are the pin that behaviour did not change.

### 2. `ZoneProjection` carries the run tallies

`previewActiveZones` returns projections, not summaries, so the counts lived on `RunSummary` and were
dropped. Two of them cannot be re-derived client-side at all: `withheldBelowThreshold` has no
per-ticket decision behind it (that is the whole point of #238's distinction — withheld means the
engine deliberately did not look), and `mode` decides whether the Install backlog appears.

Additive, so #250's five tests are unaffected. **Landed in this commit rather than amended into
#250's**, because #251 is what needs it.

### 3. `SchedulerPreviewService` + three endpoints

`GET /api/schedules/preview?date=D` · `POST /api/schedules/holds` · `POST /api/schedules/holds/release`,
all manager-roled, all declared before `:engineerId` so the literal paths are not captured by the
param route (the constraint `schedules-route-conflicts.e2e-spec.ts` pins).

`checkStaleness` compares the signed per-zone counts against a fresh projection. Unlike
bulk-unassign's token this one guards a **display**, not a mutation — the scheduler preview never
executes anything, so its job is to tell the admin the plan on screen is no longer the plan.

### 4. The page + nav

`/schedules/preview`, nav for all three manager roles (a ZM's projection is zone-clamped server-side,
so no extra nav gating). Date picker defaulting to tomorrow, KPI strip, SE rail → plant stops →
ticket rows, holds-in-force list with release, and the as-of caveat.

## The two sharp edges, both pinned

**`deferred_until` is inclusive.** `notDeferredOn(day)` admits `deferred_until <= day`, so a ticket
held "until D" **is** dispatchable on D. Holding it off D means naming D+1. The page therefore sends
the day *after* the previewed date, and that arithmetic is asserted directly — an off-by-one here
produces a hold that visibly does nothing, which is the worst kind of bug on this surface because it
looks like it worked. Re-verified by removing the `+1` and watching the test fail.

**A hold must never silently overwrite a vehicle-return date (AC-4).** They are different concepts
sharing one column: a hold is an admin's scheduling preference; a return date is an operational fact
about a vehicle. The service refuses when the ticket carries an OPEN
`vehicle_unavailability_report`, returns the report's `expectedFrom` as context, and only proceeds on
explicit `confirm` — with `overrodeVehicleReport` recorded in the audit, since that is the one case
where this write destroys information.

**Narrower dependency than the issue claims.** #251 says the VU branch "additionally needs #246".
Checking the schema, `vehicle_unavailability_reports` already carries `status` and `expectedFrom`
today, so the *refusal* is fully implementable now — #246 only changes where the deferral itself
comes from. AC-4 therefore landed properly rather than behind a stub.

## A deliberate limitation

Read scope is built from claims as `{ role: user.role, zoneId: user.zone_id }` — the pattern every
other service in `schedules.controller.ts` uses. `common/manager-scope.ts` would be the better home,
but it is **untracked**, part of the pre-existing uncommitted acting-zone work; importing it would
either force unrelated uncommitted work into this commit (which the effort's handoff forbids) or
leave a broken one. Consequence: acting-as-zone is not honoured on this surface, consistent with the
rest of this controller as committed, and the acting-zone work will pick it up when it lands.

## Verification

- Backend: `scheduler-preview.e2e-spec.ts` 7/7 · `preview-token.spec.ts` 5/5; bulk-unassign's four
  e2e specs and `schedules-route-conflicts` green on the extraction.
- Admin: `scheduler-preview-page.test.tsx` 6/6; **full admin suite 99 files / 500 tests green**;
  `vite build` clean.
- Both apps `tsc --noEmit` clean.
- `schedules-route-conflicts.e2e-spec.ts` needed the new provider added to its hand-rolled module
  (the #141/#157 precedent for fixture provider lists) — a test-fixture update, not a code change.

## Risks / rollback

A read-only projection plus one audited date-column write — small blast radius. Holds are just dates
and are releasable from the page. Rollback: remove the endpoints, the page and the nav entry; the
extracted token module can stay (bulk-unassign consumes it either way).
