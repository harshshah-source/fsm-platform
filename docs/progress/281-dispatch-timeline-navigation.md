# #281 — Make the dispatch timeline navigable as one concept (TDD completion report)

**Date:** 2026-08-24 · **Branch:** `feat/autoplant-integration` · **Type:** HITL · Admin (frontend only)
**Issue:** [`.scratch/fsm-platform-v1/issues/281-dispatch-timeline-navigation.md`](../../.scratch/fsm-platform-v1/issues/281-dispatch-timeline-navigation.md)
**Decision:** [#280](../../.scratch/fsm-platform-v1/issues/280-decision-dispatch-timeline-ia.md) — R1–R10
**Sequenced as:** P10 slice 2 of 2, behind #280 ✅ (Q1–Q3 ruled 2026-08-24).

> Frozen once written, per the progress convention. Corrections go to INDEX / SYSTEM-STATE.

## The constraint that shaped every decision

#280 R2 is a hard constraint, not a preference: *expressing the relationship must not collapse the
questions.* A single merged page, or anything that reads like one, would be a **worse** defect than the
fragmentation this issue fixes, because it would teach an operator that a preview is a commitment. That
is not a failure a passing test suite catches, so it was designed against first and asserted second —
every cross-view test in this change carries a negative assertion beside its positive one.

R8 then ruled the mechanism: contextual per-record links, explicitly **not** a shared date-anchored
switcher (Schedules and Dispatch Runs are not single-date views, so a switcher would mean restructuring
two pages' data shape — out of scope per R6) and **not** a tab strip (which visually asserts the three
views are interchangeable slides of one dataset).

## Two things found while implementing that changed the shape of the work

### 1. `PageHeader` renders screen-reader-only — so "the page says what it is" was never true

AC2 asks each surface to carry, *on the surface itself*, which question it answers. Every one of these
four pages already had a subtitle saying roughly that. It reaches nobody: `components/data/PageHeader`
was reduced to an `sr-only` heading block (the boxed banner was removed because the breadcrumb already
names the page), and only `actions` render visibly.

This is also why `DispatchBatchDetailPage` was worse than the audit recorded. The audit's finding was
that `seName` / `plantName` / `ticketId` were *rendered but not linked*. In fact the batch's engineer
and plant were rendered visibly **nowhere** except as a value repeated on every one of the table's
rows — the page title carrying them (`${seName} · ${plantName}`) is invisible. So AC6's "one action"
needed a visible identity block before it could need a link, and that block is now the page's only
visible title.

### 2. The projection payload carries ids only

`SchedulerPreviewResult` has `seId`, `plantId`, `zoneId` and ticket ids — no names anywhere, which is
why D2 exists at all. AC14 forbids a new endpoint, so the names come from three reads that already
exist and are **already gated to exactly the manager roles that can open this page**:

| Read | Gives | Scope |
|---|---|---|
| `GET /schedules/engineers` | `engineerId` → name | ZM own-zone, CSM/OH all |
| `GET /planner/plants` | `plantId` → plant code | ZM own-zone, CSM/OH all |
| `GET /dashboard/operating-mode` | `zoneId` → zone name | ZM own-zone (clamped), CSM/OH all |

All three are best-effort and independent: a failure sets no names and the projection still renders with
`name ?? id` (#277's `PlannerPage` pattern), because the plan is the primary content and a name lookup
is not worth a page error. `asMap` also guards `Array.isArray` — a backend serving a non-list body under
a 200 must cost the names, never throw inside a render.

That AC12 holds here is a property of *which* reads were chosen, not an assertion: none of the three
widens anyone's reach, because each is clamped server-side by the same rule as the page itself.

## What landed, slice by slice

### AC1/AC2/AC12 — the Dispatch cluster

`buildNav` gained a `Dispatch` `NavGroup`, which is literally what AC1 asked for ("the same pattern the
Settings console already uses for its named groups" — a grouped rail, not a nested control). Order is
the timeline: **Scheduler Preview → Schedules → *(indented)* Intra-day Queue → Dispatch Runs.**

`NavLink` gained exactly two optional presentational fields:

- `hint?: string` — the question the destination answers, rendered as visible copy under the label in
  `Sidebar.tsx`. Visible, not a tooltip: AC2's test is that a new ZM can rank the four nouns *without
  opening them*, and a hover affordance fails that on a first read. Only the Dispatch cluster carries
  hints; a second line on all twenty rows would be noise, not ranking.
- `indent?: boolean` — #280 R9's subordination, and the smallest of the three treatments R9 itself
  names (divider / indent / copy). Position carries half the meaning (immediately after Schedules, not
  at the end of the tense sequence); the indent carries the other half; the copy —
  *"Changes to today's plan"* — says it in words.

The four links **left** the eighteen-row OPERATIONS group the navigation-IA audit complained about,
which is asserted directly rather than inferred from the new group's existence.

Every existing nav test reads `buildNav(role).flatMap(g => g.items)`, so moving links between groups was
invisible to all of them — which is the evidence for AC12 that matters more than the new assertions.

### AC2/AC3/AC8 — `DispatchTimelineNote`

One shared component, on all four surfaces, **prose and not a control**:

- the current view is never rendered as one of the choices (a tab strip's defining behaviour);
- each sibling link is labelled with the **question** it moves to — "what past runs did" — not with a
  page name, so following one is a decision about what you want to know;
- each page states its own question *in full*, including what it is not: Preview says nothing here is
  committed and the run re-evaluates at dispatch; Dispatch Runs says read-only, a record and not a plan
  you can edit; Intra-day says it is not a run of its own.

It occupies the same slot reference `12-batch-schedule-review.png` already uses for its advisory banner
(directly under the title, above the KPI strip), so this is not an invented layout — checked against the
reference image before it was written, per the surfacing rule.

R8's actual ruled mechanism landed beside it, per record and in both directions:

| From | Link | To |
|---|---|---|
| Schedules row | "What the next run would do →" | `/schedules/preview?date=<tomorrow>&se=<seId>` |
| Preview, selected SE | "See what is actually committed for them today →" | `/schedules/:seId` |
| Day-plan stop | "Why dispatch chose this →" | `/batches/:batchId` |
| Intra-day row, SE | the SE's name | `/schedules/:seId` |
| Batch identity | "See the day plan this batch produced →" | `/schedules/:seId` |

`?date=` / `?se=` on Scheduler Preview is what makes the first row possible at all: R8 verified the page
was single-date scoped in **local state, never a URL param**, so a projection was not addressable. It is
now, with `replace` history (the `?tab=` convention the Settings console uses) so moving around inside
one projection does not have to be unwound a step at a time.

### AC6/AC7 — the chain terminus (#280 R10)

`seName` → `/schedules/:seId` is the primary action and is placed first. `plantName` →
`/reports/device?plantId=` (R10's approved expansion beyond Q3's three options). Each row's device cell
→ `/tickets/:ticketId`, with `exportValue` set so the download keeps carrying the value rather than an
element's incidental text, and `stopPropagation` so the link does not also expand the trace row.

`seName` and `plantName` are linked **once, in the identity block**, not on all N rows: those columns
repeat one batch-level fact per row (a batch is one SE at one plant), and AC7 names the per-row
requirement for `ticketId` only.

`ZoneUnassignableTable` got the same ticket link. It was not in the issue's list, but it is on the same
drill-down and was the one remaining identifier with a live destination left inert — AC7's own rule.

### AC9 (D1) — fixed as a class, not as a case

The collision is generic: `/^\/schedules\/([^/]+)$/` matched `/schedules/preview` before the nav table
was consulted, so the projection announced itself as *Schedules › Schedule Detail* — the committed day
plan for an engineer named "preview", which is the R2 error in miniature.

The guard is **a literal nav route always beats a param pattern that would also match it**, checked
before `DETAIL_CRUMBS`, mirroring the ordering guard `AppRoutes.tsx` already carries with a comment
saying so. Any literal added under an existing `:param` route is covered from the moment it enters
`buildNav`. `test/breadcrumb.test.tsx` gained a `LITERALS_UNDER_PARAM_ROUTES` table a future one is
meant to be added to, plus a case pinning that a real engineer id under `/schedules` still resolves to
the detail crumb.

### AC10 (D2) — and one thing the audit did not list

Engineer, plant and zone now read as names. `formatPlantDisplayName` is used (it was used zero times
here). Projected ticket ids became links carrying the **full** id in their accessible name and `title`,
because a truncated uuid is not something an operator can act on.

The audit did not list it, but the same panel rendered `Mode {selected.zone.mode}` — the raw `DEFICIT` /
`PREVENTIVE` enum, against Issue 136's explicit vocabulary rule that the enum never leaves
`utils/operatingModeCopy.ts`. It could not borrow a whole `ZoneOperatingMode` row, because the mode the
*projection ran under* is not necessarily the live mode that endpoint reports. So that module gained a
two-line `operatingModeLabel(mode)` and the page renders "Catch-up" / "Steady" through it — the enum
still never leaves the module that owns the translation.

### AC11 (D3) — the catch-all

`pages/NotFoundPage.tsx`, routed at `path="*"` declared **last and inside** the shell layout route. That
placement is the whole point: outside the shell it would be a prettier dead end; inside it, the operator
keeps the navigation they need to recover. The unresolved path is echoed verbatim, because the common
cause is a typo or a truncated pasted link and an operator who cannot see what the browser actually
asked for cannot tell that apart from a retired page.

## Tests

| File | Covers |
|---|---|
| `test/dispatch-timeline-nav.test.tsx` *(new)* | AC1/AC2/AC12 — grouping, timeline order, Intra-day subordination, hints, role reach unchanged, and one rendered case proving the cluster reaches the screen |
| `test/dispatch-cross-view-links.test.tsx` *(new)* | AC2/AC3/AC8 on Schedules / Dispatch Runs / Intra-day / day plan — including the negatives: no `tab` role, the current view never offered as a choice, Intra-day's tense is not future/present/past |
| `test/not-found-route.test.tsx` *(new)* | AC11 — shell present, message, way back, path echoed, real routes not swallowed |
| `test/breadcrumb.test.tsx` | AC9 — `/schedules/preview` gets its own crumb; a real engineer id still resolves to the detail crumb; the literal-under-param table |
| `test/dispatch-batch-detail.test.tsx` | AC6/AC7 — day plan in one action, plant link, per-row ticket links; AC3/AC5 (no buttons on the identity block, copy says record-not-plan); the null-name degradation |
| `test/scheduler-preview-page.test.tsx` | AC10 — names in rail and detail, plant/zone names, plain-language mode, total-lookup-failure fallback, ticket link; AC8 — the committed-plan link and `?date=`/`?se=` addressability |

The preview tests needed rewiring for a router and for routed lookup mocks: they previously rendered the
page bare with a catch-all `fetch` mock, which would have answered each new lookup with the preview body.

**Full admin suite: 109 files / 604 tests, 0 failed.** `tsc --noEmit` clean. The one reported error is
the pre-existing, unrelated `TicketDetailDrawer.tsx:440` runtime fault (`attempts.attempts` undefined),
confirmed still present with those files unmodified — the same fault the last four session-log entries
record.

## What was deliberately not done

- **No shared switcher and no tab strip** (#280 R8) — see the constraint above.
- **`/assign` untouched** (#280 R7 / AC13) — no file under `pages/assign/` is in this change.
- **No new endpoint, no backend change** (AC14) — every read used already existed.
- **`plantName` / `seName` not linked per row** on the batch table — one batch-level fact repeated N
  times; AC7's per-row requirement is `ticketId`.
- **No approved design requested** — #280 R8 settled that cross-links are additions to existing page
  furniture, and the one new shared element sits in a slot reference 12 already uses.
