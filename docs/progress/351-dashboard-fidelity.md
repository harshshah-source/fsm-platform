# 351 — Dashboard fidelity: freshness badge, trend, operating mode, grouping, CSV, console link

**Done 2026-09-04.** Wave 2 of the module-gaps completion plan (`docs/module-gaps/IMPLEMENTATION-PLAN.md`
§4), absorbing survey ids DASH-G01, G04, G06, G07, G09, G10, G11 and **closing #136 slice 3** (and, in
passing, #136 slice 2's mount). Red-first. Depends on #348 (the freshness verdict the badge displays)
and consumes the client shape #349 left for it.

## What it closes

Six places where a dashboard asserted something it did not know. Individually each is small; together
they are the reason a manager cannot take a number off this page and act on it.

- **"Snapshot Healthy" was a literal string** on three dashboards (`ZmDashboard`, `CentralDashboard`,
  `WarehouseDashboard`). Green while ingestion was dead, green while the scheduler was switched off,
  green while #300's downstream gate held every derivation back — because nothing about it was
  connected to anything. This is the one that mattered most: a pill that answers "is this data
  current?" with a hardcoded yes is worse than no pill, because the operator stops asking.
- **`trendPctVsPrevDay` returned `null` unconditionally** while `soft_inactive_count_history` — written
  twice a day since Issue 40 — held the comparison. The Trend column had rendered "—" for every zone
  for its entire life.
- **`ZoneOperatingModeCard` / `ZoneOperatingModeTable` were built and mounted nowhere.** #136's whole
  legibility slice — the one surface that explains *why* the recommender is behaving as it is — had
  been invisible since August behind a deferred-wiring note about a file conflict that had long since
  cleared.
- **`EscalationQueueList` flattened the company/plant clusters** the backend supplies, discarding
  `clusterSize`. Eight devices silent at one plant is *one* site problem an SE clears in a single
  visit; flattened, it read as eight unrelated escalations and the obvious next move was invisible.
- **The ZM dashboard lost its critical queue to `/assign` (#277) with no pointer back** — the page
  simply stopped mentioning that critical work existed.
- **`suggestedSes: []`** was a dead field on the wire, promising a one-click assign the dashboard is no
  longer allowed to offer.

## The shape of the fix

**`components/dashboard/SnapshotHealthBadge.tsx` (new)** reads `apiSnapshotLatest` and renders one of
six verdicts. #349 deliberately shaped `api/snapshots.ts` so this is a **read, not a rewrite**:
`overdue`, `schedulerPaused` and `ingestion.silenceMinutes` were already typed there, so **that file
was not touched at all**. The age rides beside the badge in the slot references 01/03 give the
"Data as of …" chip.

**Backend `zoneOverview` gained one statement** — `softInactiveTrend`, a single `ROW_NUMBER()` over the
zone partition of `soft_inactive_count_history` returning the two most recent captures per zone. One
indexed scan on the existing `(zone_id, captured_at DESC)` index, not a query per zone. **No schema
change** (#337/#366 own `schema.prisma` this round; none was needed).

**`EscalationQueueList` was restructured, not restyled.** Rows keep their exact previous anatomy
(device, tier, duration badge) so the page still reads like reference 03; what changed is that the
company and plant are named **once, on the cluster**, and the cluster carries its own count.

## Decisions worth keeping

**1. One vocabulary for freshness, not two.** #349's Integration Health page already names this exact
fact — `Stale` (red) against a threshold of twice the configured cadence — and #348's banner calls the
same verdict `overdue`. The badge uses the health page's word, **Stale**, for the bad state and keeps
the v2 reference's word, **Healthy**, for the good one. An operator moving between the dashboard and
the health page reads one idea. Inventing a third spelling for the same boolean is how two surfaces
start disagreeing about one event.

**2. The badge's precedence deliberately mirrors `SnapshotBanner`**: failed → stuck → overdue → gated →
paused → healthy. Both ride the same screen. Two components ranking the same states differently is how
a page ends up saying "alert" at the top and "gated" in the middle about a single incident.

**3. The badge renders nothing until its first read resolves.** A placeholder verdict is the precise
defect this slice closes; a grey "checking…" pill for 200 ms would be a smaller version of the same
lie. A read that *fails* is stated ("Snapshot Unavailable", neutral), never silently degraded to green
— an unreachable API is evidence about the API, not about ingestion.

**4. The trend is null in two cases, and they are not folded into `0`.** Fewer than two captures, and a
zero baseline. A zone with one capture on record has not "held steady", it has not been measured twice
yet; and 0 → 5 has no percentage, so reporting `+500%` or `+Infinity%` would both be inventions. "We
have no reading" and "nothing changed" must not render identically — which is the same principle that
made every rate on this page `null` rather than `0` when its denominator is empty.

**5. The trend measures the Soft Inactive Count, and says so.** That population (`is_inactive AND
eligible_for_uptime`) is close to but not identical with the row's `inactiveOperational` (which also
requires a GPS fix on record and excludes deactivated plants). It is the only per-zone history this
platform keeps. A *rate of change* over the series that exists is a true statement; matching the level
exactly would need a new history table, i.e. a schema change this slice may not make. The field's doc
comment and the cell's `title` both name what is being compared rather than leaving the reader to
assume it is the column beside it.

**6. `trendPctVsPrevDay` keeps its wrong name.** Captures are twice daily, so the comparison is against
the previous *period* — which is exactly what the v2 reference calls it ("↑ +14% vs prev. period"), and
what the column header now says. The field name predates the cadence. Renaming it on the wire would
touch every dashboard fixture in both apps for no operator-visible gain, so the name is stable and the
meaning is documented at both ends.

**7. The Trend cell colours by operational meaning, not by arithmetic sign.** More silent devices is
worse, so a rise is red and a fall is green. A column where "+" is green because plus is usually good
would invert the one signal it exists to carry.

**8. The CSV export gets the bare signed number; the arrow stays on screen.** `exportValue` overrides
the DOM read for that one column — a spreadsheet cell reading "▲ +30%" cannot be sorted, summed or
charted.

**9. The Critical+ tile is a summary and a link, not a rebuilt queue.** #277 removed `CriticalQueue.tsx`
on purpose and `/assign` is the single manual-assignment surface (#272 R1); plan §1 records this as
design-superseded. So the tile states the count of open CRITICAL+ troubleshoot tickets in the manager's
zone — the same `critical-queue` aggregation the CSM's Escalation Queue renders — and opens the console
already filtered. It is deliberately **not** the strictly-CRITICAL `kpi-critical` card, which Issue 122
ruled on and `kpi-critical-plus-consistency.test.tsx` guards; both now sit on the page meaning different
things, each labelled with which band it counts.

**10. The tile lives in the hero's `centerBelow` slot.** The hero's side columns are capped at three
cards each (`ROW_START` only maps 1–3), so a seventh KPI cannot be added without redesigning the grid —
and the surfacing rule says match the reference, do not redesign. `centerBelow` is an existing,
documented hero slot that the ZM variant does not otherwise use (the Ops Head puts its compact trend
there), so the tile lands inside the hero, centred, with no new page band invented for it.

**11. The URL preset seeds `criticalOnly`, it does not pin it.** Read once in a lazy initialiser rather
than synced to the URL each render: a ZM who follows the tile and then unticks the filter must stay
unticked. `ASSIGN_CRITICAL_PLUS_PRESET_PATH` is exported from the hook so the surface that links and
the hook that reads cannot drift to two spellings of one string.

**12. `suggestedSes` is removed, not populated.** Plan §1 and the issue both record why: filling it
would re-add one-click assign to the dashboard, contradicting #272 R1. An empty field that will never
fill is a promise on the wire.

## Where the premise was wrong

- **AC5's premise is wrong: the CSV export already existed.** `ZoneOverviewTable` renders through
  `DataTable`, whose `downloadable` prop defaults to `true` and which has carried a shared
  `TableDownloadButton` (CSV / Excel / PDF / PNG, DOM-read so the export equals the post-filter view)
  since Issue 160 decision 3. `dashboard-home.test.tsx:87` has asserted the button's presence all
  along. The real defect at `ZoneOverviewTable.tsx:13` was a **stale docstring** describing the trend
  cell as "a neutral '—' placeholder until the daily-history table lands". The two new export cases
  passed on arrival; they now hold the contract (body content, and filtered-view equality) that nothing
  previously asserted, and the docstring is corrected.
- **`dashboard-operating-mode.e2e-spec.ts` exercised OH and ZM but never CSM.** AC3 requires CSM to see
  all zones; the role was in the controller's guard from the start but "CSM sees every zone" was an
  assumption the suite did not hold. The new case passed on arrival and now pins it.
- **The plan's `ZoneOverviewTable.tsx:145-151` / `EscalationQueueList.tsx:16-33` line refs were
  accurate**; `dashboard.service.ts:454` had drifted to `:465`, and `:192,851` to `:194,862`.

## What was tested, and why in that shape

The backend cases seed **their own zones** with their own capture histories, written directly rather
than through `SoftInactiveCountService.recompute` — `recompute` snapshots every zone at one instant, and
the three cases need three different histories in one run. Two of the zones exist only to carry a
history and are given a single device each, because a zone with no mirrored device does not appear in
the overview at all (rows are driven by the counts query).

The admin CSV cases assert the **CSV body**, mocking only `downloadCsv` so the whole chain — DOM read,
`exportValue` override, `toCsv` — runs for real. (jsdom's `Blob` has no `.text()`, so intercepting the
object URL would have proved only that a click happened.) The badge cases drive the real
`/snapshots/latest` payload shape through `fetch` rather than stubbing the component's state, because
the fact under test is precisely that the pill is derived from that payload and not from a constant.

## Acceptance criteria

- **AC1 — the badge reflects the latest snapshot status and age.** ✅ `SnapshotHealthBadge` renders
  Healthy / Stale / Failed / Stuck / Gated / Paused / Unavailable from `apiSnapshotLatest`, with the
  data-as-of stamp and `silenceMinutes` age beside it. Mounted on ZM, CSM and Warehouse; the literal is
  gone from all three.
- **AC2 — the trend column shows a signed % when two history rows exist.** ✅ `+30%` / `-6.4%` with
  direction and operational colouring; `—` when there is no comparison.
- **AC3 — operating mode is visible to ZM (own zone) and CSM/OH (all zones).** ✅ `ZoneOperatingModeCard`
  on `ZmDashboard`; `ZoneOperatingModeTable` on `CentralDashboard` and `OpsHeadDashboard`. Both
  self-gate on role, so no variant sees the other's surface.
- **AC4 — the escalation list is grouped with cluster counts.** ✅ One `escalation-group` per
  company/plant, worst-bucket-first then biggest-cluster-first, each carrying `clusterSize`.
- **AC5 — CSV export downloads the visible rows.** ✅ Already delivered by `DataTable`'s shared download
  control (see "premise was wrong"); now pinned by two cases and the trend column exports as a number.
- **AC6 — ZM sees a Critical+ count that opens the console preset.** ✅ `kpi-critical-plus-queue` tile →
  `/assign?filter=critical-plus`, which `useAssignDraft` reads to seed `criticalOnly`.
- **AC7 — `suggestedSes` is gone from the API type and the service.** ✅ Removed from
  `CriticalQueueGroup` in both `dashboard.service.ts` and `api/dashboard.ts`; the e2e now asserts the
  property is absent.

### #136 slice 3 (closed by this slice)

- ✅ The cross-zone operating-mode table is reachable by CSM and OH on their own dashboards.
- ✅ ZM sees the own-zone card instead (slice 2's mount, also outstanding, lands with it).
- ✅ Neither surface renders the raw `DEFICIT` / `PREVENTIVE` enum — both go through
  `operatingModeCopy`, untouched by this slice.
- ✅ Backend CSM scope pinned by a new e2e case.

## Tests, verbatim

```
cd apps/admin && npx vitest run test/dashboard-fidelity.test.tsx
 Test Files  1 passed (1)
      Tests  22 passed (22)
```

(Red first: the suite failed to collect at all — `SnapshotHealthBadge` did not exist — then 6 failed |
16 passed against the half-built implementation.)

```
.scratch/locks/backend-test.sh npx vitest run test/dashboard-zone-overview.e2e-spec.ts \
    test/dashboard-operating-mode.e2e-spec.ts test/dashboard-critical-queue.e2e-spec.ts
 ✓ test/dashboard-zone-overview.e2e-spec.ts (8 tests)
 ✓ test/dashboard-operating-mode.e2e-spec.ts (7 tests)
 ✓ test/dashboard-critical-queue.e2e-spec.ts (2 tests)
 Test Files  3 passed (3)
      Tests  17 passed (17)
```

(Red first: 2 failed | 15 passed — `expected null to be 30`, and `expected … to not have property
"suggestedSes"`.)

Admin regression over every consumer of the changed components and types:

```
cd apps/admin && npx vitest run test/dashboard-fidelity.test.tsx test/dashboard-role-variants.test.tsx \
  test/dashboard-home.test.tsx test/dashboard-kpi-contract.test.tsx test/kpi-critical-plus-consistency.test.tsx \
  test/dashboard-warehouse.test.tsx test/dashboard-company-plant.test.tsx test/dashboard-critical-action.test.tsx \
  test/zone-operating-mode-card.test.tsx test/zone-operating-mode-table.test.tsx test/snapshot-banner.test.tsx \
  test/assign-console.test.tsx test/assign-console-candidates.test.tsx test/assign-console-grammar.test.tsx \
  test/scheduler-console-assign-recomposition.test.tsx test/table-download.test.tsx \
  test/dashboard-filters.test.tsx test/acting-header-builder.test.ts
 Test Files  18 passed (18)
      Tests  153 passed (153)
```

`apps/admin && npx tsc -b` clean. `apps/backend && npx tsc --noEmit` clean.

### Backend re-verification is currently blocked by another slice in flight

A later re-run of the three backend specs could not boot the app at all:

```
Error: Nest can't resolve dependencies of the InventoryService (PrismaService, ?).
Please make sure that the argument NotificationService at index [1] is available in
the RecommenderModule context.
```

`InventoryService` acquired a `NotificationService` dependency (`inventory.service.ts:43`, commented
`#361`) while `RecommenderModule` lists `InventoryService` among its providers and imports only
`PrismaModule`. Neither file is in this slice's set, and the failure takes down **every** e2e that
imports `AppModule` — the tests are reported as *skipped*, not failed. The 17/17 above was taken from
this exact backend source before that edit landed; nothing in `dashboard.service.ts` changed
afterwards. The orchestrator's final full-suite run will hit this until #361 finishes its module wiring.

## Files outside this slice's set that were touched, and why

Three, all forced and all minimal:

- **`apps/backend/test/dashboard-critical-queue.e2e-spec.ts`** — asserted `suggestedSes` was an empty
  array. AC7 deletes the field, so the assertion had to invert (it now asserts the property is absent).
- **`apps/admin/test/dashboard-critical-action.test.tsx`** — rendered `CentralDashboard` and
  `OpsHeadDashboard` bare, with no `AuthProvider`. Mounting `ZoneOperatingModeTable` (AC3) puts a
  `useAuth` call inside both bodies, which throws outside the provider. Wrapped both renders; no
  assertion changed.
- **`apps/admin/test/dashboard-role-variants.test.tsx`, `kpi-critical-plus-consistency.test.tsx`** —
  dropped the now-stale `suggestedSes: []` from two untyped mock bodies. Cosmetic (they are `unknown`
  literals, so nothing broke); removed so no fixture documents a field that no longer exists.

One defensive one-character change inside an owned file is worth naming: `useAssignDraft`'s
`view?.totals.openUnassigned` is now `view?.totals?.openUnassigned`. An unexpected body on the pool read
used to take the whole console down on first render — the Round-2 `undefined.map` failure mode, one
level up.

## Follow-ups this slice does not own

- **`SnapshotBanner.tsx`'s local `IngestionFreshness` / `SnapshotFreshnessView` intersections** are
  redundant now that the shared types carry those fields (#349 flagged this). Harmless, still not
  deleted — that file is not in this slice's set.
- **The Ops-Head dashboard has no snapshot badge**, because its hero passes no `actions` slot. The issue
  names three dashboards and all three have it; giving the OH page one means adding a header row to
  `DashboardHero`'s OH call, which is a layout change no reference covers.
- **A history of `inactiveOperational` itself.** Decision 5 above explains why the trend measures the
  Soft Inactive Count; a per-zone capture of the dashboard's own inactive population would need a new
  table and belongs with whoever next opens `schema.prisma`.
- **#361's `RecommenderModule` wiring** (see above) — theirs, but it blocks the full suite.
