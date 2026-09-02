# dashboard · S3 walk narrative — 2026-09-02, api-walk only (no browser)

Instrument: `api-walk` + one scratchpad aggregator over the same login flow (the shipped script
prints only the first 2 array items, which cannot settle a whole-payload scoping claim).
Environment: healthy throughout, no timeouts, no 502s. Build `beea7d2-dirty` == git HEAD.

## DASH-H1 — row-level scoping · CONFIRMED · no gap

The dashboard is **as zone-clamped as `/tickets`**, on every endpoint, at row level:

| endpoint | zm.north | zm.south | csm | ops.head | wm | se |
|---|---|---|---|---|---|---|
| zone-overview | 1 row z=[1] | 1 row z=[2] | 5 rows z=[1-5] | 5 rows z=[1-5] | 403 | 403 |
| critical-queue | 28 grp / 391 tk z=[1] | 25 / 206 z=[2] | 178 / 3038 z=[1-5] | 178 / 3038 | 403 | 403 |
| company-plant-overview | 82 z=[1] | 38 z=[2] | 340 z=[1-5] | 340 | 403 | 403 |
| fleet-summary | 9 co / 82 pl / 6560 dev | 8 / 38 / 4370 | 33 / 340 / 29394 | same as csm | 403 | 403 |
| operating-mode | 1 z=[1] | 1 z=[2] | 5 z=[1-5] | — | 403 | 403 |

CSM/OH numbers are **genuine fleet-wide aggregates**, not one zone relabelled: 29394 devices is not
6560 and not 4370, and 6560 + 4370 = 10930, so zones 3-5 contribute real rows too. The two ZM
payloads are disjoint. C9 check 6 flips `?` → `v`; the strongest alternative (a layout-only lens over
unclamped data) is falsified. **No gap here — this is the module's best-built property.**

Widening also fails closed. As `zm.north` with `?zoneId=2`: `activity-trend` returned `zoneId:1`
(the parameter is ignored for a ZM, exactly as `dashboard.controller.ts:78-93` claims);
`company-plant-overview` returned `len=0`; `zone-operations` returned all zeros, while the same call
as `zm.south` returned 1006 open tickets. No leak on any endpoint.
Minor honesty wrinkle, **not filed** (unreachable — `ZmDashboard` passes `canSelectZone={false}`):
two of those return an empty/zero body rather than clamping to the caller's own zone, so a ZM handed
a foreign `zoneId` would read a plausible "0 open tickets" instead of an error.

## Check 6 (perms) — CONFIRMED clean

`wm@fsm.test` and `se.north@fsm.test` are **403 on all six dashboard endpoints plus
`/api/snapshots/latest`**. Neither reaches a manager payload. `DashboardHome.tsx:13` diverting the WM
in the UI is a second line, not the only one.

## DASH-G02 measured — the 5 "coming soon" cards are now a measurement, not a code claim

`GET /api/dashboard/action-required`, identical for ZM / ZM_SOUTH / CSM / OH: exactly **4
`available:true`** (vehicle_unavailability, failed_verification, waiting_component_overdue,
recovery_stalled) and **5 `available:false`**. Every one of the nine counts is **0**. The four wired
zeros are consistent with the shared primer's empty verification/voucher queues and are *not*
evidence those four are broken — but the panel a ZM sees today is nine zero rows, five of which say
"coming soon".

## DASH-H4 — CONFIRMED, alternative falsified

All 7 `CARD_DESTINATION` routes are `RoleRoute`-gated to exactly
`['ZONAL_MANAGER','CENTRAL_SERVICE_MANAGER','OPERATIONS_HEAD']` (AppRoutes 375/385/395/413/431/459
plus `/tickets`). Every one admits a ZM. Four of the landing endpoints answer 200 as ZM. Borrowing
AttentionBand's map lands the ZM on working pages — DASH-G02 stays cheap.

## DASH-H2 — CONFIRMED, alternative falsified · and one new gap

`apiCriticalQueue` is imported by `api/dashboard.ts:181` and `ManagerDashboard.tsx` **and nothing
else**. No Scheduler Console / Today's Dispatch duplicate exists. DASH-G01 is genuinely COMPLETE
work. **New: DASH-G11** — `suggestedSes` is a literal `[]` at `dashboard.service.ts:851` (the only
assignment in the repo) typed `unknown[]` at `:192`, and is empty on **all 231 live groups**. It
blocks G01's "suggested SE / one-click assign" and must be priced with it.

## DASH-H5 — CONFIRMED

No `count`/`summary` count endpoint exists in any backend controller, so there is nothing to fan in.
But the four wired counts are bespoke `$queryRaw` over tables that **already exist** — so the five
missing cards are five new SQL aggregations, not five new data models. `dependency` lowered 3 → 2.
Do **not** file the retired-workflow wording in the keys: `:293-296` records a deliberate 2026-08-28
label correction, keys kept as wire contract.

## DASH-G04 — honest downgrade

`/api/snapshots/latest` right now: run 169 **SUCCESS**, `dataAsOf 2026-09-01T12:00:08Z` (~21h old).
The banner is therefore **not red today**, so the red-banner-beside-green-badge pairing is
**NEEDS-VERIFY, not observed** — it needs a FAILED run plus a browser. What *is* settled, and is
worse than the original write-up: the badge is a bare literal with no data source (E2), **and**
`SnapshotBanner` has no age threshold at all — it alerts only on FAILED, stuck-RUNNING past 15 min,
or a gated streak (`:26,:29`). A 21-hour-old snapshot reads healthy in *both* places.
