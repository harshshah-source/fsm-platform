# 236 — Commissioning Cohort: the device list belongs on the page, and it should be actionable

Status: done
Type: AFK · Admin UI · Frontend-only

> **Done 2026-08-13** — full-width panels, the resolution curve redrawn as a real line chart, a
> server-driven device list with search/sort/status/paging inline on the page, plant rows filtering it
> in place, and per-row Assign SE against the device's open ticket. 26 tests (frontend-only, no
> backend change), `tsc` clean, admin suite 473/473 net (one pre-existing flake in an unrelated file,
> confirmed passing in isolation both before and after this change). Full record:
> `docs/progress/236-commissioning-device-list-and-dispatch.md`.
>
> **Not done: the browser pass.** The Chrome extension could not reach `localhost` this session
> ("Frame with ID 0 is showing error page" on every navigation attempt, on two different ports, across
> a fresh tab and a permission-grant retry) while confirming it worked fine against an external site.
> `curl` confirms both the backend (`:3000`, `POST /api/auth/login` → 200) and the admin dev server
> (`:5174`, `GET /login` → 200 with the compiled bundle) are live and correct. Nobody has watched this
> page render. Same gap #194 left open for the two prior commissioning pages — recorded there as
> "Not done" too, and still true for those.

Filed 2026-08-13 from a direct operator ask, after [#194](./194-no-dev-login-seed-path.md) made it
possible to open the page in a browser for the first time. Extends
[#232](./232-commissioning-admin-surface.md) / [#235](./235-commissioning-drillthrough.md); does not
reopen them — both are done and their reports are frozen.

## The ask, verbatim in substance

> The device list should be visible with filter, sort and dropdown, and the table should not be half
> the page like "Install quality — worst never-online rate" — it should be the complete page. And the
> graphs you drew are not looking good. And make it interactive: after applying sort and filter, an
> admin can assign the device to an SE.

## What is wrong with the page today

1. **The devices are one click away, not on the page.** #235 delivered drill-*through*: the plant
   column links to `/reports/device?plantId=…&commissionedWithinDays=…`. That answers "which devices"
   only if you leave. The operator's mental model is that the cohort *is* a list of devices, and the
   aggregates are its summary — not the other way round.
2. **The two panels are half-width.** `ReportGrid` puts "How fast this cohort came online" beside
   "Install quality — worst never-online rate". Install quality is a 6-column table squeezed into half
   a 1440px page; it renders cramped and its columns fight for width.
3. **The resolution curve is drawn as a `BarList`.** It is a *cumulative* series over hours — a curve.
   Drawing it as stacked horizontal bars was the wrong primitive: it reads as five unrelated
   categories rather than one line approaching an asymptote, and the shape (how fast it flattens, and
   what it flattens *at*) is the whole point.
4. **The page is inert.** It tells a manager 138 fitments failed to report and offers no way to act on
   any of them.

## Design decision — what "assign to SE" means here

**Settled with the operator at filing.** There is no "assign a device to an SE" primitive in this
platform, and inventing one was rejected. Engineers are dispatched against **tickets**
(`apiAssignTicket` → `POST /api/schedules/assign`, the same primitive as the Critical-Queue one-click
and ZM same-day ADD) or given **plants** as territory (`POST /api/schedules/assign-plants`).

Chosen: **assign the device's open ticket.** `DeviceListRow` already carries `openTicketId`,
`assignmentState`, `assignedSeName` and `assignedSeId`, so this is frontend-only and inherits
schedules, batches, audit rows, notifications and Shared-Pool exit behaviour unchanged.

**The known gap is to be shown, not papered over.** A device fitted that simply never reported may
have **no open ticket** at all — measured at 79 of a 200-row sample once the page could query real
data (see the follow-up below; #237). Those rows must read "no open ticket" rather than offering a
control that silently does nothing. Rejected
alternatives: plant-level assignment (selecting three failed devices would assign the SE all ~500
devices at their plants) and a new `COMMISSIONING_FAILED` ticket origin (correct shape, but a new
ticket type with SLA / priority / dedup rules to settle — its own issue, see follow-up below).

## Departure from the UI reference — deliberate, and recorded

`docs/ui/desktop/v2-reference/21-reports.png` shows paired half-width panels, which is what #232 built
and why. This issue overrides that pairing **for this page only**, on a direct operator instruction.
Nothing else about the reference is being relaxed: the header, scope-chip band, KPI strip, card
chrome, table and empty-state primitives stay as they are. Worth noting the reference carries a
first-class **"Assign SE"** action in its top bar, so an actionable reports surface is consistent with
the design language even though the reference's own Reports page has no device list.

## Acceptance criteria

- [x] The cohort's **devices are listed on `/reports/commissioning`**, scoped to the same **window**
      as the page's aggregates (`commissionedWithinDays`). **Correction made during implementation:**
      the AC as originally filed also asked for population scoping (operational vs all/warehouse). It
      does not — `GET /api/devices` has no population predicate; that concept lives only in the
      commissioning aggregation SQL (#233). Reconciling would mean inventing a second, independent
      definition of "operational" in the browser, which is the exact defect class #232–234 exist to
      prevent. The device list is scoped by window only, and this is **stated on the page** next to
      the table rather than left for a reader to discover by reconciling counts that do not match.
      Grain (fitments vs devices) is stated too, reusing the existing note's wording.
- [x] The list carries **search, sort and status filters, and paging**, driven server-side by the
      existing `GET /api/devices` (`search`, `sort`, `status`, `plantId`, `commissionedWithinDays`,
      `limit`/`offset`). **Nothing is recomputed in the browser** — the #232 rule stands.
- [x] Clicking a plant row **filters the device list in place** rather than navigating away. The
      existing drill-through link to `/reports/device` remains valid and is not removed.
- [x] **Panels are full-width.** "Install quality" gets the whole page rather than half of it.
- [x] The resolution curve is drawn as a **curve**, not a bar list. It must still state its basis
      (gradeable / pre-epoch-excluded / too-young) — that caption is correctness, not decoration.
- [x] A row with an `openTicketId` offers **Assign SE**, listing the live roster with activity/load,
      and posting through `apiAssignTicket`. The list refreshes so the assignment column is truthful.
- [x] A row **without** an open ticket says so plainly and offers no assign control.
- [x] A ZM stays clamped to their zone — the existing server-side clamp plus the scope chip.
      *Inherited, not independently coded*: the device list issues no `zoneId` param and relies on the
      same guard-level `RequestActor` clamp every other reports page already depends on. Not
      independently browser-verified this session — see the "Not done" note above.
- [x] Tests over the honesty properties, in the `commissioning-cohort.test.tsx` idiom: the no-ticket
      row, the assign round-trip, the filter/sort/paging query being handed to the API rather than
      applied client-side. *26 tests, all frontend, no backend change.*

## Explicit non-goals

- Not a backend change. No new endpoint, no new ticket type, no schema change.
- Not a change to the cohort's population predicate, the "came online" definition, the 90-day ceiling
  or the installer-ranking rule — #232/#233/#234's decisions all stand.
- Not re-capturing `visual/baseline/` (operator-eyeball gate, still stale since 2026-07-28).

## Follow-up this exposes

**Devices that failed to commission and have no open ticket are invisible to dispatch.** They cannot be
assigned because nothing owns them. Filed as **#237**, with a real number measured against the live
dev DB while this page was being built (not through the UI — the browser pass was blocked, see above;
measured directly against the running backend): of a 200-row sample of devices `NEVER_REPORTED` within
the last 90 days, **79 (40%) carry no open ticket at all**. 573 such devices exist server-side in
total; the sample is a lower bound, not a census. **Correction while filing #237:** the mechanism to
investigate is `TicketCreationService.createForInactiveEligible`, not #229's auto-recovery — #229 only
*closes* tickets (re-checks staleness on already-open ones); it creates nothing. That misattribution
was caught before filing, not after — see #237 for the corrected framing.
