> **ARCHIVED 2026-08-23.** Spent: #261 landed (`cf6f9de`, `5a044ee`). Nothing here is current —
> see `.scratch/fsm-platform-v1/INDEX.md`, `docs/SYSTEM-STATE-2026-07.md` and the successor handoff.

# Handoff — #259 is DONE; the road to #275 is now **#261 → #260 → #262** (session of 2026-08-21)

**Repo:** `C:\fsm-platform-backup` · branch `feat/autoplant-integration` · **nothing pushed**
(27 ahead of `origin`). **Nothing is in flight. No uncommitted work of ours.** `git status` remains
~100 files, every one of them another session's (#239 acting-zone + #236 commissioning + admin chart
work) — **do not commit them.**

> Placed in `docs/audits/` following its two predecessors, per the operator's standing request. Its
> predecessor `handoff-2026-08-21-p8-p9-274-265.md` was `git mv`'d to `docs/archive/` with an ARCHIVED
> banner this session. **Apply the same when this one is spent.**

**Predecessor:** `docs/archive/handoff-2026-08-21-p8-p9-274-265.md`. **Its §2 (how to run the suite),
§4 (facts that cost time) and §5 (open operator decisions) still hold and are not repeated here** —
read them. Only what changed or is new is below.

---

## 0. Where the track stands

Source of truth is `.scratch/fsm-platform-v1/INDEX.md` §§ P8, P9.

- **P8: 9 of 16 done** — `#258`, `#178`, `#269`, `#177`, `#266`, `#265`, **`#259` (new)**, and
  **`#252` closed inside #259**. Still open: `#261` → `#260` → `#262` → `#264` · `#263` · `#268` ·
  `#267` · `#270` · `#271`.
- **P9: 3 of 6 done** — `#272`, `#273`, `#274`. **`#275` still blocked** on the #262 transaction shape.

**Commits this session:** `849dcc1` (implementation) · `89f1f56` (docs).
Full rationale: `docs/progress/259-zone-claim-admission.md`. Do not re-derive it.

## 1. What #259 leaves you, and what it deliberately did not do

Admission is now a **row**, not a `Map`. `dispatch_run_zones` is created `RUNNING` at admission,
finalized `DONE`/`ERROR` at completion, `CONTENDED` for a zone the run asked for and could not have.
Partial unique `ux_dispatch_run_zones_one_running_per_zone ON dispatch_run_zones(zone_id) WHERE
status = 'RUNNING'`.

**#261 starts here, and its job is precisely the half #259 could not do.** `releaseStrandedClaims`
(`dispatch-run.service.ts`) finalizes claims in a `finally`, so a run that *unwinds* releases its
zones. A process that **dies** does not, and leaves a `RUNNING` claim refusing that zone forever.
`dispatch-zone-claim-admission.e2e-spec.ts` pins the claim surviving a restart (AC-4) **specifically
so #261 has something to reap** — that test is a feature, not an obstacle; do not weaken it.

Three things #261 will want and does not have to invent:

- **`heartbeat_at` has no column yet.** #261's own issue asks for it plus an `ABORTED` status. The
  claim row is the natural carrier; `DispatchZoneClaimStatus` is an enum, so adding a value is a
  migration, not a string change.
- **The reaper must not race a live finalize.** Every existing writer of a claim is keyed on
  `status = 'RUNNING'` (`releaseStrandedClaims`) or on `runId_zoneId` (`finalizeZoneClaim`). Keep the
  `status` predicate in the reaper's `where` for the same reason #265's `liveScheduleFilter()` exists:
  a write by primary key silently resurrects a state somebody else already closed.
- **`claimantsOf` vs `holdersFor`** (both private, `dispatch-run.service.ts`) answer *different*
  questions and the distinction is load-bearing — see §2.

## 2. Read this before you touch the claim reads

**`holdersFor` = "who holds this zone right now" (RUNNING only). `claimantsOf` = "who took this zone
from me" (latest claim row, whichever status).** They are not interchangeable, and collapsing them
reintroduces a defect that took a barriered test to find:

The loser of an admission race originally re-read *live* claims after its rollback. The winner can
finalize its claim between the loser's failed insert and that read, so the loser got `inFlight: []`
and a **bare 409 naming nobody** — the one thing #213 exists to prevent. Intermittent: green 3 runs
out of 5. The fix reads the latest claim row *inside* the losing transaction, where the row the insert
collided with is committed and therefore guaranteed visible.

**If you add a reaper that rewrites claim rows, re-check `claimantsOf`'s `ORDER BY zone_id, started_at
DESC, id DESC`** — it assumes the newest claim row for a zone is the one you collided with, which is
true only because no second claim can be taken while the first is RUNNING.

## 3. Test-method traps this session paid for

Three, all new, all cheap to hit again:

1. **A barrier at the read→write gap is not enough when the run under test is stubbed.** The winner
   can claim, dispatch, finalize *and release* before the loser reaches its insert — at which point
   both callers legitimately succeed and the test reports **two winners**. The zone has to be
   **parked** as well (block the winner inside the recommender), so whichever caller wins is still
   holding the claim when the other tries. `test/support/concurrency.ts` warns about the
   start-together race; this is the next trap along.
2. **`vi.restoreAllMocks()` destroys a Prisma delegate method.** A delegate's methods are not own
   properties, so `vi.spyOn` writes one and `restoreAllMocks` **deletes** it, leaving nothing:
   `companyTierOverride.findMany is not a function` for every later test in the file, reported against
   whichever test ran next. Patch Prisma delegates **by assignment with an explicit restore** — the
   idiom `dispatch-in-flight-guard.e2e-spec.ts` already used.
3. **A wedge test aimed at the wrong write proves nothing.** Breaking the *run-level* finalize leaves
   nothing stranded, because the per-zone finalize already closed every claim; the test passes whether
   or not the release exists. Verified by deleting the release and watching it stay green. Aim at the
   per-zone write. The same drift had reached #213's own wedge test and was corrected there.

**And the standing rule that keeps earning its keep:** six tests here were green on arrival, and each
one's sensitivity was verified by deliberate breakage with the red recorded. Two of those breaks
(global refusal, contended-not-affecting-status) restore real historical behaviour.

## 4. Facts that will cost you time to rediscover

**New this session, all measured:**

- **`INSERT … ON CONFLICT DO NOTHING` is the way to do an admission test in this codebase.** A P2002
  aborts its interactive transaction (#265's finding), so insert-and-catch cannot be recovered from
  in place. `DO NOTHING` returns a row count instead, which is what lets a multi-step admission live
  in one rollback-able transaction. Prisma's `tx.$executeRaw` returns that count.
- **A no-target `ON CONFLICT DO NOTHING` catches the partial unique AND the `(run_id, zone_id)`
  unique.** That is fine here because a run inserts each zone once; if you ever need to tell them
  apart you must name the conflict target, and inferring a partial index needs its `WHERE` repeated.
- **`ON CONFLICT DO UPDATE … RETURNING` was rejected**, though it would return the holder atomically:
  a no-op update takes a row lock on *the holder's* claim row and writes a new tuple version, which
  can block or deadlock against the holder's own finalize.
- **Claims are taken in ascending zone id** (`activeZoneIds` orders by zone id) so concurrent
  admissions cannot deadlock on speculative inserts. Any new multi-zone writer must keep that order.
- **`dispatch_run_zones.status` has no DEFAULT, deliberately.** Two fixtures had to be updated
  (`dispatch-run-removed-since`, `dispatch-transparency-api`); that compile error is the point.
- **`npx tsc -p tsconfig.test.json --noEmit` is dirty at HEAD** — `test/scoring.spec.ts(16,73)`, another
  session's uncommitted work. Filter to the files you touched; do not treat a clean run as achievable.
- **`prisma migrate dev --skip-seed` is not a valid flag here.** `run-tests.mjs` applies migrations
  itself before the suite; `npx prisma generate` is the only thing you need to run by hand.

**Still true from the predecessor** (not repeated): the four-chunk foreground suite run and the two
"green-looking" traps · `meta.target` does not exist under this driver adapter · a P2002 aborts its
transaction · `work_schedules_one_active_per_se_zone_day` keys `(se_id, zone_id, date_from)` ·
`OVERRIDDEN` is a LIVE schedule status · a `beforeAll` that throws reports as *skipped tests + a
failed file* · large python heredocs intermittently fail to parse in the Bash tool (write the script
to a file) · a python patch script whose `write` is the last statement saves nothing when an assert
fails — **keep that shape** · no prettier, no backend eslint · `fileParallelism: false` ·
`TicketDetailDrawer.tsx:440` is a **pre-existing** admin fault.

## 5. Open operator decisions carried forward (none block #261/#260/#262)

Unchanged from the predecessor's §5, all four still open:

1. **#178's backfill is built and NOT executed.** Its population is exactly #243's C1+C3 (measured
   3,310 / 4,402; the issue's "351" is stale). #243 remains **HITL-gated and unexecuted**; running
   #178's `--apply` first would consume those rows under a different reason and destroy #243's
   `DEV_CLEANUP` rollback handle. Re-measure at execution time.
2. **#272 Q1** — Device Detail panel: retired, or a deep-link shortcut? Due before **#277**.
3. **#272 Q3** — does the ZM get Distribute, or only OH + CSM? Due before **#276**.
4. **#258's rulings are still not recorded in `CONTEXT.md`** — open since #258, now carried by four
   handoffs. This is a small docs task nobody has picked up, not a blocked one.

**Ruled previously, do not reopen:** clear the #275 chain in order · the approved design's `PASSED`
on an over-capacity candidate is overridden by Q2 and #274's AC-2 · tier crossing is measured against
the best still-**passing** tier · `TIER_NOT_REACHED` is not a verdict on the candidates read ·
"refuse an override outright on a terminal schedule" is **#271's** question.

## 6. Follow-ups still worth filing if you touch the area

Both carried from the predecessor, neither actioned:

- **`GET /schedules/candidates` fans out one `orderedCandidatesForPlant` call per plant** — bounded by
  what a human drafts, but **#276's Distribute may ask for many more at once and should measure before
  assuming it scales.** No cap, deliberately.
- **The intra-day manual-assign path has no admin client at all.** **#277** owns the modal; #265 made
  that endpoint's 409 byte-identical to the one `apps/admin/src/api/schedules.ts` already parses.

New, from this session:

- **The runs-list row has no zone outcome.** A ZM whose zone was contended sees a run with `zones: 0`
  and all-zero totals, which is correct but silent about *why*. The run detail says CONTENDED; the
  list does not. Out of #259's scope (its UI surface is the detail card) and a one-field addition
  whenever somebody is in `listRuns`.

## 7. Suggested skills

- **`/tdd`** — mandatory, and the seam-agreement step earned its keep again: it is what put the row
  counts (not "no error thrown") into AC-5.
- **`/code-review`** — one pass over `git diff 768bc4e..HEAD` before starting #261.
- **`/diagnose`** — only if a chunked run fails *and* re-running that chunk alone reproduces it.

**Reading order for a fresh session** (per `CLAUDE.md`): `CLAUDE.md` → `docs/SYSTEM-STATE-2026-07.md`
(§3f now carries the zone claim) → `.scratch/fsm-platform-v1/INDEX.md` (§§ P8, P9 + the last three
session-log rows) → the issue being worked → then this file.
