# Handoff — #261 and #260 are DONE; next is **#262**, the last thing blocking #275 (session of 2026-08-23)

**Repo:** `C:\fsm-platform-backup` · branch `feat/autoplant-integration` · **nothing pushed**
(32 ahead of `origin`). **Nothing is in flight. No uncommitted work of ours.** `git status` remains
~99 files, every one of them another session's (#239 acting-zone + #236 commissioning + admin chart
work) — **do not commit them.** `docs/SYSTEM-STATE-2026-07.md` is among them: it carries **84 lines of
somebody else's uncommitted edits** alongside ours. Both of this session's commits to it staged only
our own hunks; do the same.

> Placed in `docs/audits/` per the operator's standing request. Its two predecessors from this session
> were `git mv`'d to `docs/archive/` with ARCHIVED banners. **Apply the same when this one is spent.**

**Predecessors:** `docs/archive/handoff-2026-08-23-261-done-260-next.md`, and behind it
`docs/archive/handoff-2026-08-21-259-done-261-next.md`. **Their "facts that cost time" and "open
operator decisions" sections still hold and are not repeated here.**

---

## 0. Where the track stands

- **P8: 11 of 16 done** — `#258`, `#178`, `#269`, `#177`, `#266`, `#265`, `#259` (+`#252`), `#261`
  (+`#132`), **`#260` (new)**. Still open: **`#262`** → `#264` · `#263` · `#268` · `#267` · `#270` ·
  `#271`.
- **P9: 3 of 6 done** — `#272`, `#273`, `#274`. **`#275` is blocked on #262 and nothing else now.**
  The #275 chain the operator ruled must be cleared in order (#265 → #259 → #261 → #260 → #262) is one
  issue from done.

**Commits this session:** `cf6f9de` `5a044ee` `b115bfd` (#261) · `cf5c799` + docs (#260).
Full rationale: `docs/progress/261-dispatch-run-heartbeat-reaper.md` and
`docs/progress/260-dispatch-cron-bounded-retry.md`. Do not re-derive either.

## 1. The dispatch run's shape, as #262 inherits it

Four issues have now rebuilt this path and it is worth having the whole picture before touching it:

```
runForActiveZones(now, opts)
  ├─ reapStaleDispatchRuns(now)                    #261 — free zones whose holder died
  ├─ admit(...)  ── CONFLICT ──► [#260 patience loop: sleep → reap → re-admit] ──► 409, ZERO rows
  │                                                #259 — a run that never happened leaves no history
  └─ execute(...)
       ├─ processZone(z) for each admitted zone    beat after each (#261)
       ├─ waitOutContention(...)                   #260 — promote CONTENDED rows in place, dispatch
       └─ conditional finalize (updateMany on RUNNING)   #261 — a reaped run stays reaped
     finally: releaseStrandedClaims(runId)         #259 — a run that unwinds frees its zones
```

**Three rules any new writer inherits.** They are not stylistic:

- **Never write a run row or a claim row by primary key alone.** Every writer carries
  `status = 'RUNNING'` (or `'CONTENDED'` for the promotion). A PK write silently resurrects a state
  somebody else already closed — #265's `liveScheduleFilter()` rule, now enforced in four places.
- **Claims are taken in ascending zone id.** Two concurrent admissions therefore cannot deadlock.
  #262's per-SE transactions must not break that ordering.
- **`heartbeat_at` must keep being touched by any new long phase.** #262 splits the per-zone
  transaction into per-SE ones; the issue itself says to beat after every SE batch. A phase that
  forgets is a run that reaps itself mid-flight.

## 2. What #262 will find that its issue does not say

- **`processZone` is the seam it wants.** #260 extracted `execute`'s loop body into `processZone(zoneId,
  ctx, summary, totals)` over a named `RunTotals`, precisely because the loop gained a second caller.
  #262 splitting a zone into per-SE transactions changes what happens *inside* `processZone` and should
  not need to touch `execute` at all.
- **`RunTotals` is the invariant carrier.** A run's columns equal the sum of its zone cards *by
  construction*, and that only holds because one function folds a zone in. If #262 adds a counter, add
  it to `RunTotals`, not to a local.
- **`dispatch_run_zones` now has four statuses and a promotion path.** A zone can go
  `CONTENDED → RUNNING → DONE` within one run (#260). Any new read that assumes CONTENDED is terminal
  is wrong, and any new writer of the claim must preserve `contended_with_run_id` — it is the only
  trace of a collision the run recovered from.
- **#124's effective snapshot still rides with #262** (INDEX says so, and it has not moved).

## 3. Test-method traps these two issues paid for

**One signature change re-aimed FOUR sibling tests across the two issues.** #261 changed the per-zone
finalize to `updateMany` and broke three tests that named the old writer (#259's wedge, #213's wedge,
#113's fake Prisma); #260 made the cron tick patient and broke a fourth (#213's "the tick skips"),
which began *timing out* rather than failing cleanly. **A timeout in an unrelated-looking spec after a
behaviour change is a re-aim, not a flake.**

The non-obvious repair: the two wedges **cannot** simply break `updateMany`, because
`releaseStrandedClaims` — the release they exist to prove — now uses it too. They discriminate on the
argument that separates the writers: **the finalize names a `zoneId`, the release does not.**

**When a behaviour change makes an old test's premise obsolete, decide which contract it pins.**
#213's tick test pins the *guard* (a second run is never started over a first), not the *patience*, so
it now runs with `deadlineMs: 0` — the documented try-once switch — and asserts exactly what it always
did. Patience got its own spec. Weakening the old test instead would have lost the guard.

**`test/setup-env.ts` is an allowlist and a new env prefix must be added to it.** #261 shipped
`DISPATCH_STALE_RUN_MIN` without doing so, and #260 caught it: a developer's own `.env` was reaching
the suite, which is exactly the class #182 inverted that list to close. `DISPATCH_` is in now. **Any
new env var outside `AUTOPLANT_ / AUTO_RECOVERY_ / BUSINESS_SWEEP / COMMISSIONING_ / DISPATCH_ /
INGESTION_ / PARTITION_ / PLANT_ELIGIBILITY_ / DB_` needs a line there.**

**Do an enabling refactor as its own green step.** #260's `processZone` extraction was landed and
verified behaviour-preserving on 34 tests *before* a line of the feature was written. That is what made
the subsequent RED unambiguous.

**Sensitivity discipline:** thirteen green-on-arrival assertions across the two issues, every one
proven by deliberate breakage with the red recorded. The tables are in the two progress reports.

## 4. Facts that will cost you time to rediscover

**New this session:**

- **The test DB's migrations come from `test/global-setup.ts` (`prisma migrate deploy`)**, so a bare
  `npx vitest run <file>` applies pending migrations. `npx prisma generate` is still manual.
- **`ALTER TYPE … ADD VALUE` is fine in Prisma's migration transaction on PG16** provided the new value
  is not *used* in the same migration.
- **`snapshot_runs` and `master_sync_runs` each permit exactly one RUNNING row.** A test needing two
  live ingestion runs must stage one per table.
- **There are only ~5–6 active zones (zones with a plant) in the test DB**, so an unscoped
  `runForActiveZones` in a spec is cheap — but it claims *every* one of them, so clean up **by run id**,
  not by your own zone, or the next spec file is refused.
- **A P2002 from a single statement is safe to catch**; the "a P2002 aborts its transaction" rule
  (#265) applies to interactive `$transaction` callbacks only. #260's promotion relies on this.
- **`npx tsc -p tsconfig.test.json --noEmit` is dirty at HEAD with ~32 files** of another session's
  work. Ours are clean. Filter to your own hunks; a clean run is not achievable.
- **Large heredocs still fail to parse in the Bash tool.** Write the file with the Write tool. This
  fired again on both progress reports.
- **A trailing `echo "exit=$?"` reports the echo, not the suite.** Redirect to a log and read the exit
  code off the `node scripts/run-tests.mjs` invocation itself.

**Measured clean, 2026-08-23 (after #260):** 403 files / 1999 tests passed / 5 skipped / **0 failed**,
four chunks each exit 0, **no crash retries**. Admin (unchanged by #260) 104 files / 544 passed — its
single reported "error" is the **pre-existing** `TicketDetailDrawer.tsx:440` fault.

## 5. Open operator decisions carried forward (none block #262)

Unchanged, all four still open:

1. **#178's backfill is built and NOT executed.** Its population is exactly #243's C1+C3 (measured
   3,310 / 4,402; the issue's "351" is stale). #243 remains **HITL-gated and unexecuted**; running
   #178's `--apply` first would consume those rows under a different reason and destroy #243's
   `DEV_CLEANUP` rollback handle. Re-measure at execution time.
2. **#272 Q1** — Device Detail panel: retired, or a deep-link shortcut? Due before **#277**.
3. **#272 Q3** — does the ZM get Distribute, or only OH + CSM? Due before **#276**.
4. **#258's rulings are still not recorded in `CONTEXT.md`** — open since #258, now carried by six
   handoffs. A small docs task nobody has picked up, not a blocked one.

**Ruled previously, do not reopen:** clear the #275 chain in order · the approved design's `PASSED` on
an over-capacity candidate is overridden by Q2 and #274's AC-2 · tier crossing is measured against the
best still-**passing** tier · `TIER_NOT_REACHED` is not a verdict on the candidates read · "refuse an
override outright on a terminal schedule" is **#271's** question.

## 6. Follow-ups still worth filing if you touch the area

Carried, still unactioned:

- **`GET /schedules/candidates` fans out one `orderedCandidatesForPlant` call per plant** — **#276's
  Distribute may ask for many more at once and should measure before assuming it scales.**
- **The intra-day manual-assign path has no admin client at all.** **#277** owns the modal.
- **The runs-list row has no zone outcome.** A ZM whose zone was contended sees `zones: 0` and all-zero
  totals — correct but silent about *why*. **#260 makes this slightly better and slightly worse:** a
  briefly-contended zone now recovers and shows DONE, so a row that *does* say CONTENDED means the run
  waited its full deadline and still lost — more meaningful, and still invisible on the list.
- **`ABORTED` has no operator-facing explanation beyond the badge.** A one-line "reaped at HH:MM after
  N minutes without a heartbeat" on the run detail would close it; the data is already on the row.

New, from this session:

- **Nothing records how long a patient run waited.** A run that recovered a zone at 05:14:30 and one
  that got it at 05:00:01 are indistinguishable on the ledger — both plain SUCCESS. `started_at` on the
  promoted claim row does carry it (it is re-stamped at promotion), so a "waited Nm" column is derivable
  without a migration. Worth a follow-up if anyone wants to tune the deadline against reality rather
  than against the 15-minute guess.

## 7. Suggested skills

- **`/tdd`** — mandatory. The seam-agreement step is what surfaced that #260's patience needed **two**
  sites rather than one; the single-site version was already written when the first RED disproved it.
- **`/code-review`** — one pass over `git diff dc7ea79..HEAD` before starting #262. That range is now
  five commits across two issues and is the largest single change to the dispatch path since #213.
- **`/diagnose`** — only if a chunked run fails *and* re-running that chunk alone reproduces it.

**Reading order for a fresh session** (per `CLAUDE.md`): `CLAUDE.md` → `docs/SYSTEM-STATE-2026-07.md`
(§3f now carries the claim, the reaper and the patience) → `.scratch/fsm-platform-v1/INDEX.md`
(§§ P8, P9 + the last four session-log rows) → the issue being worked → then this file.
