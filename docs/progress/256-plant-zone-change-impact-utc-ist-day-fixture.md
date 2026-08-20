# #256 — a fixture that told the truth for 18.5 hours a day

**Done 2026-08-20**, commit `bd7dd06`. Test fixture only; no `src/` change. One spec, one helper, one pin.

## What this closes

`ZoneMappingService.zoneChangeImpact` asks whether a plant's work is on **today's** day plan, and
reads today the way #204 ruled the whole system should:

```ts
// src/org/zone-mapping.service.ts:209
const day = istDate(new Date());                       // the IST calendar day
// …schedule: { ...liveScheduleFilter(), dateFrom: { lte: day }, dateTo: { gte: day } }
```

Its spec's fixture stated the day the old way:

```ts
// test/plant-zone-change-impact.e2e-spec.ts — before
const today = new Date();
today.setUTCHours(0, 0, 0, 0);                          // the UTC calendar day
```

IST is UTC+05:30, so from **00:00 to 05:30 IST** the UTC date is still yesterday. The fixture stamped
`dateFrom = dateTo = <yesterday>`, the service asked for `<today>`, `dateTo >= day` missed, and
`dispatchedTodayCount` came back `0` instead of `1`. For the other 18.5 hours the two dates coincide
and the spec passed.

That is the worst shape a test failure can take: **correct code, wrong for 23% of the clock, green
whenever anyone looks.** It cost this repo a red full-suite run that had to be triaged by hand, and it
was the third distinct non-regression reason a run could be red — after `voucher-controller` (#187)
and the #184 worker crash.

## How it surfaced

Not from a code change. Two full suites on the **same tree**, hours apart, disagreed:

| Run | Started (IST) | Result |
|---|---|---|
| 1 | 18:03 | 388 files, 1890 passed / **2** failed — the known `voucher-controller` pair |
| 2 | 23:33 | 388 files, 1889 passed / **3** failed — the pair **plus** this |

Run 2 crossed midnight IST while running; run 1 never entered the window. The spec reproduced **in
isolation**, which is what ruled out both the #255 fixture collision and #184 and pointed at the clock.

## What was built

| Piece | Substance |
|---|---|
| `scheduleDay()` | One named helper in the spec, `istDate(now)` — the same function the service calls, not a restatement of it. The fixture and the code under test now share **one** definition of the day. |
| The `#256` pin | Walks all 24 hours and asserts the fixture's day equals `istDate`'s at every one. Deterministic, DB-free, 2 ms — it fires whatever time the suite runs. |

The pin is the load-bearing part. The behavioural test alone cannot guard this: it only exercises the
hour the suite happens to run, so a reverted fixture looks fine for 18.5 hours out of 24. The pin also
asserts the converse — that from 18:30 Z onward the UTC and IST dates genuinely *do* differ — so it
cannot quietly degrade into comparing a definition with itself.

## Verification

**Both halves measured inside the failing window**, not argued:

| Time (IST) | State | Result |
|---|---|---|
| 05:13 | before the fix | **1 failed** / 3 passed — `dispatchedTodayCount` 0, expected 1 |
| 05:22 | after the fix | **4 passed** |
| 05:23 | after the pin | **5 passed** |

Sensitivity probe: revert `scheduleDay` to `setUTCHours(0,0,0,0)` → **both** the behavioural test and
the pin turn red; restore → green, restored file `diff`-verified byte-identical. The pin's red is the
one that matters, because it is the one that would still fire at 14:00.

Full backend suite after the fix (run 3, started 05:25 IST — i.e. begun inside the failing window):
**388 files, 1892 passed / 2 failed / 5 skipped, in a single pass with no #184 crash-retry.** The 2
failures are the `voucher-controller` pair and nothing else — the first full run in this sequence
whose entire red surface is that one known file. `plant-zone-change-impact` reported 5/5.

## The sweep (AC3) — four other candidates, all safe

`plant-zone-change-impact` was the **only** fixture deriving a day bucket from the **live** clock and
comparing it against an IST-day read. That is precisely the property that makes a flake — a frozen
constant can be wrong, but it is wrong on every run, which a single green run exposes.

| Site | Day source | Verdict |
|---|---|---|
| `special-ticket-api.e2e-spec.ts:100` | frozen `NOW = 2026-08-19T06:00:00Z` | Safe — deterministic, and 06:00 Z is mid-day in both zones. The schedules are historical and `PARTIAL`, so no "today" read reaches them. |
| `special-ticket-derivation.e2e-spec.ts:100` | same frozen `NOW` | Safe, same reasoning. |
| `commissioning-cohort.e2e-spec.ts:121` | live clock, but `setUTCHours(9, …)` | Safe — 09:00 Z is 14:30 IST, mid-day in both zones. Its existing comment already reasons about this. |
| `test/env/book8/book8-se-org.ts:73` | `ds.datasetNow`, from the dataset's latest ping | Safe — `book8-dataset.ts` is explicit that it uses no `Date.now()`. |

None changed. They are recorded so the next person to grep `setUTCHours` does not have to re-derive
why four of the five hits are fine.

## Why this was worth a separate issue rather than a quiet fix

It was found during #255's verification and could have been folded in silently. It was not, because
the two are different failures that happen to share a symptom: #255 was a fixture asserting something
false about the data model, this is a fixture asserting something false about the clock. Folding them
together would have made #255's "zero `beforeAll` collisions across two runs" claim un-auditable —
the reader could not tell which fix moved which number.

## The known-pre-existing failure list, restated (AC4)

With #255 and #256 both in, and with no time-of-day caveat:

- **`voucher-controller.e2e-spec.ts` — 2 tests, every run, every hour.** #187 (no `EngineerMaster`
  seed for the SE it authenticates as) compounded by #215 (nine specs re-zone the shared fixture SE).
  Those two must land together or `voucher-controller` fails *harder*; see #215's ordering trap.

That is the whole list. Anything else on a local run is worth treating as real.
