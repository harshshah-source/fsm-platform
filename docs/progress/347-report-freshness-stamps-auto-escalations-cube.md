# 347 — Report freshness stamps + the auto-escalations cube

**Done 2026-09-03.** Wave 2 of the module-gaps completion plan
(`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4), absorbing survey id RPT-03 and **closing #333**, whose
issue file remains the spec for the auto-escalations half. Red-first (backend observed red before the
fix; the admin half's tests were authored against surfaces that did not exist). No dependencies.

## What it closes

Two defects that share one property: **the number looked answered and was not.**

**1. "Data as of" was the browser's clock.** All four report cubes have always stored `computed_at`
(`schema.prisma:2695, 2719, 2754, 2813`), and no report payload ever returned it. `ReportsPage.tsx`
therefore set `new Date()` when its `fetch` resolved and labelled the result "Data as of". That is not
a weak stamp, it is an anti-stamp: it agrees with the wall clock whatever the state of the cube behind
it, so a `business-*` sweep dead for two days still printed *this morning* over two-day-old numbers.
The PRD's "Data-as-of Timestamp" requirement asks for the data time; this printed the render time.

The other three report pages — Root Cause Analytics, System Efficiency, ZM Performance Scorecard —
had **no stamp at all**, although the v2 reference draws the same header band on all four
(`21-reports.png`, `23-`, `24-`, `25-`). Two of those three are served entirely from a cube.

And there was **no age threshold anywhere**, so nothing could ever *read* stale even in principle.

**2. `auto_escalations` under-reported exactly when the queue was busiest (#333).** The intra-day leg
of the rollup predicated on the row's *current* `status` and on `updated_at`:

```sql
WHERE updated_at >= dayStart AND updated_at < dayEnd AND status = 'ESCALATION_REQUIRED'
```

Every resolver — `manualAssign`, `moveTickets` (#288), `assignTicket` / `assignLane` (#298) — rewrites
the `intraday_insertions` row **in place** to `ACCEPTED` at the moment of resolution. So a resolved
escalation matched neither half: not the status, and not the day it was raised on (its `updated_at` had
moved to the resolution instant). It vanished from every day. The faster a ZM cleared the escalation
queue, the lower their zone's "auto-escalations" read — the exact inversion of what the figure is for,
on a number ZMs are measured against on the scorecard.

The sibling leg immediately above it (cross-zone `AUTO_PLATINUM`) reads `created_at` and no status,
which is the correct shape. Two adjacent legs of one metric disagreeing is drift, not a decision.

## The shape of the fix

**Backend, `reports.service.ts`.** A `DataAsOf` interface (`{ dataAsOf: string | null }`) that all
seven report payload types extend. The four cube-backed reports answer `MAX(computed_at)` **over
exactly the rows that report read** — every cube query already `GROUP BY`s, so each group's max comes
back for free and the report-wide max is a fold over rows already in hand, not a second round trip.
The soft-inactive trend answers the newest `captured_at` in its window. The two live distributions
(work-type mix, verification outcomes) answer the server's query instant, because no cube sits between
the reader and the rows.

**Backend, `system-efficiency-aggregation.service.ts` (leg 11).** The intra-day leg now predicates on
`created_at` and `acceptance_deadline IS NULL`, matching the cross-zone leg's basis: *raised on day D,
whatever happened afterwards*.

**Admin.** `reportFreshness()` in `api/reports.ts` is the one place a report surface decides whether
the number in front of the reader is current, and `DataAsOfStamp` / `ReportMetaStrip` render it. All
four pages carry the reference's header band with the stamp on it.

## Decisions worth keeping

**`acceptance_deadline IS NULL` is the surviving marker of "raised as an escalation" — and it is the
only one.** #333's regression-risk section asked the implementer to confirm a marker exists rather
than infer one, and to escalate if none did. It does. Checked against every writer and every resolver:

| | `offered_se_id` | `acceptance_deadline` | `status` |
|---|---|---|---|
| `escalate()` / stranded-work, at creation | `null` | **`null`** | `ESCALATION_REQUIRED` |
| the same row after resolution | *the assigning SE* | **`null`** | `ACCEPTED` |
| `ASSIGNED_DIRECT` (system placed the work) | the SE | `now` | `ASSIGNED_DIRECT` |

`status` is overwritten on resolution. `offered_se_id` is overwritten too — and with a misleading
value, the engineer who *took* the work rather than one it was offered to, because it was offered to
nobody. `acceptance_deadline` survives, because an escalation has no acceptance window to bound so
both writers leave it null, and **nothing in the tree ever writes that column after creation**
(`grep acceptanceDeadline src/` — three sites, all `create`). `insertion_type` cannot do the job:
`SYSTEM_CRITICAL` covers both the direct-assign path and the escalation path.

This is a genuine load-bearing assumption, so it is stated in the SQL comment: a future writer that
creates a deadline-less insertion for some other reason would silently join this count.

**The historical recompute is NOT applied, deliberately (#333 AC3).** The aggregation *is* idempotent
per day — delete + insert inside one transaction, pinned by two tests — so replaying history is safe.
It is not replayed here because the cron only ever computes the *previous* day
(`BusinessSweepSchedulerService.systemEfficiencyTick`), and a multi-day replay is a different job with
a different failure mode, which this issue does not own. The door already exists:
`POST /reports/efficiency/recompute?day=` (Operations Head) rebuilds any single day on demand, and
that is the supported path once someone decides how far back is worth restating. Recorded in the
service docblock as well as here, so the next reader does not have to re-derive it.

**The staleness threshold is two missed cadences: 48h.** A threshold had to be a real number derived
from something, not a taste. Every cube behind a report is rebuilt by a **daily** sweep —
`business-system-efficiency` 01:30, `business-fleet-uptime` 03:00, `business-root-cause` 03:15,
`business-zm-performance` 03:30, all `0 H * * *`-shaped since #346 made the three "monthly" cubes
cover the in-flight month. So 24h is the expected cadence for all four and one threshold serves them.
Stale past `2 ×` that, the same rule the ingestion detectors use: one missed run is a late cron or a
long recompute, two is a stopped one. A badge that cries wolf every morning is one operators learn to
ignore, which is the same outcome as having no threshold at all — which is what we had.

**`null` is "No cube computed yet", never "now".** Same reasoning as #346's `null` uptime, one layer
up: an absence of computation is not a computation. A report defaults to the current month/day, which
is precisely the window a sweep may not have reached, so "no cube row" is a *normal* state of these
pages and not an error — it says so in words rather than leaving the timestamp slot blank, because a
blank where a stamp goes reads as "fine".

**An unparseable stamp is `missing`, not `fresh`.** Both bugs this slice closes presented as
freshness. Defaulting the unknown case to "fine" is how they stayed invisible for as long as they did.

**The stamp moved to where the reference draws it.** `ReportsPage`'s old strip pushed the stamp to the
right with `ml-auto`; refs 21/23/24/25 all place it immediately after the scope chip. The four pages
now share one `ReportMetaStrip`, so the band cannot drift page to page.

## What was tested, and why in that shape

**#333's three cases are one fixture in its own zone.** The escalation cases live in a zone created
just for them (`Z-esc-*`) so the pre-existing `autoEscalations === 1` assertions — which measure the
cross-zone leg — keep measuring exactly that. The three insertion rows are the three shapes the metric
has to tell apart, and the discriminating test is **(A)**: raised 08:00, resolved 09:00 the same day.
That is the case that read `0` before this slice, and it reads `0` under any predicate that consults
current status. **(B)** raised on D and resolved on D+1 pins that resolution does not *move* an
escalation to another day; **(C)** an `ASSIGNED_DIRECT` insertion pins that "the system placed this
work" is not an escalation, which is the failure mode a lazier predicate (`status <> 'ACCEPTED'`, or
dropping the status filter entirely) would introduce.

**`dataAsOf` is asserted against the cube's own rows, not against "recent".** Each spec reads
`MAX(computed_at)` out of the table itself and asserts equality. A `toBeGreaterThan(someTimeAgo)`
assertion would pass just as happily against a `new Date()` — the very bug being closed.

**The freshness rule is unit-tested at its boundary.** `report-freshness.test.ts` pins that exactly
48h is still fresh and 48h+1min is stale, because the defect was a threshold that existed nowhere; a
test that only checked "3 hours is fresh, 5 days is stale" would pass against a hard-coded `'fresh'`.

## Acceptance criteria

- **AC1 — every `/reports/*` payload carries `dataAsOf` (null when no cube row exists).** ✅ All seven
  `ReportsService` reads. Cube-backed: `MAX(computed_at)`, null on an empty window. Live: the server's
  query instant. `commissioning/cohort` and `commissioning/installers` already carried `generatedAt`
  and are served by a different service (`commissioning-aggregation.service.ts`, not in this slice's
  file list) — noted as the one `/reports/*` pair that names the field differently.
- **AC2 — the report pages print `dataAsOf` and label "No cube computed yet" when it is null.** ✅ All
  four pages, via one `ReportMetaStrip`, with a real 48h threshold that flips the badge to stale.
- **AC3 — #333's AC1–AC3 are met.** ✅
  - *#333 AC1 — an escalation resolved on the day it was raised still counts for that day.* ✅
  - *#333 AC2 — both legs use the same basis (raised, not current status), stated in a comment.* ✅
  - *#333 AC3 — the recompute decision for historical days is recorded.* ✅ Not applied, with the
    reason, in the service docblock and above.

## Tests, verbatim

Backend (`.scratch/locks/backend-test.sh npx vitest run …`) — 5 files, 35 tests, all passing:

```
 ✓ test/system-efficiency-report.e2e-spec.ts (10 tests) 2388ms
 ✓ test/report-mix-outcomes.e2e-spec.ts (7 tests) 3531ms
 ✓ test/reports-controller.e2e-spec.ts (8 tests) 2696ms
 ✓ test/root-cause-report.e2e-spec.ts (6 tests) 1374ms
 ✓ test/zm-scorecard-report.e2e-spec.ts (4 tests) 1261ms
 Test Files  5 passed (5)
      Tests  35 passed (35)
```

The same five files before the fix — 9 of the new assertions red, for the right reasons (`expected 2
to be 0` on the same-day-resolved escalation; `expected NaN to be <ms>` on every `dataAsOf`):

```
 Test Files  5 failed (5)
      Tests  9 failed | 26 passed (35)
```

Admin (`cd apps/admin && npx vitest run …`) — 5 files, 25 tests, all passing:

```
 Test Files  5 passed (5)
      Tests  25 passed (25)
```

`test/fleet-uptime-honesty.test.tsx` (12 tests) re-run as the #346 regression pin on the same pages:
passing. `npx tsc --noEmit` (backend) reports nothing under `src/reports/`; `npx tsc -b` (admin) is
clean.

## Where the plan and the issue were wrong

- **`reports.service.ts` line numbers.** The plan cites none for this slice, but the schema lines it
  does cite are stale: `computed_at` is at `2695, 2719, 2754, 2813`, not `2689, 2713, 2748, 2807`
  (+6). The columns themselves are exactly as described.
- **"the 'Data as of' stamp changes source; no layout change" is true of one page, not four.** Only
  `ReportsPage` had a stamp to change the source of. Root Cause Analytics, System Efficiency and ZM
  Scorecard had no header band at all, so the band the reference draws had to be **built**, not
  re-sourced. The issue's "UI surfaces: (modified) … no layout change" reads as though all four
  already carried one.
- **#333's "no surviving marker" worry does not bite.** Its regression-risk section flagged that a
  resolved escalation might carry nothing to identify it by, and that finding none would be an HITL
  escalation. `acceptance_deadline IS NULL` survives resolution; no escalation was needed.
- **`insertion_type` cannot be the discriminator**, contrary to the first candidate #333 lists —
  `SYSTEM_CRITICAL` is written by both the escalation path and the direct-assign path.

## Follow-ups this slice does not own

- **#364 — "Report pages consume what the API already offers."** The three sub-pages still have no
  filter controls and no scope/role chips on their new band, so the band carries the stamp alone. That
  is #364's surface, and the band is now there for it to fill.
- **A historical `auto_escalations` backfill.** Deliberately not run (above). If a range ever needs
  restating, the per-day Operations-Head recompute endpoint is the path; an unattended multi-day
  replay job would be a new issue.
- **Leg 11's comment mentions a "cycle ESCALATED" leg that does not exist** — the header names three
  sources and the code has two. Left as found; naming or removing the third is a metric-definition
  question, not this slice's.
- **The `commissioning/*` reports name their stamp `generatedAt`, not `dataAsOf`.** They are served by
  `commissioning-aggregation.service.ts`, outside this slice's file list. Worth unifying so one field
  name means "when was this computed" across the whole `/reports/*` surface.
