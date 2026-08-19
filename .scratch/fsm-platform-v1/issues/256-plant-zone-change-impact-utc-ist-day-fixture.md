# 256 — `plant-zone-change-impact` fails every night between 00:00 and 05:30 IST

Status: ready-for-agent
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

- [ ] AC1 — `plant-zone-change-impact.e2e-spec.ts` passes at every hour of the day, demonstrated for a
      time inside 00:00–05:30 IST rather than argued.
- [ ] AC2 — The fixture and `zone-mapping.service.ts` agree on one definition of "today", not two.
- [ ] AC3 — Other test fixtures using a UTC midnight against an IST-day read are found and listed;
      each is either fixed or recorded as genuinely UTC-correct.
- [ ] AC4 — The known-pre-existing failure list is restated with no time-of-day caveat.

## Blocked by

none. Prerequisite in spirit for **#107** (CI), whose nightly schedule lands inside the failing window.
