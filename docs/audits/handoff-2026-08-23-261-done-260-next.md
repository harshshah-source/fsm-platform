# Handoff — #261 is DONE (and #132 with it); next is **#260 → #262** (session of 2026-08-23)

**Repo:** `C:\fsm-platform-backup` · branch `feat/autoplant-integration` · **nothing pushed**
(30 ahead of `origin`). **Nothing is in flight. No uncommitted work of ours.** `git status` remains
~100 files, every one of them another session's (#239 acting-zone + #236 commissioning + admin chart
work) — **do not commit them.**

> Placed in `docs/audits/` per the operator's standing request, as its three predecessors were. Its
> predecessor `handoff-2026-08-21-259-done-261-next.md` was `git mv`'d to `docs/archive/` with an
> ARCHIVED banner this session. **Apply the same when this one is spent.**

**Predecessors:** `docs/archive/handoff-2026-08-21-259-done-261-next.md` and, behind it,
`docs/archive/handoff-2026-08-21-p8-p9-274-265.md`. **Their "facts that cost time" and "open operator
decisions" sections still hold and are not repeated here.** Only what changed or is new is below.

---

## 0. Where the track stands

Source of truth is `.scratch/fsm-platform-v1/INDEX.md` §§ P8, P9.

- **P8: 10 of 16 done** — `#258`, `#178`, `#269`, `#177`, `#266`, `#265`, `#259` (+`#252` inside it),
  and **`#261` (new, +`#132` closed inside it)**. Still open: `#260` → `#262` → `#264` · `#263` ·
  `#268` · `#267` · `#270` · `#271`.
- **P9: 3 of 6 done** — `#272`, `#273`, `#274`. **`#275` still blocked** on the #262 transaction shape.

**Commits this session:** `cf6f9de` (ingestion half) · `5a044ee` (dispatch half) · docs commit.
Full rationale: `docs/progress/261-dispatch-run-heartbeat-reaper.md`. Do not re-derive it.

## 1. What #261 leaves you

`dispatch_runs.heartbeat_at` + `ABORTED` + `reapStaleDispatchRuns(now)`, reaping at **every
admission** and on a 3-minute `business-dispatch-reaper` cron. Both ingestion ledgers got the same
treatment, which is what closed #132.

**The one thing to internalise before touching this area:** the heartbeat is not a refinement of the
reaper, it is its **precondition**. A dispatch run walks every active zone and is legitimately long,
so a reaper keyed on wall-clock age eventually frees a *live* run's zones and lets a second run write
the same day plans — strictly worse than the wedge it fixes. If you ever find yourself simplifying
`staleDispatchRunFilter` back to `startedAt`, that is the failure you are re-introducing, and
`leaves a slow-but-alive run alone` is the test that will tell you.

**Three rules any new writer in this area inherits:**

- **Never write a run row or claim row by primary key alone.** Both finalizes are `updateMany` keyed
  on `status = 'RUNNING'`. The per-zone one still names its PK; the status predicate is what makes it
  "still this run's row to close". Same rule as #265's `liveScheduleFilter()`, third area to need it.
- **Reap order is run-then-claims.** Dying mid-reap then leaves RUNNING claims under an ABORTED run,
  which the next pass finishes. The reverse leaves a RUNNING run holding nothing — reads as live,
  nothing ever corrects it.
- **`heartbeat_at` is nullable with no default on all three tables**, and every filter carries the
  `heartbeatAt: null → startedAt` fallback arm. A `DEFAULT now()` would re-date the pre-column rows
  and narrow the reaper to the empty set on exactly the stranded population it exists for. There is a
  test per filter that fails when the arm is removed.

## 2. #260 starts here, and its number is already pinned

`DEFAULT_DISPATCH_STALE_RUN_MIN = 10` and `DEFAULT_DISPATCH_RETRY_DEADLINE_MIN = 15` are **both**
already in `src/scheduling/dispatch-cron.ts`, stated together with the invariant that makes them
correct: **reap ≤ retry deadline**, or a crashed holder starves the cron's whole retry window. #260
should read its deadline from that constant rather than introducing a second one — the pairing is the
point, and #261's Risks section is where the requirement came from.

`readDispatchStaleRunMs()` / `staleDispatchRunFilter()` are next to them and are the shape to copy.

Two more things #260 will want:

- **The reap sweep deliberately does not dispatch.** It frees zones and stops. #260 owns retry, so if
  the retry lives anywhere it lives in the 05:00 run's own loop, not in `dispatchReaperTick`.
- **`reapStaleDispatchRuns` returns `{ runs, claims }`**, so a retry loop can tell "the holder was
  reaped, try again now" from "the holder is alive, keep waiting" without a second query.

## 3. Test-method traps this session paid for

**One signature change re-aimed three sibling tests.** The per-zone finalize went from
`dispatchRunZone.update` to `updateMany`, and **three** tests broke the old writer *by name*:
`dispatch-zone-claim-admission` (#259's wedge), `dispatch-in-flight-guard` (#213's wedge) and
`dispatch-run-containment` (#113's hand-built fake Prisma). Left alone, each would have passed forever
while proving nothing — the exact drift #259 recorded finding in #213's wedge, hit three more times.

**The non-obvious part:** the two wedges **cannot** simply break `updateMany`, because
`releaseStrandedClaims` — the release they exist to prove — now uses it too. Breaking it wholesale
makes the test pass for the wrong reason. They discriminate on the argument that separates the two
writers: **the finalize names a `zoneId`, the release does not.** Both were re-verified by deleting
the release and watching them go red. If you change a claim writer's signature, grep for the old
method name in `test/` before assuming the suite covers you.

**A hand-built fake Prisma is a third place to update.** `dispatch-run-containment.spec.ts` needed
`dispatchRun.findMany` and `.updateMany` added, and its call counts re-pointed. `dispatchRun.updateMany`
is **3** on a two-zone run — one beat per zone plus the finalize — which is worth knowing before you
read that as a bug.

**`scheduler-wiring.e2e-spec.ts` pins the exact cron-name set** and went 18 → 19. It is a decision
record, not an obstacle; update it in the same commit as any new `@Cron`.

**Sensitivity discipline held:** nine assertions here were green on arrival and every one had its
sensitivity proven by deliberate breakage with the red recorded — the table is in
`docs/progress/261-dispatch-run-heartbeat-reaper.md`.

## 4. Facts that will cost you time to rediscover

**New this session, all measured:**

- **The test DB gets its migrations from `test/global-setup.ts` (`prisma migrate deploy`)**, not from
  `run-tests.mjs` alone — so a bare `npx vitest run <file>` *does* apply pending migrations. You still
  need `npx prisma generate` by hand after a schema edit.
- **`ALTER TYPE … ADD VALUE` is fine inside Prisma's migration transaction on PG16** as long as the
  new value is not *used* in the same migration. `ABORTED` is added and not used; don't add a data
  backfill onto that migration.
- **`snapshot_runs` and `master_sync_runs` each permit exactly one RUNNING row** (their in-flight
  partial uniques). A test that wants two live ingestion runs must stage one per table — this cost a
  red on a test whose *code* was correct.
- **`npx tsc -p tsconfig.test.json --noEmit` is still dirty at HEAD, and worse than the predecessor
  recorded**: ~32 files, not one. They are another session's uncommitted work. Ours are clean; the
  three that remain in files we touched are pre-existing and named in the progress report. **Filter to
  your own hunks; a clean run is not achievable.**
- **`makeWorker` in `snapshot-worker.e2e-spec.ts` was typed `InMemorySourceReader`** while the worker
  takes a `SourceReader`; three tests in that file were already violating it. Widened.
- **The large-heredoc parse failure fired again** (`docs/progress/261-*.md`). Write the file with the
  Write tool; the predecessor's note is correct and worth obeying the first time.
- **A trailing `echo "exit=$?"` still reports the echo, not the suite** — the predecessor's trap #2.
  Redirect the suite to a log and read `$?` off the `node scripts/run-tests.mjs` line itself.

**Measured clean, 2026-08-23:** 402 files / 1994 tests passed / 5 skipped / **0 failed**, four chunks
each exit 0 (two #184 crashes, both auto-retried and recovered). Admin 104 files / 544 passed — its
single reported "error" is the **pre-existing** `TicketDetailDrawer.tsx:440` fault, not ours.

**Still true from the predecessors** (not repeated): `INSERT … ON CONFLICT DO NOTHING` is the
admission idiom · a no-target `DO NOTHING` catches both uniques · claims are taken in ascending zone
id · `dispatch_run_zones.status` has no DEFAULT deliberately · `holdersFor` vs `claimantsOf` answer
different questions · `meta.target` does not exist under this driver adapter · a P2002 aborts its
transaction · `OVERRIDDEN` is a LIVE schedule status · a `beforeAll` that throws reports as *skipped
tests + a failed file* · a python patch script whose `write` is the last statement saves nothing when
an assert fails — **keep that shape** · no prettier, no backend eslint · `fileParallelism: false`.

## 5. Open operator decisions carried forward (none block #260/#262)

Unchanged, all four still open:

1. **#178's backfill is built and NOT executed.** Its population is exactly #243's C1+C3 (measured
   3,310 / 4,402; the issue's "351" is stale). #243 remains **HITL-gated and unexecuted**; running
   #178's `--apply` first would consume those rows under a different reason and destroy #243's
   `DEV_CLEANUP` rollback handle. Re-measure at execution time.
2. **#272 Q1** — Device Detail panel: retired, or a deep-link shortcut? Due before **#277**.
3. **#272 Q3** — does the ZM get Distribute, or only OH + CSM? Due before **#276**.
4. **#258's rulings are still not recorded in `CONTEXT.md`** — open since #258, now carried by five
   handoffs. A small docs task nobody has picked up, not a blocked one.

**Ruled previously, do not reopen:** clear the #275 chain in order · the approved design's `PASSED` on
an over-capacity candidate is overridden by Q2 and #274's AC-2 · tier crossing is measured against the
best still-**passing** tier · `TIER_NOT_REACHED` is not a verdict on the candidates read · "refuse an
override outright on a terminal schedule" is **#271's** question.

## 6. Follow-ups still worth filing if you touch the area

Carried, still unactioned:

- **`GET /schedules/candidates` fans out one `orderedCandidatesForPlant` call per plant** — bounded by
  what a human drafts, but **#276's Distribute may ask for many more at once and should measure before
  assuming it scales.**
- **The intra-day manual-assign path has no admin client at all.** **#277** owns the modal.
- **The runs-list row has no zone outcome.** A ZM whose zone was contended sees `zones: 0` and all-zero
  totals — correct but silent about *why*. Still a one-field addition whenever somebody is in
  `listRuns`. #261 did not take it: its UI surface was the run *status*.

New, from this session:

- **`ABORTED` has no operator-facing explanation beyond the badge.** The run detail says ABORTED and
  the zone card says `ERROR — ABANDONED …`, which is honest but assumes the reader knows what reaped
  it. A one-line "reaped at HH:MM after N minutes without a heartbeat" on the run detail would close
  that, and the data is already on the row (`heartbeat_at`, `finished_at`).

## 7. Suggested skills

- **`/tdd`** — mandatory. The seam-agreement step is what put the ordered run-then-claims write and
  the `{ runs, claims }` return shape into the design rather than into a later correction.
- **`/code-review`** — one pass over `git diff dc7ea79..HEAD` before starting #260.
- **`/diagnose`** — only if a chunked run fails *and* re-running that chunk alone reproduces it.

**Reading order for a fresh session** (per `CLAUDE.md`): `CLAUDE.md` → `docs/SYSTEM-STATE-2026-07.md`
(§3f now carries the reaper; the ingestion ledger section carries the heartbeat) →
`.scratch/fsm-platform-v1/INDEX.md` (§§ P8, P9 + the last three session-log rows) → the issue being
worked → then this file.
