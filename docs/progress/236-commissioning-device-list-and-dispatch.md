# 236 — Commissioning Cohort: the device list belongs on the page, and it should be actionable

**Completed 2026-08-13.** Frontend-only (admin). Frozen completion record — corrections go to
INDEX / SYSTEM-STATE, not here.

Issue: `.scratch/fsm-platform-v1/issues/236-commissioning-device-list-and-dispatch.md`
Follow-up filed: `.scratch/fsm-platform-v1/issues/237-commissioning-failures-no-dispatch-path.md`

---

## What was wrong

A direct operator ask, verbatim in substance: the device list should be visible on the page with
filter/sort/dropdown, not one click away; the two half-width panels (`ReportGrid`) should not leave
"Install quality — worst never-online rate" cramped into half the 1440px shell; the resolution curve
did not look right; and the page should be interactive — after filtering, an admin should be able to
assign a device to an SE.

Four concrete problems followed from that: (1) #235 delivered drill-*through* only — the plant column
links away rather than the devices living on the page; (2) the curve/quality panels were paired
half-width; (3) the resolution curve — a *cumulative* series over hours — was drawn as a `BarList`
(stacked horizontal bars), which reads as five disconnected categories rather than one line
approaching an asymptote; (4) the page told a manager 138 fitments failed to report and offered no way
to act on any of them.

## The "assign to SE" design question — settled before writing code

There is no "assign a device to an SE" primitive in this platform. Engineers are dispatched against
**tickets** (`apiAssignTicket` → `POST /api/schedules/assign`) or given **plants** as territory
(`POST /api/schedules/assign-plants`). Asked the operator directly rather than guessing; chosen:
**assign the device's open ticket**, the same primitive `CriticalQueue.tsx`'s one-click assign already
uses, so schedules, batches, audit rows, notifications and Shared-Pool exit behave identically. Frontend
-only — `DeviceListRow` already carries `openTicketId`/`assignmentState`/`assignedSeName`.

Rejected: plant-level assignment (selecting a few failed devices would hand the SE every device at
their plants, most of them fine) and a new `COMMISSIONING_FAILED` ticket origin (the operationally
correct shape, but a new ticket type with SLA/priority/dedup rules to settle — its own issue, filed as
#237 once the page made the size of the gap measurable).

**The known gap is shown, not papered over.** A device that was fitted and simply never reported may
have no open ticket at all — nothing owns it, so nothing can be assigned. Those rows read "No open
ticket" and offer no control, rather than a button that silently no-ops.

## Deliberate departure from the UI reference, recorded

`docs/ui/desktop/v2-reference/21-reports.png` pairs panels half-width, which is what #232 built and
why. This issue overrides that pairing **for this page only**, on direct operator instruction — nothing
else about the reference is relaxed (header, scope-chip band, KPI strip, card chrome, table and
empty-state primitives are unchanged). The reference itself carries a first-class "Assign SE" action in
its top bar, so an actionable reports surface is consistent with the design language even though the
reference's own Reports page has no device list.

## What changed

| File | Change |
|---|---|
| `src/pages/reports/CommissioningCohortPage.tsx` | Curve → `TrendChart` (was `BarList`); `ReportGrid` pairing dropped, both panels full-width; new device list section (search/sort/status/paging via `apiDeviceList`); plant rows gain a "Filter list ↓" in-place filter alongside the existing `#235` `<Link>`; new `DeviceAssignControl` |
| `test/commissioning-cohort.test.tsx` | +18 tests (26 total, was 18 for #232/#233/#234/#235); 2 pre-existing test doubles extended with `/devices` + `/schedules/engineers` fixtures so the page's new fetches don't break unrelated assertions |

**No backend change. No new endpoint, no schema change, no new ticket type.** Composes entirely from
endpoints and primitives that already existed: `GET /api/devices` (already supported `search`, `sort`,
`status`, `plantId`, `commissionedWithinDays`, paging — built for #235's drill-through target,
Device Detail), `GET /api/schedules/engineers`, `POST /api/schedules/assign`.

Three implementation decisions worth not re-litigating:

- **jsdom cannot render recharts' SVG** (confirmed live: `ResponsiveContainer` mounts a 0×0 wrapper div
  and draws nothing, per this repo's own `test/setup.ts` comment). The curve test asserts the library
  boundary instead — `.recharts-responsive-container` present, `<ul>` (BarList's markup) absent — which
  is the actual thing under test (uses TrendChart, not BarList), not a rendered-pixel check that jsdom
  cannot make anyway.
- **The device list does NOT carry the cohort's `population` filter (operational vs all).** The AC as
  originally filed asked for it; `GET /api/devices` has no such predicate — that concept lives only in
  the commissioning aggregation SQL (#233). Reconciling would mean a second, independent definition of
  "operational" living in the browser, exactly the defect class #232–234 exist to prevent. The device
  list is scoped by window (`commissionedWithinDays`) only, and a caption says so next to the table
  rather than leaving a reader to discover it by reconciling counts that will not match.
- **The plant "Filter list ↓" button is a SEPARATE affordance from #235's `<Link>`, not a replacement.**
  The link still navigates to Device Detail unchanged; the button narrows this page's own table in
  place and scrolls to it. Both are tested independently so a future edit to one cannot silently break
  the other.

## How it was tested

Red-green per slice (curve/layout → device list → assign), following the repo's TDD convention, in the
existing `commissioning-cohort.test.tsx` idiom — assertions about honesty (a scoped-by-window caption,
a no-ticket row offering no control) alongside behavior (server-side filtering, not client-side).

| Lane | Result |
|---|---|
| `test/commissioning-cohort.test.tsx` | 26 passed (was 18) |
| Full admin suite | 472/473 — one pre-existing flake in `se-activity-drilldown.test.tsx` (unrelated file, not touched by this issue), confirmed passing in isolation both **before** this change (`git stash`) and **after** it |
| `tsc --noEmit` | clean |

**Also exercised for real, against the live dev backend** (`fsm` @ localhost:5433, started via
`npm start` / `npm run dev`): `POST /api/auth/login` as `ops.head@fsm.test` → 200; `GET /api/devices?
commissionedWithinDays=90&status=NEVER_REPORTED` → 573 matching devices server-side, 200 returned on
one page, 79 (40%) with no open ticket. That query is also where #237's numbers came from.

## Not done

- **The browser pass.** The Chrome extension (`claude-in-chrome`) could not reach `localhost` this
  session: every navigation to `:5173` and `:5174` returned "Frame with ID 0 is showing error page,"
  reproduced across two ports, a fresh tab, and a permission-grant retry — while the same extension
  screenshotted an external site (`example.com`) without issue. `curl` independently confirmed both
  servers were live and correct throughout (`:3000` login → 200; `:5174/login` → 200 with the compiled
  bundle). The operator chose to ship on the strength of the 26 tests + `tsc` clean + the code itself
  rather than keep debugging the extension. **Nobody has watched this page render.** This is the same
  gap #194 left open for the two prior commissioning pages (#232, #235) — SYSTEM-STATE already records
  that "not done," and it remains true for those two pages as well as this one.
- **#237 filed, not fixed.** The no-open-ticket gap this page surfaces (79 of 200 sampled
  never-reported devices) is a product/backend decision, out of this issue's scope by design (see
  "assign to SE" above).
- **The `visual/baseline/` re-capture** is still stale since 2026-07-28 and was never in scope for this
  issue (operator-eyeball gate, explicitly non-goal).
