# Handoff — **the #275 chain is CLEARED**: #261, #260 and #262 all landed (session of 2026-08-23)

**Repo:** `C:\fsm-platform-backup` · branch `feat/autoplant-integration` · **nothing pushed**
(35 ahead of `origin`). **Nothing is in flight. No uncommitted work of ours.** `git status` remains
~99 files, every one of them another session's (#239 acting-zone + #236 commissioning + admin chart
work) — **do not commit them.** `docs/SYSTEM-STATE-2026-07.md` is among them and carries **84 lines of
somebody else's uncommitted edits** alongside ours; all three of this session's docs commits staged
only our own hunks. Do the same.

> Placed in `docs/audits/` per the operator's standing request. Its three predecessors from this
> session are in `docs/archive/` with ARCHIVED banners. **Apply the same when this one is spent.**
>
> **Companion:** `handoff-2026-08-23-session-notes.md` beside this file carries the operational half —
> the state of the working tree (99 files that are NOT ours, and the partial-staging recipe for
> `SYSTEM-STATE`), how to run the suite here, and suggested skills. Archive the pair together.

---

## 0. Where the track stands

- **P8: 9 of its 16 rows are implementation-DONE** — `#259`, `#261`, `#260`, `#262`, `#265`, `#177`,
  `#266`, `#178`, `#269`. Row 1 (**`#258`**) is the decision record: delivered, with one docs task
  still outstanding (record its rulings in `CONTEXT.md`). **Six implementation issues remain:**
  `#264` · `#263` · `#268` · `#267` · `#270` · `#271`. (`#252` and `#132` were absorbed into `#259`
  and `#261` respectively — they are not P8 rows and must not be counted toward this tally, which is
  the arithmetic error the first version of this handoff made.)
- **P9: 3 of 6** — `#272`, `#273`, `#274`. **`#275` is UNBLOCKED.**

**The operator's ruling was to clear the #275 chain in order — #265 → #259 → #261 → #260 → #262 —
rather than build #275 against a provisional transaction shape. That chain is now complete.** The
transaction shape #275 was waiting for is settled and documented; #275 is the natural next item unless
the operator wants P8 finished first.

**Commits this session:** `cf6f9de` `5a044ee` `b115bfd` (#261 + #132) · `cf5c799` `460d2f8` (#260) ·
`f4684b9` + docs (#262). Reports: `docs/progress/{261,260,262}-*.md`. Do not re-derive them.

## 0b. What remains of the scheduler engine, and what is actually blocked

**Nothing in P8 is blocked any more.** That is the substantive result of these three days, and it is
not visible from the issue files themselves — each still carries a `Dependencies / Blocked by` line
written when the chain existed.

| Issue | Scope | Was blocked by | Now | Size |
|---|---|---|---|---|
| **#271** | SLA fold+resume at submission, terminal at verification | — (never blocked) | ready | M |
| **#263** | DB cron tick claims — duplicate-instance safety | — (never blocked) | ready | S |
| **#270** | Tri-state filter honesty (`NOT_ENFORCED`) + eligibility-proxy doc | — (never blocked) | ready | S/M |
| **#264** | Durable notification outbox (executes #189) | #262 | **cleared** | M |
| **#267** | Admin SE home/base + route-chain distance | #266 | **cleared** | M |
| **#268** | CRITICAL direct assignment + Q-B escalation | #266, #265 | **cleared** | L |

Plus the docs tail on **#258** (record its rulings in `CONTEXT.md`) — small, unowned, carried by seven
handoffs.

**The concurrency and correctness substrate is finished.** Admission, reaping, patience, per-SE
transactions and race hygiene were the interlocking part, and the part where being wrong is invisible
until production. What is left is largely independent feature work over a settled foundation: one L,
three M, two S/M.

**Two connections worth knowing before planning:**

- **#267 is not merely a feature — it is what makes scoring discriminate.** #266 recorded its own
  **AC-2 as UNBUILDABLE**: every candidate for a ticket shares one `baseScore`, so no weight can
  reorder them until distance exists. #267 is the missing input, and #266's AC-2 should be revisited
  when it lands.
- **#264 builds durability, not delivery.** Its channels (FCM/APNs/WhatsApp) are still
  external-blocked, so it is the outbox and the re-drain sweep over the per-SE buffer #262 left in
  memory — the seam stays a seam.

**Suggested order if nobody rules otherwise: `#263` then `#271`.** #263 is small and closes a live
production-safety gap — a second sweeps-enabled instance currently double-runs every cron — and it sat
behind a queue it never actually depended on. #271 is the largest remaining piece of *correctness*
(SLA boundaries) as opposed to new surface. #268 is the last piece of scheduler *behaviour* and the
only L; it is worth having #267 in first so its scoring is not still degenerate.

## 1. The dispatch path, as it now stands

Five issues have rebuilt this path in four days. The whole shape, because no single issue's doc has it:

```
runForActiveZones(now, opts)
  ├─ reapStaleDispatchRuns(now)                     #261  free zones whose holder died
  ├─ admit(...) ─CONFLICT─► [#260 patience: sleep → reap → re-admit] ──► 409, ZERO rows
  │                                                 #259  a run that never happened leaves no history
  └─ execute(...)
       ├─ processZone(z) per admitted zone          #260  extracted; beat after each (#261)
       │    └─ dispatchForZone(z)                   #262  ONE TRANSACTION PER SE
       │         └─ per SE: lock_timeout → advisory lock → FOR UPDATE SKIP LOCKED
       │                    → guard → schedule/batches/tickets → consume → commit
       ├─ waitOutContention(...)                    #260  promote CONTENDED rows in place
       └─ conditional finalize (updateMany RUNNING)  #261  a reaped run stays reaped
     finally: releaseStrandedClaims(runId)          #259  a run that unwinds frees its zones
```

**Five rules any new writer here inherits.** None are stylistic:

1. **Never write a run row or a claim row by primary key alone.** Every writer carries
   `status = 'RUNNING'` (or `'CONTENDED'` for #260's promotion). A PK write silently resurrects a state
   somebody else closed — #265's rule, now enforced in five places.
2. **Claims are taken in ascending zone id**, so concurrent admissions cannot deadlock.
3. **Keep beating.** Any new long phase must touch `heartbeat_at`, or a run reaps itself. #260's
   patience loop beats while it waits, for exactly this reason.
4. **`FOR UPDATE OF r` — never a bare `FOR UPDATE`** in the per-SE claim. Locking the joined ticket and
   plant rows would block unrelated writers for the length of the SE's transaction.
5. **Do not sweep recommendations zone-wide.** With SKIP LOCKED, a row you cannot see is a row somebody
   else has locked. #262's cleanup is scoped to the SEs that *failed* for this reason.

## 2. What #275 (and #264) will find

- **The transaction shape is settled**: one transaction per SE, bounded by `daily_capacity`, with
  `transactionOptions` stated in `src/prisma/transaction-options.ts` (maxWait 5 s, timeout 15 s).
  #275 was blocked on exactly this and no longer is.
- **#264 depends on #262's per-SE buffering, which exists but is still in-memory.** Notification intents
  are collected per SE and fired after every transaction settles. #264 owns making that durable.
- **`processZone(zoneId, ctx, summary, totals)` is the seam.** #260 extracted it when the zone loop
  gained a second caller. A change to what happens *inside* a zone should not need to touch `execute`.
  If you add a counter, add it to `RunTotals` — the invariant "run totals equal the sum of the zone
  cards" holds only because one function folds a zone in.
- **`dispatch_run_zones` now has four statuses, a promotion path and two failure fields.** A zone can go
  `CONTENDED → RUNNING → DONE` inside one run (#260). `error` is the whole-zone field; `se_skips` is
  per-SE. Any new read that assumes CONTENDED is terminal is wrong.
- **#124's effective snapshot still has no home.** INDEX listed it as riding with #262; it did not, and
  #262 did not take it. It needs an owner.

## 3. Test-method traps these three issues paid for

**A behaviour change re-aims sibling tests, and a timeout is one of the symptoms.** Five tests across
the three issues broke by naming an old writer or an old contract: #259's wedge, #213's wedge, #113's
fake Prisma (all from `update` → `updateMany`), #213's "the tick skips" (from the cron becoming
patient — it began *timing out*, not failing cleanly), and #113's scheduler config pins. **A timeout in
an unrelated-looking spec after a behaviour change is a re-aim, not a flake.**

**When an old test's premise goes obsolete, decide which contract it pins.** #213's tick test pins the
*guard*, not the *patience*, so it now runs with `deadlineMs: 0` and asserts exactly what it always did.
Weakening it instead would have lost the guard.

**A Prisma delegate patch is visible OUTSIDE a transaction and not inside one.** Measured directly this
session. That is why the #259/#213 wedges could patch `dispatchRunZone.update`, and why a per-SE fault
cannot be injected that way. Stage in-transaction contention with real locks instead — a second
connection holding rows (`FOR UPDATE`) or the zone advisory lock.

**A natural per-SE P2002 is unreachable by construction, and that is the design working.** After #127's
APPEND and #262's per-SE guard re-read, producing one needs a genuinely concurrent external writer. Do
not spend an afternoon trying to stage one; prove the label mapping at its own seam.

**`@Optional()` on a new constructor parameter is load-bearing.** Without it Nest treats it as an
injection token and fails to resolve `SchedulingModule` at boot — **36 failed files in one chunk from
one missing decorator.** The DI-wiring spec is what caught it.

**`test/setup-env.ts` is an allowlist; a new env prefix must be added.** #261 shipped
`DISPATCH_STALE_RUN_MIN` without doing so and #260 caught it. `DISPATCH_` is in now.

**Do an enabling refactor as its own green step.** #260's `processZone` extraction landed and was
verified behaviour-preserving on 34 tests before a line of the feature was written, which is what made
the following RED unambiguous.

## 4. Facts that will cost you time to rediscover

- **The test DB's migrations come from `test/global-setup.ts` (`prisma migrate deploy`)**, so a bare
  `npx vitest run <file>` applies them. `npx prisma generate` is still manual after a schema edit.
- **`ALTER TYPE … ADD VALUE` is fine inside Prisma's migration transaction on PG16** if the new value
  is not *used* in the same migration.
- **A P2002 from a single statement is safe to catch.** #265's "a P2002 aborts its transaction" applies
  to interactive `$transaction` callbacks; #260's promotion and #262's claim rely on the distinction.
- **`pg_sleep` returns `void`, which Prisma's raw deserializer cannot map** — cast it (`::text`).
- **`snapshot_runs` and `master_sync_runs` each permit exactly one RUNNING row.**
- **There are only ~5–6 active zones in the test DB**, so an unscoped `runForActiveZones` in a spec is
  cheap — but it claims *every* one, so clean up **by run id**, not by your own zone.
- **`npx tsc -p tsconfig.test.json --noEmit` is dirty at HEAD (~32 files)** — another session's work.
  Ours are clean. Filter to your own hunks; a clean run is not achievable.
- **Large heredocs still fail to parse in the Bash tool.** Use the Write tool. Fired again on all three
  progress reports.
- **A trailing `echo "exit=$?"` reports the echo, not the suite.** Redirect to a log; read the exit code
  off the `node scripts/run-tests.mjs` line.

**Measured clean, 2026-08-23 (after #262):** **406 files / 2015 passed / 5 skipped / 0 failed**, four
chunks each exit 0. Admin **105 files / 545 passed** — its single reported "error" is the pre-existing
`TicketDetailDrawer.tsx:440` fault.

## 5. Open operator decisions carried forward (none block #275 / #264)

1. **#178's backfill is built and NOT executed.** Its population is exactly #243's C1+C3 (measured
   3,310 / 4,402; the issue's "351" is stale). #243 remains **HITL-gated and unexecuted**; running
   #178's `--apply` first would consume those rows under a different reason and destroy #243's
   `DEV_CLEANUP` rollback handle. Re-measure at execution time.
2. **#272 Q1** — Device Detail panel: retired, or a deep-link shortcut? Due before **#277**.
3. **#272 Q3** — does the ZM get Distribute, or only OH + CSM? Due before **#276**.
4. **#258's rulings are still not recorded in `CONTEXT.md`** — open since #258, now carried by seven
   handoffs. A small docs task nobody has picked up, not a blocked one.

**New, and worth a decision before #264:** **#262 corrected item 6 of its own issue.** Closure and
bulk-unassign now *respect* the #259 zone claim rather than *acquiring* it, because a claim is a
`dispatch_run_zones` row and cannot exist without a `dispatch_runs` parent. If the operator wants a
first-class "who owns this zone" concept that non-run holders can take, that is a **new issue** and an
architecture decision — the current shape closes the window #262 opened without inventing one.

**Ruled previously, do not reopen:** the approved design's `PASSED` on an over-capacity candidate is
overridden by Q2 and #274's AC-2 · tier crossing is measured against the best still-**passing** tier ·
`TIER_NOT_REACHED` is not a verdict on the candidates read · "refuse an override outright on a terminal
schedule" is **#271's** question.

## 6. Follow-ups still worth filing

Carried:

- **`GET /schedules/candidates` fans out one `orderedCandidatesForPlant` call per plant** — **#276's
  Distribute may ask for many more at once and should measure before assuming it scales.**
- **The intra-day manual-assign path has no admin client at all** — **#277** owns the modal.
- **The runs-list row has no zone outcome.** #260 made a CONTENDED row *more* meaningful (it now means
  the run waited its full deadline and still lost) and still invisible on the list.
- **`ABORTED` has no operator-facing explanation beyond the badge.** "Reaped at HH:MM after N minutes
  without a heartbeat" would close it; the data is on the row.
- **Nothing records how long a patient run waited** (#260). Derivable from the promoted claim's
  re-stamped `started_at`, no migration needed — worth it if anyone wants to tune the 15-minute
  deadline against reality.

New, from #262:

- **`se_skips` is written and rendered but never aggregated.** There is no "engineers not dispatched
  today" figure anywhere, so a systematic per-SE failure across many zones is only visible by opening
  each zone card. A run-level count would be a small addition to `listRuns`.
- **#124's effective snapshot has lost its owner** — see §2.

## 7. Suggested skills

- **`/tdd`** — mandatory. It earned its keep three times this session: the seam step forced #261's
  ordered run-then-claims write, disproved #260's single-site patience design at the first RED, and
  made #262's 15 s → 360 ms result a measurement rather than a claim.
- **`/code-review`** — one pass over `git diff dc7ea79..HEAD` before starting #275. That range is now
  **eight commits across three issues** and is the largest change to the dispatch path since #213.
- **`/diagnose`** — only if a chunked run fails *and* re-running that chunk alone reproduces it.

**Reading order for a fresh session** (per `CLAUDE.md`): `CLAUDE.md` → `docs/SYSTEM-STATE-2026-07.md`
(§3f now carries the claim, the reaper, the patience and the per-SE write unit) →
`.scratch/fsm-platform-v1/INDEX.md` (§§ P8, P9 + the last five session-log rows) → the issue being
worked → then this file.
