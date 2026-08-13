# 234 — Cohort resolution curve: how fast a fitment batch comes online

**Completed 2026-08-13.** Backend-only. Frozen completion record — corrections go to INDEX /
SYSTEM-STATE, not here.

Issue: `.scratch/fsm-platform-v1/issues/234-commissioning-resolution-curve.md`
Origin: `audit/recently-commissioned-devices-investigation-2026-08-13.md` §5

---

## What was built

The operator ask included *"monitor how their inactivity/status changes over time."* FSM keeps no
historical device-status series, so the investigation enumerated every candidate source and only one
survived: `installed_at` and `first_reported_at`, two stored facts, one subtraction.

`GET /api/reports/commissioning/cohort` now carries a `resolution` block — % online by hours since
fitment — computed as `count(*) FILTER (…)` columns on the **same `GROUPING SETS` pass** as the
counts. No second query, no new endpoint, no new table, no background job, no dependency on the
scheduler or on ticketing.

| File | Change |
|---|---|
| `src/reports/commissioning.config.ts` | `RESOLUTION_BUCKET_HOURS` (4/12/24/48/72) + `RESOLUTION_MATURITY_HOURS` |
| `src/reports/commissioning-aggregation.service.ts` | `post_epoch` column in `graded`; 9 bucket/outcome columns; exported `resolution()` + its types |
| `test/commissioning-units.spec.ts` | +7 DB-free tests over `resolution()` |
| `test/commissioning-cohort.e2e-spec.ts` | +5 wiring tests |
| `test/probes/commissioning-population.probe.ts` | +1 live-`fsm` curve probe |

## The two decisions that make the curve correct

Both are exclusions, and both were found by looking at real data rather than by reasoning.

### 1. Maturity — a fitment must be old enough to be plotted

A device fitted two hours ago and still silent has not "failed to report within 72 h"; it has not had
72 hours. Counting it in the denominator of every band biases the curve downward, and biases it
**hardest on exactly the recent cohort an operator is reading**. `RESOLUTION_MATURITY_HOURS` (= the
widest band) excludes it, and the excluded count is reported (`totals.fitments - maturedFitments`)
rather than silently dropped. This is the cheap form of the right-censoring a survival model would do
properly; the residual it accepts — a fitment matured at exactly 72 h that would have come online at
100 h is recorded as never-online — is under 0.4% of samples.

### 2. The epoch gate must be SYMMETRIC — and the first cut was not

**This is the one worth reading.** The first implementation excluded pre-epoch fitments that came
*online* (their `first_reported_at` is a last-seen value, so the timing measures the epoch: median
~8,707 h against 17.26 h after) but left pre-epoch fitments that stayed *silent* in the denominator.

Every fixture test passed. The live probe did not agree:

```
sample=56  neverOnline=89  onlineUnmeasured=1960
<= 48h  cum=54  (37.2%)
```

**37.2% online by 48 h, against a measured reality above 90%.** The legacy blank-remark bulk-load
population — 1,960 fitments — sat on one side of the ratio only: excluded from every numerator band
because its timing is unmeasurable, but counted in the denominator whenever it happened to be silent.
Not a rounding error, an inverted conclusion, and it would have shipped as "our installs fail two
times in three."

The fix is one line of principle: **a fitment either carries comparable timing or it does not, and
what it happened to do cannot decide its eligibility.** Pre-epoch fitments leave the curve entirely,
whatever their outcome, reported once as `preEpochExcluded`. The same row then reads:

```
curve=65 (sample=56 neverOnline=9)  preEpochExcluded=2040
<= 48h  cum=54  (83.1%)
```

No fixture could have caught this — none had enough legacy rows. `test/probes/` earned its keep on
its second use.

## The identities

Three, all arithmetic rather than claims, and all asserted against both fixtures and the live mirror:

```
sampleSize + neverOnline            = curveFitments
curveFitments + preEpochExcluded    = maturedFitments
maturedFitments + (immature)        = totals.fitments
```

Bands are **differences between cumulative counts**, never independently counted, so a band cannot
disagree with the curve drawn above it. `cumulativeOnlinePct` is **null**, not 0, when the denominator
is empty — {@link NO_TIMING}'s rule applied to the curve, because on a chart 0% draws a line along the
floor while "no sample" must draw nothing at all. The complementary case is pinned too: a real sample
with nothing online is a measured 0%, not a null.

## Acceptance criteria

| AC | Status | Evidence |
|---|---|---|
| AC-1 buckets derive from the same `commissioned` expression | ✅ | via `ttfr_hours`, which is gated on it; unit + e2e |
| AC-2 epoch-gated exactly as `ttfr_hours` | ✅ | **and symmetrically** — see above; that is a strengthening of the AC as written |
| AC-3 holds the plan at `cohortDays=90` | ✅ | **26 ms** round trip after 9 added columns (21 ms before, 23.9 ms server-side pre-#234). One pass, no spill |
| AC-4 live shape | ⚠️ **restated** | 83.1% by 48 h and **flat after** (0 fitments in the 48–72 h band). The AC said 97.7%; that figure is New-Installation-only and pre-maturity-gate. The *property* — resolved by 48 h, flat after — holds; the literal does not, and the probe asserts the property |
| AC-5 null-not-zero on an empty sample | ✅ | unit test, plus its complement |

## Live `fsm` (2026-08-13)

```
#234 resolution curve (90-day cohort, operational)
  matured=2105 of 2625 fitments (520 immature)
  curve=65 (sample=56 neverOnline=9) preEpochExcluded=2040 beyond72h=2
  <=  4h  n= 2   cum=2  ( 3.1%)
  <= 12h  n= 9   cum=11 (16.9%)
  <= 24h  n=31   cum=42 (64.6%)
  <= 48h  n=12   cum=54 (83.1%)
  <= 72h  n= 0   cum=54 (83.1%)
```

**The sample is small (65) and will grow.** `DEFAULT_TTFR_EPOCH` is 2026-08-09, so only four days of
post-epoch fitments are mature enough to plot. That is honest rather than convenient: `sampleSize` is
reported on the payload precisely so the page can say how much it is standing on.

**A property that ages out on its own:** `COHORT_DAYS.max` is 90 and the epoch is fixed, so once the
epoch is more than 90 days old (~2026-11-07) no cohort window can contain a pre-epoch fitment,
`preEpochExcluded` becomes permanently 0, and `curveFitments = maturedFitments`. The contamination
disappears without a backfill or a migration.

## Testing

| Suite | Result |
|---|---|
| `commissioning-units.spec.ts` | **15** (was 8) — the curve arithmetic, DB-free |
| `commissioning-cohort.e2e-spec.ts` | **39** (was 34) — the wiring |
| `device-commissioning` · `dashboard-kpi-reconciliation` · `setup-env-allowlist` · `ops-explorer` ×2 | 8 · 16 · 5 · 20 · 44 |
| **Total** | **147 across 7 files, exit 0** |
| `commissioning-population.probe.ts` | 4, against live `fsm` |
| `tsc --noEmit -p tsconfig.json` | clean |
| `tsc --noEmit -p tsconfig.test.json` | 93 errors, unchanged pre-existing baseline |

**Where the arithmetic is pinned, and why it is not in the e2e.** Reaching these branches over HTTP
needs fixtures that are simultaneously matured (older than 72 h) and post-epoch (younger than
2026-08-09) — a window whose width is a function of today's date, and which was *empty* two days ago.
A test like that passes this week and silently stops exercising its branches later, which is worse
than not having it. The arithmetic is therefore unit-tested with every input stated (#217's precedent,
#156's reason), and the e2e asserts only wiring: that the curve is served, uses the same population as
the counts beside it, and satisfies its identities on real rows.

## Follow-up this did not close

**The calendar-time cohort inactivity series remains deferred**, with its precondition unchanged:
#229's auto-recovery must actually run before `failure_cycles` interval reconstruction means anything.
1,799 of the operational cohort's 2,183 cycles are still `OPEN`. Recorded in the issue, not forgotten.
