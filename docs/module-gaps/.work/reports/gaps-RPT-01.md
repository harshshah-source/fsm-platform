# RPT-01 — the hero KPI is perfect because it is empty (E4, reproduced 2026-09-02)

S2 read the code. S3 called the endpoint. The code was right.

## What the API actually returned

`GET /api/reports/fleet-uptime` as `ops.head@fsm.test`, no parameters — exactly what the
dashboard sends:

```json
{"month":"2026-09-01","groupBy":"zone",
 "fleet":{"eligibleDeviceCount":0,"autoRecoveryClosures":0,"seRepairedClosures":0,"uptimePct":100},
 "rows":[]}
```

**Zero eligible devices. Zero closures. No zone rows. Uptime 100.**
`uptimePct()` (`reports.service.ts:703`) returns 100 when `window <= 0`, so an unwritten cube and a
flawless fleet are the same number. `ReportsPage.tsx:107` paints it green against the 98% target.

## The month that was actually computed

Same endpoint, `?month=2026-07`:

```
fleet: eligibleDeviceCount 15311 · seRepairedClosures 292 · uptimePct 56.19
rows:  East 5666/52.64 · North 2823/58.79 · South 1802/49.32 · UNZONED 2766/56.94 · West 2254/66.46
```

**56.19% is the truth. 100% is what the screen shows.** The real month is 41.81 points *below*
the contractual target; the fabricated month is 2 points *above* it. Every zone is failing and
every zone reads green.

## It repeats across the trend

`api/reports.ts:63` fans the hero tile out over the last six months. Called one month at a time:

| month | 04 | 05 | 06 | 07 | 08 | 09 |
|---|---|---|---|---|---|---|
| uptimePct | **100** | **100** | 100 | **56.19** | **100** | **100** |
| eligibleDevices | 0 | 0 | 20309 | 15311 | 0 | 0 |

Four of six points are fabricated from empty cubes (bold, `rows:[]`). The chart does not read as
"no data" — it reads as *a catastrophic July that we fully recovered from*. That is worse than a
blank chart, because it invents a remediation story.

Note 2026-08: it is the `previousUtcMonthStart` cron's own month
(`business-sweep-scheduler.service.ts:124,262`) and it is **also** empty — so the writer has not
merely lagged, it has not landed here at all. 2026-06 is a third flavour: 20309 real devices with
zero recorded downtime, i.e. cube present, downtime feed absent.

Contrast the sibling convention at `:709`: `ratePct()` returns **0** on a zero denominator. The
module already knows how to fail loud; the one hero KPI fails flattering.

## Fix boundary

`reports` owns only its own honesty: return `null`/`unavailable` when `eligibleDeviceCount === 0`
and make the tile degrade visibly. The producing end (why the cube is unwritten) is `ingestion`'s
and `scheduling`'s to price — standing rule, do not double-charge it here.
