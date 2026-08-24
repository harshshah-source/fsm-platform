# 281 — Make the dispatch timeline navigable as one concept (executes #280 / audit F6)

Status: **`ready-for-agent`** — #280 Q1–Q3 are ruled (R8–R10, approved 2026-08-24). Q1's answer (R8)
confirms no approved design is required: the ruled cross-view control is contextual per-record links,
which are additions to existing page furniture, not a new layout. **Not yet started** — this update is
bookkeeping only; see the note at the end of this section.
Type: HITL · Admin (frontend-only)
Decision: [#280](./280-decision-dispatch-timeline-ia.md) — R1–R10
Source: `audit/navigation-ia-audit-2026-08-19.md` **F6 (HIGH)** and §2.5 "Two concrete defects";
`audit/frontend-ux-audit-2026-08-19.md` finding **10**.

**Implementation has not begun.** The product-direction blockers (#280 Q1–Q3) are resolved, and the
acceptance criteria below have been reconciled against R8–R10 (wording-only changes, listed inline).
Starting the build is a separate, still-pending operator go-ahead — this record does not itself
authorize it. #280 Q4 (whether to commit the two source audits) remains open and is unrelated to this
issue's readiness.

## Current behaviour (verified 2026-08-24 against the working tree)

- `nav.ts:91-95` renders **Schedules**, **Scheduler Preview**, **Dispatch Runs** as three adjacent
  flat rows inside one eighteen-link OPERATIONS group; **Intra-day Queue** follows. Nothing in the
  navigation says they are related.
- The relationship is stated only in a source docblock (`SchedulerPreviewPage.tsx`: *"the post-dispatch
  twin of this one … so the two read as one workflow rather than two designs"*), which no operator sees.
- **The drill-down chain dead-ends at Batch.** Routes `/dispatch-runs` → `/dispatch-runs/:runId` →
  `/dispatch-runs/:runId/zones/:zoneId` → `/batches/:batchId` all exist
  (`AppRoutes.tsx:120,128,136,146`). `DispatchBatchDetailPage` renders `detail.seName` (`:90,:135`),
  `detail.plantName` (`:89,:135`) and every `r.ticketId` (`:62,:150`) — **none linked**. Its only two
  links point upward (`/dispatch-runs/:runId`, `/dispatch-runs`). `/schedules/:engineerId`
  (`AppRoutes.tsx:110`) renders the day plan that batch produced and nothing in the dispatch chain
  reaches it — grepped across `pages/dispatch/`.

### Supporting defects on the same surface (audit §2.5, re-verified)

- **D1 — breadcrumb collision.** `breadcrumb.ts:50` matches `/^\/schedules\/([^/]+)$/` before the nav
  table, and that pattern matches `/schedules/preview`. Verified `true`. Scheduler Preview therefore
  renders **`Dashboard › Schedules › Schedule Detail`**. `AppRoutes.tsx` guards this exact
  literal-vs-param collision in its route ordering *with a comment saying so*; the breadcrumb resolver
  does not. `test/breadcrumb.test.tsx` contains **zero** cases for `/schedules/preview`.
- **D2 — raw identifiers on Scheduler Preview.** `SchedulerPreviewPage.tsx` renders
  `row.seId.slice(0, 8)` (`:263`), `selected.entry.seId.slice(0, 8)` (`:279`),
  `Zone {selected.zone.zoneId}` (`:281`), `Plant {stop.plantId}` (`:290`) and truncated ticket ids
  (`:304`, `:336`). It uses `formatPlantDisplayName` **zero** times. This is the same defect #277
  fixed on `PlannerPage` (`eng.name ?? eng.engineerId`) and that the intra-day modal was built to
  avoid — still live one page away, on a screen whose entire purpose is letting a human read a plan.
- **D3 — no catch-all route.** `AppRoutes.tsx` has no `path="*"`. A mistyped or retired URL matches
  nothing, so the pathless layout route never renders: no shell, no message, no way back except the
  browser's Back button.

## Intended outcome

An operator working the dispatch engine can tell what the four surfaces are, in what order they sit,
and can move between them without returning to the sidebar — **without** the three questions being
merged into one answer (#280 R2).

## Affected surfaces

`components/shell/nav.ts` · `components/shell/breadcrumb.ts` · `AppRoutes.tsx` ·
`pages/schedules/SchedulerPreviewPage.tsx` · `pages/schedules/SchedulesPage.tsx` ·
`pages/schedules/IntradayQueuePage.tsx` · `pages/dispatch/DispatchBatchDetailPage.tsx` and the
run/zone pages above it.

## Acceptance criteria

Navigation and grouping:

- [ ] AC1 — The sidebar expresses Preview / Schedules / Dispatch Runs and Intra-day Queue as one named
      **Dispatch** cluster rather than adjacent flat rows, in the same pattern the Settings console
      already uses for its named groups. Per **#280 R9**, Intra-day Queue is included in the cluster
      but presented as subordinate to Schedules — not a flat fourth peer alongside Preview/Schedules/
      Dispatch Runs.
- [ ] AC2 — Preview, Schedules and Dispatch Runs each carry, on the surface itself, which question
      they answer — future, present, or past. Intra-day Queue carries its own R9 framing — "changes to
      today's plan" — rather than a fourth co-equal tense label. A new ZM can rank the four dispatch
      nouns, and understand Intra-day's subordinate relationship to Schedules, without opening them.

Distinction preserved (#280 R2/R3 — the hard constraint):

- [ ] AC3 — Previewing a future run, viewing the current/latest committed result, and inspecting a
      historical run remain **three distinct answers**. No screen presents a projection as a
      commitment or a committed plan as editable history. This applies to the R8 cross-view links too:
      a link may move the operator between views, but must never make one view look like another.
- [ ] AC4 — Scheduler Preview still renders its as-of-recompute caveat with the real watermark, and
      still makes no claim that its ordering is what dispatch will produce (#251 AC6 unchanged).
- [ ] AC5 — Dispatch Runs remains read-only; nothing added here makes a historical run appear
      mutable.

The `Run → Zone → Batch` chain (#280 R4):

- [ ] AC6 — From a batch, the operator reaches the SE day plan that batch produced (`seName` →
      `/schedules/:engineerId`) in **one action** — a direct link, not a re-navigate-and-search — per
      **#280 R10**. This is the primary link on the page.
- [ ] AC7 — Per **#280 R10**, every identifier the chain displays that has a live destination is
      linked, not left inert: `seName` → `/schedules/:engineerId` (AC6, primary), each `ticketId` →
      `/tickets/:ticketId` (per row), and `plantName` → `/reports/device?plantId=` (R10's explicitly
      approved addition beyond Q3's original three options).

Cross-view movement (#280 R5):

- [ ] AC8 — From any one of the four views the operator can reach the others; each path states which
      question it is moving to. Per **#280 R8**, this is **contextual, per-record links** — where a
      view renders a specific SE, day, or run, it links to the corresponding record on its sibling
      view(s). Explicitly not a shared date-anchored switcher (Schedules and Dispatch Runs are not
      single-date views today) and not a tab-like control (would visually assert the three views are
      interchangeable, contradicting AC3/R2).

Supporting defects:

- [ ] AC9 — `/schedules/preview` renders its own breadcrumb, not `Schedule Detail`. A regression test
      in `test/breadcrumb.test.tsx` pins it, and the resolver is guarded against the literal-vs-param
      collision the way `AppRoutes.tsx` already guards its route ordering. (D1)
- [ ] AC10 — Scheduler Preview shows engineer and plant **names**, with the id as a fallback that
      does not crash when the name is null — the `PlannerPage` pattern from #277. No bare or
      truncated UUID is presented as a user-facing identifier. (D2)
- [ ] AC11 — A mistyped or retired admin URL renders the shell with a "not found" message and a way
      back, rather than a blank page. (D3)

Non-regression:

- [ ] AC12 — No role's reach changes. Every route keeps its current role gate; the Dispatch grouping
      is presentational (#280 R6).
- [ ] AC13 — `/assign` and the P9 Assign Work Console are untouched (#280 R7). Manual assignment is
      not folded into the dispatch timeline.
- [ ] AC14 — No dispatch, scheduling, holds or recommender behaviour changes. Frontend and
      navigation only; no new endpoint.

## Tests

- `test/breadcrumb.test.tsx` — `/schedules/preview` resolves to its own crumb (AC9); a case per
  literal-under-param route so the next one cannot regress silently.
- Scheduler Preview render test — names shown, null-name falls back to the id without crashing (AC10).
- A route test for the catch-all: unknown path renders the shell + message, not a blank document (AC11).
- Batch → day-plan / ticket-drawer / plant-detail navigation test (AC6/AC7).
- Cross-view contextual-link test — a link from one view lands on the correct sibling record and is
  labeled with the question it moves to (AC8); does not exercise a switcher or tab control, since R8
  rules those out.
- Nav visibility tests per role, unchanged expectations (AC12).

## Risks / rollback

Presentational and frontend-only, so the blast radius is the sidebar and a set of links; rollback is
reverting the commit. The genuine risk is **AC3**: an implementation that unifies too eagerly and
teaches an operator that a preview is a plan. That failure is not caught by a passing test suite —
it is caught by reading #280 R2 before starting.

## UI surfaces

Admin: the Dispatch navigation cluster; Scheduler Preview; Schedules; Dispatch Runs (+ run/zone/batch
detail); Intra-day Queue, included per #280 R9 (subordinate to Schedules, not a flat peer). Mobile: n/a.

## Reference

**No v2 reference image and no approved design covers this screen set — and per #280 R8, none is
required.** `docs/ui/desktop/v2-reference/12-batch-schedule-review.png` covers the Schedules page
only; there is no image for Scheduler Preview or the Dispatch Runs ledger, and
`docs/ui/desktop/approved-designs/` holds only `assign-work-console.html`. R8 rules that the cross-view
control is contextual per-record links — additions to each page's existing furniture, not a new
layout — so this is not a parity-gate blocker for #281. An approved design would still be needed if a
future revision chose a genuinely new layout (e.g. a persistent switcher), but that is not what R8
ruled.

## Blocked by

Nothing. #280 Q1–Q3 are ruled (R8–R10, approved 2026-08-24): Q1 — contextual per-record links; Q2 —
Intra-day joins the Dispatch cluster, subordinate to Schedules; Q3 — the chain terminates at both the
SE day plan and the ticket drawer, plus a linked `plantName`. Every destination this issue links to
already exists and is already role-gated (AC12). **#280 Q4** (whether to commit the two source audits)
remains open but is a documentation matter unrelated to this issue's readiness.
