# 235 — Drill-through: filter the device list to recently commissioned devices

**Completed 2026-08-13.** Backend + Admin. Frozen completion record — corrections go to INDEX /
SYSTEM-STATE, not here.

Issue: `.scratch/fsm-platform-v1/issues/235-recently-commissioned-device-drillthrough.md`
Reference: `docs/ui/desktop/v2-reference/22-device-detail.png`

---

## What was built

"Drill into individual device details" already existed end to end — `/reports/device`,
`GET /api/devices/:id`, `/cycles`, `/downtime-trend`. The only missing piece was a way to narrow that
list to the cohort. This slice is that one filter plus the links into it.

| Piece | File |
|---|---|
| The shared window definition | `apps/backend/src/reports/commissioning-window.ts` **(new)** |
| Device-list filter | `apps/backend/src/devices/device.service.ts` |
| Bounded param | `apps/backend/src/devices/devices.controller.ts` |
| Typed client param | `apps/admin/src/api/devices.ts` |
| Target page reads it + scope chip | `apps/admin/src/pages/reports/DeviceDetailPage.tsx` |
| Cohort rows link out + grain note | `apps/admin/src/pages/reports/CommissioningCohortPage.tsx` |

**No migration, no new index, no new endpoint.** One optional query param on an endpoint that already
carries eight.

## One definition of "recently commissioned"

The new module exists because the cohort report and the device list are **structurally different
queries** over the same idea: the report iterates fitments (`FROM device_commissioning`), the list
filters devices (`EXISTS (…)`). What they must agree on is the window predicate, so that is what was
extracted — `commissionedWithinWindow` for the report, `deviceCommissionedWithin` wrapping it for the
list, plus `cohortWindowStart` so neither can round the boundary differently.

The failure this prevents is concrete: the cohort page's plant rows **link here with the same window**.
A reader who clicks a row showing 120 fitments and lands on a list built from a second spelling of
"recent" has been shown two different answers to one question.

Two details worth keeping:

- **`EXISTS`, not a join.** A join would fan the one-row-per-device grain out on any device with
  several fitments in the window.
- **The window's upper bound is not decoration.** `installed_at` is mirrored from AutoPlant, which has
  no constraint against a future date; without `<= until` a mis-keyed 2027 fitment would appear in
  every window forever, including windows that end before it. There are zero future-dated rows at
  source today — exactly the kind of fact that holds until it does not.

## Grain: the two surfaces count different things, and both say so

The cohort page counts **fitments**; this list counts **devices**. Measured live, **6.4% of cohort
devices carry more than one fitment in 90 days** (400 with 2, 9 with 3, 3 with 4). The two totals
legitimately differ, and unstated that reads as a bug — so it is stated in three places: a note under
the cohort's plant table, the scope chip on the device list ("counting devices, not fitments"), and a
backend test that asserts a two-fitment device returns exactly one row.

## The #217 S2 lesson, applied on both sides

That slice found a drilldown that substituted a *display* value into an *id* param, and another whose
target read no such param at all — both silently going nowhere while looking fine from the sending
side. So:

- The plant link is built on `plantId`, never on `plantName`, and a test asserts the exact `href`.
- `DeviceDetailPage`'s param contract was **read** before the link was written, and the page was
  changed to consume `commissionedWithinDays` — with its own test asserting the value reaches the
  backend request, not merely that the link exists.

## Acceptance criteria

| AC | Status | Evidence |
|---|---|---|
| AC-1 absent param ⇒ identical behaviour | ✅ | regression test; all 12 pre-existing device-list tests unchanged |
| AC-2 reuses the cohort predicate; no second definition | ✅ | `commissioning-window.ts`, imported by both call sites |
| AC-3 ZM zone clamp holds through the filter | ✅ | test — a new WHERE fragment is exactly where a clamp gets lost |
| AC-4 rows link with scope; target reads every param | ✅ | `href` test on the sending side, request test on the receiving side |
| AC-5 both surfaces state their grain | ✅ | grain note + scope chip, both tested |
| AC-6 bounded on `COHORT_DAYS`, rejects out of range | ✅ | `200`, `0` and `abc` all 400 |

## Testing

| Suite | Result |
|---|---|
| `device-list.e2e-spec.ts` | **15** (was 9) — 6 new for the filter |
| `commissioning-cohort.test.tsx` (admin) | **17** (was 14) — 3 new for the links |
| `device-detail.test.tsx` (admin) | **16** (was 11) — 5 new for the receiving side |
| Backend regression set | **117 across 7 files, exit 0** |
| Full admin suite | **464 tests / 95 files, exit 0** (was 456) |
| `tsc --noEmit` both apps | clean |
| `tsconfig.test.json` | 93 errors, unchanged pre-existing baseline |

**A pre-existing test broke and it was the fixture's fault, not the feature's.** The new
"old device" fixture initially shared a vehicle with the original, which made a
`search=DL-VEH-…` assertion of `total === 1` return 2. Fixed by giving the fixture no vehicle rather
than by loosening the assertion — the assertion was right.

## Not done

- **A hand-edited garbage param degrades to "no filter", silently.** The page holds the value as a
  number and drops anything else, because the backend 400s on it and blanking a page someone reached
  by a normal link is worse. It does not tell the user their param was ignored.
- **Only plant rows link out.** Installer rows do not, because `GET /api/devices` has no installer
  filter and adding one would mean a second `EXISTS` on a column with no index. Not needed for the
  ask; recorded here rather than left as a silent asymmetry.
- **Never exercised in a browser** — same #194 credential gap as #232's page.
