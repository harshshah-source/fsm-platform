# 256 — `plant-zone-change-impact` fails every night between 00:00 and 05:30 IST

Status: done (2026-08-20)
Type: AFK · Backend (test fixture)

Filed 2026-08-20 from #255's second verification run. Not a product defect — a **test fixture** that
states its day in UTC while the code under test reads the day in IST, so the spec is red for the 5.5
hours a night when those disagree and green the other 18.5.

## What happened

Two full backend runs, same tree, same commit:

| Run | Started (IST) | Result |
|---|---|---|
| 1 | 18:03 | 388 files, 1890 passed / **2** failed — the known `voucher-controller` pair |
| 2 | 23:33 | 388 files, 1889 passed / **3** failed — the same pair **plus** `plant-zone-change-impact` |

```
FAIL test/plant-zone-change-impact.e2e-spec.ts > #158 — zone change impact probe
     > reports the devices and open tickets that will re-scope, and the work already dispatched today

- Expected  "dispatchedTodayCount": 1
+ Received  "dispatchedTodayCount": 0
```

It reproduces **in isolation**, so it is not a fixture collision and not #184. It is purely a function
of what time of day the suite runs.

## Root cause — precise

The service reads the **IST** calendar day (`#204`'s ruling, correctly applied):

```ts
// src/org/zone-mapping.service.ts:209
const day = istDate(new Date());
// …schedule: { ...liveScheduleFilter(), dateFrom: { lte: day }, dateTo: { gte: day } }
```

The spec's fixture writes the **UTC** calendar day:

```ts
// test/plant-zone-change-impact.e2e-spec.ts:144-147
const today = new Date();
today.setUTCHours(0, 0, 0, 0);
// …data: { seId, zoneId: eastId, dateFrom: today, dateTo: today, status: 'ACTIVE' }
```

IST is UTC+05:30, so from **00:00 to 05:30 IST** the UTC date is still *yesterday*. The fixture stamps
the schedule `dateFrom = dateTo = <yesterday>`, the service asks for `<today>`, `dateTo >= day` fails,
and the count is 0 instead of 1. Outside that window both name the same date and the spec passes.

Confirmed against the clock at the time of the failing isolation run: **05:13 IST 2026-08-20 /
23:43 UTC 2026-08-19** — inside the window. The spec would have gone green again at 05:30 IST.

## Why it matters

- It is the **third** distinct reason a full run can be red for something that is not a regression,
  after `voucher-controller` (#187) and the #184 worker crash. Each one costs a hand-triage, and
  **#107's unattended CI cannot hand-triage** — a nightly CI run is *exactly* the schedule that lands
  inside this window.
- It makes the known-pre-existing failure list time-dependent, which is precisely the property that
  makes such a list stop being useful.
- The same mistake is worth sweeping for: `setUTCHours(0, 0, 0, 0)` in a fixture is correct only where
  the code under test also reads a UTC day, and since #204 most operational reads are IST.

## What to build

1. **Fix the fixture** to state the same day the service reads — `istDate(new Date())`, or the existing
   IST day helpers in `src/common/ist-day.ts`, rather than `setUTCHours`.
2. **Pin it so the fix cannot rot**: the test must fail if the fixture drifts back to a UTC day. Note
   that this host runs on IST, so a naive assertion cannot distinguish the two for 18.5 hours a day —
   verify the pin by running it under a clock inside the window, or by injecting the "now" the service
   uses rather than relying on the wall clock.
3. **Sweep for siblings** — `grep -rn "setUTCHours(0, 0, 0, 0)" test/` and check each against whether
   its subject reads an IST or a UTC day. #204's own session found two such fixtures the first time;
   this is a third.

## Acceptance criteria

- [x] AC1 — `plant-zone-change-impact.e2e-spec.ts` passes at every hour of the day, demonstrated for a
      time inside 00:00–05:30 IST rather than argued.
- [x] AC2 — The fixture and `zone-mapping.service.ts` agree on one definition of "today", not two.
- [x] AC3 — Other test fixtures using a UTC midnight against an IST-day read are found and listed;
      each is either fixed or recorded as genuinely UTC-correct.
- [x] AC4 — The known-pre-existing failure list is restated with no time-of-day caveat.

## The sweep (AC3) — four other candidates, all safe, and the reason matters

`plant-zone-change-impact` was the **only** fixture deriving a day bucket from the **live** clock and
comparing it against an IST-day read. That is the property that makes a flake: a frozen constant can
be wrong, but it is wrong on *every* run, which a single green run exposes. The others:

| Site | Day source | Verdict |
|---|---|---|
| `special-ticket-api.e2e-spec.ts:100` | `NOW = new Date('2026-08-19T06:00:00Z')` — **frozen** | Safe. Deterministic by construction, and 06:00Z is mid-day in both zones. The schedules are historical and `PARTIAL`, so no "today" read reaches them. |
| `special-ticket-derivation.e2e-spec.ts:100` | same frozen `NOW` | Safe, same reasoning. |
| `commissioning-cohort.e2e-spec.ts:121` | live `new Date()`, but `setUTCHours(9, 0, 0, 0)` | Safe. 09:00 UTC is 14:30 IST — mid-day in both zones, so the two dates agree at every hour. The existing comment already reasons about exactly this. |
| `test/env/book8/book8-se-org.ts:73` | `ds.datasetNow`, derived from the dataset's latest ping | Safe. `book8-dataset.ts` is explicit that it uses no `Date.now()`, so the value is frozen with the CSV. |

None changed. Recording them is the point: the next person to grep `setUTCHours` should not have to
re-derive why four of the five hits are fine.

## Blocked by

none. Prerequisite in spirit for **#107** (CI), whose nightly schedule lands inside the failing window.
