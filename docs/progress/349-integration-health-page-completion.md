# 349 — Integration Health page completion

**Done 2026-09-03.** Wave 2 of the module-gaps completion plan
(`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4), absorbing survey ids ING-02 (narrowed), ING-04,
ING-01's surfacing half and AC-10, and **closing #224** and **the health-page part of #129**. Red-first.
Depends on #348 (the freshness verdict the new sections display), closed.

## What it closes

The backend has computed source connectivity, both freshness ages, reconciliation and the #218
lifecycle check since those surfaces were built. The page rendered three cards, because
`api/integrationHealth.ts` modelled **four** of the payload's ten sections — and a section the client
type does not name is a section the page cannot draw. The result was an Integration Health page that
could not answer the one question it exists for: *is the pipeline working right now, and if not,
since when* — while the answer sat in the response it was already fetching.

Three specific drops:

- **Connectivity.** `IntegrationSourceHealth` distinguishes the two states an operator most needs
  apart — the pipeline is broken, versus the VPN to AutoPlant is down and the pipeline is fine. It
  was never rendered.
- **Freshness age.** `ageMinutes` was computed and, until #348, compared with nothing anywhere. #348
  added the verdict (`stale`) and its yardstick (`staleAfterMinutes`); nothing displayed either.
- **Lifecycle.** #218 shipped the contradiction check and #224 filed the missing screen for it on
  2026-08-07. The check could not catch anything an operator never saw.

And two things nothing read back out at all: `GET /snapshots/runs` had **no consumer** — every "since
when has telemetry been broken?" was answered from logs — and the per-run departure churn
(`master_sync_runs.entity_stats.departures`, `device_departures.cancelled_tickets_count`) was written
by #128, audited as `DEVICE_DEPARTED`, and displayed nowhere. A technician's open tickets were
auto-closed and the only trace was a row nobody queries.

## The shape of the fix

**`api/integrationHealth.ts` now mirrors the backend `IntegrationHealth` in full** — source,
`FreshnessHealth` (with #348's `stale` / `staleAfterMinutes`), reconciliation, lifecycle,
`schedulerEnabled`, `checkedAt`. #348 deliberately declared its freshness fields *locally* inside
`SnapshotBanner.tsx` because that file did not own the API module; those now live in the shared types,
which is what stops two components deriving different readings of the same payload.

**`BuildHealthPage.tsx` is extended, not redrawn** (there is no v2 image; the page is the authority,
#131). The three original cards are untouched and in their original relative order; four new sections
sit **above** them, because "is it running" outranks "which build ran it":

1. Source connectivity · 2. Data freshness · 3. Deployment lifecycle (+ per-run churn) ·
4. Snapshot run history · then the original Current build and Recompute history.

**Backend — one addition.** `LifecycleHealth.runs`: the last ten master syncs with `departed`,
`restored`, `ticketsAutoClosed` and `skippedByReason`, from one indexed `LIMIT 10` plus a correlated
sum over `device_departures`. No schema change (#357 owns the schema this round; none was needed).

## Decisions worth keeping

**1. The per-run churn lives inside `lifecycleHealth()`, not beside it.** That method is public
precisely so the Ops Explorer's 9th identity and this page cannot report different lifecycle
answers — the same "reused, not respelled" posture as `reconciliationHealth()`. Splitting the run
history into a second entry point would have saved the Explorer one cheap query and bought back the
possibility of two surfaces disagreeing about the same fleet churn. The alternative considered and
rejected was `runs: []` from the shared method with the real read done only in `check()`: a field that
is empty by construction for one caller is a trap, not an optimisation.

**2. `quiet` is decided independently of `status`.** A FAILED run also moved zero devices, and that is
not the same fact: it moved nothing *because it died*. Only a SUCCESS run that opened and closed
nothing is the #218 signal, so `quiet` requires `status === 'SUCCESS'`. A history that let a failure
masquerade as a quiet run would blunt the exact signal this table exists to carry.

**3. Quiet runs are shown, never filtered out.** The instinct with a churn table is to hide the rows
where nothing happened. Those rows *are* the finding — 33 of them passed unread in `entity_stats`
(#218) — so they are rendered, badged `quiet`, and highlighted.

**4. `drift` is worded as a contradiction and given no tolerance band** (#224). Its correct value is
exactly 0 and any non-zero is a defect by construction; the card says so in as many words and turns
red rather than shading a band. `missingFromSource` sits **beside** it in its own tile and is never
folded in — 218a's whole point is that the excluded population is surfaced, not hidden. Neither joins
the KPI strip, per #224 and FIX-PLAN §5: those tiles count devices *by* lifecycle state while these
count a disagreement *about* it, and adjacency invites subtraction between non-commensurable numbers.

**5. Freshness shows the age AND the threshold, in the same units grammar.** "Stale" with no figure
is not actionable, and the figure is what tells an operator whether this is one missed tick or a dead
scheduler. The yardstick line is deliberately worded "Threshold 1 h (2× cadence)" and avoids the word
*stale* — the badge is the verdict, the line is the number it was measured against.

**6. Paging is honest about what the route can know.** `GET /snapshots/runs` returns a bare array with
no total, so the pager treats a full page as "there may be more" and a short page as the end. A pager
that keeps offering *Next* over a total it does not have is how an operator ends up staring at an
empty table. Changing the route to a `{ rows, nextCursor }` page would have been the richer contract,
but `snapshots.controller.ts` / `snapshot-query.service.ts` are outside this slice's file ownership
and #348's e2e cases already pin the array shape.

**7. Every new section self-gates on an absent payload section.** An older backend degrades to the
previous page rather than white-screening, the same posture `IngestionAlertCard` already took — and
`apiSnapshotRuns` returns `[]` for a non-array body rather than letting `undefined.map` take the whole
page down (the shape that produced Round 2's one regression).

**8. The H1 still reads "Build Health".** The issue calls this the Integration Health page and the
page now is one, but `shell/nav.ts` is not this slice's file: renaming the heading alone would leave
the operator's landmark and the page disagreeing. The subtitle carries the widened scope instead. A
coordinated rename (nav label + route + page) is noted as a follow-up below.

## Where the premise was wrong

- **The plan's `ingestion/health.service.ts` path is stale** — it is
  `apps/backend/src/ingestion/autoplant/health.service.ts`.
- **`GET /snapshots/runs` was already paged and filterable.** The issue reads as though paging and the
  status filter needed building; `limit` / `offset` / `status` have been on the route since Issue 04
  slice 7. What was missing was any consumer at all, so those arguments had never been exercised —
  the two new e2e cases (`#349 AC2`) passed on arrival and now hold the contract the table pages
  against. AC2 is met client-side, with no route change.
- **Reconciliation is deliberately NOT given a card here.** Plan §1 narrowed ING-02 on exactly this
  point: drift already has a screen (`ReconciliationPanel.tsx`, OH), so the real drops are
  connectivity, age and lifecycle. The client type carries `reconciliation` so the page *can* read it;
  duplicating the Explorer's panel would have created a second place for the same numbers to be read.
- **No schema change was needed.** `device_departures.cancelled_tickets_count` and
  `detected_by_run_id` have existed since #128; the counters were derivable from what is already
  stored.

## What was tested, and why in that shape

The admin cases drive the page through `fetch`, routed by URL, because the page now reads **two**
endpoints and the run history is the second — a single blanket mock would have hidden which surface
each assertion was really exercising. One case deliberately serves the pre-#349 payload: upgrade order
is a real state, and this page's job during a partial deploy is to degrade, not to white-screen.

The backend cases assert the **wire shape** of every section, which the old spec structurally could
not: it checked that three keys existed, so four sections could be dropped from the payload without
failing anything. The two per-run cases seed their own run and departures and assert on `runs[0]` —
the newest `run_id` is by construction the run just created, so nothing depends on rows another spec
left behind (#215).

## Acceptance criteria

- **AC1 — the four dropped sections render with live values.** ✅ Connectivity (`integration-source`),
  freshness with age + threshold (`freshness-masterSync` / `freshness-snapshot`), lifecycle
  (`lifecycle-drift`, `lifecycle-missing-from-source`, `lifecycle-quiet-runs`) and run history
  (`snapshot-run-*`).
- **AC2 — run history is paged and filterable by status.** ✅ `apiSnapshotRuns({ limit, offset,
  status })`, a status `FilterSelect` that resets the offset, and a prev/next pager that cannot page
  past a short page. Backend contract pinned in `snapshots-api.e2e-spec.ts`.
- **AC3 — departures / restores / auto-closed counts per run.** ✅ `LifecycleHealth.runs`, rendered as
  the per-run churn table; quiet runs shown rather than filtered.
- **AC4 — the page stays OH-only.** ✅ Role untouched: `RoleRoute roles={['OPERATIONS_HEAD']}` in
  `AppRoutes.tsx` and the single nav entry, both unmodified; the existing nav-gating case still passes.

### #224 (closed by this slice)

- ✅ `IntegrationHealthView` carries `lifecycle` in full (`drift`, `missingFromSource`, `quietRuns`,
  `quietRunsAlert`, `quietRunsThreshold`, `healthy`) — plus `runs`.
- ✅ `BuildHealthPage` renders it, with `drift` and `quietRunsAlert` visible without interaction.
- ✅ `drift` presented as a contradiction, not a measurement.
- ✅ `missingFromSource` shown beside `drift`, never folded into it.
- ✅ Not added to the main KPI strip.

### #129 (health-page AC only — the issue stays open)

- ✅ Integration-health page shows per-run departures / restores from `entity_stats` ("+212 departed,
  37 restored"), with the departure-auto-closed ticket count beside them.
- The dashboard departed tally and the device-detail lifecycle history remain #129's.

## Tests, verbatim

```
cd apps/admin && npx vitest run test/build-health-page.test.tsx
 ✓ test/build-health-page.test.tsx (21 tests)
 Test Files  1 passed (1)
      Tests  21 passed (21)
```

(Red first: 11 failed | 10 passed before the implementation landed.)

```
.scratch/locks/backend-test.sh npx vitest run test/integration-health-api.e2e-spec.ts test/lifecycle-health.e2e-spec.ts
 ✓ test/integration-health-api.e2e-spec.ts (6 tests)
 ✓ test/lifecycle-health.e2e-spec.ts (5 tests)
 Test Files  2 passed (2)
      Tests  11 passed (11)

.scratch/locks/backend-test.sh npx vitest run test/snapshots-api.e2e-spec.ts
 ✓ test/snapshots-api.e2e-spec.ts (20 tests)
 Test Files  1 passed (1)
      Tests  20 passed (20)
```

Regression checks on the two consumers of the changed types/method:

```
cd apps/admin && npx vitest run test/snapshot-banner.test.tsx        → 18 passed
cd apps/admin && npx vitest run test/build-health-notice.test.tsx    → 5 passed
.scratch/locks/backend-test.sh npx vitest run test/ops-explorer.e2e-spec.ts test/integration-reconciliation.e2e-spec.ts
                                                                     → 28 passed
```

`apps/admin && npx tsc -b` clean. `apps/backend && npx tsc --noEmit` reports one pre-existing error in
`verification/verification.controller.ts` belonging to another slice in flight this round; nothing in
the files this slice owns.

## Follow-ups this slice does not own

- **The page's name.** Nav label, route (`/build-health`) and H1 should be renamed together to
  "Integration Health" — `shell/nav.ts` and `AppRoutes.tsx` are outside this slice's file set.
- **#129's remaining ACs** — ZM/OH dashboard departed tally, device-detail lifecycle status and
  departure/restore history.
- **#361** — the *pushed* notice for a departure auto-close. This slice surfaces it where an operator
  can look; it does not tell anyone.
- **#351** takes `api/snapshots.ts` next round for the dashboard's snapshot-health badge. The client is
  left shaped for that read: `SnapshotLatestView` now carries `overdue` / `schedulerPaused`,
  `IngestionAlertHealth` carries `silenceMinutes` / `expectedCadenceMinutes` / `overdueAfterMinutes` /
  `schedulerPaused` / `overdue`, and `SnapshotRunView` carries `error`.
- **`SnapshotBanner.tsx`'s local `IngestionFreshness` / `SnapshotFreshnessView` intersections** are now
  redundant — the shared types carry those fields. Harmless (an intersection with the required field
  narrows to the same type) but worth deleting by whichever slice next owns that file.
