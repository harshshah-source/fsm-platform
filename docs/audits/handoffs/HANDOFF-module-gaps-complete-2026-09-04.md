# HANDOFF — module-gaps backlog, COMPLETE — 2026-09-04

**CLOSED. This file is audit trail, not a brief — do not execute it.** It was written mid-round when
a rate limit killed four agents at once; all four were resumed from their own transcripts and
finished. **All 31 slices (#336–#366) are built and committed.** Final gate: backend 468 files /
2802 tests, 2792 passed, 5 skipped, zero failures; admin 136 files / 1050 tests, 1049 passed (the one
failure a latent race in a file no slice touched, since hardened).

Current state is `docs/SYSTEM-STATE-2026-07.md` and `.scratch/fsm-platform-v1/INDEX.md` §P12 —
**read those, not this.** Five follow-ups are filed and open: **#367** (mobile poll contract),
**#370** (the ninth PRD notification event), **#371** (mobile pickup stop), **#372** (SE productivity
onto the cube), plus the `REVOKED` enum member #363 derived rather than added.

The rest of this file is preserved as written, including its inventory of what was
uncommitted at the time — none of which is uncommitted any more.

Status: closed
Branch: `feat/autoplant-integration`
Last commit: `38f7ad8` (docs(index): Round 3 and 4 P12 rows, the two design records, and the session log)

## Read this first

**Four slices are half-built and UNCOMMITTED in the working tree.** They were not abandoned and
they are not broken — all four agents were killed mid-flight by the same account-level rate limit
(`resets 1:30am Asia/Kolkata`, 2026-09-04). One of them (#361) had already survived an unrelated
`ECONNRESET` and been resumed once.

**Nothing has been reverted. Do not clean the tree.** The first thing to do is
`git status --porcelain` and compare it against the inventory below — I could not run git myself
when writing this (the Bash safety classifier was down at the same time), so **the #365 file list
below is inferred from its last reported action, not verified.**

## Where the backlog stands

**27 of 31 P12 slices are DONE and committed.** The remaining four are the ones in the tree:
**#351, #361, #365, #366**. There is nothing after them — these four close the backlog.

Committed today (Round 3 and 4): #349 `42e556a` · #357 `d165d55` · #363 `79072b0` (+ `12175f8`) ·
#364 `1d70753` · #337 · #358 · designs `#368`/`#369` · bookkeeping `38f7ad8`.
**INDEX P12 rows and the session log are already written for everything committed** — you only owe
bookkeeping for these last four.

## The four partial slices

Each was given a full brief; the briefs are reconstructable from
`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4 plus the issue file. What follows is what each had
actually done when it died, and the last thing it said it was about to do.

### #351 — dashboard fidelity (furthest along)
Last action: *"Now the API type and `useAssignDraft` preset."*
In the tree: `apps/admin/src/api/dashboard.ts`, `pages/assign/useAssignDraft.ts`,
`pages/dashboard/{CentralDashboard,EscalationQueueList,OpsHeadDashboard,WarehouseDashboard,ZmDashboard,ZoneOverviewTable}.tsx`,
`apps/backend/src/dashboard/dashboard.service.ts`,
`apps/backend/test/{dashboard-critical-queue,dashboard-operating-mode,dashboard-zone-overview}.e2e-spec.ts`;
**new** `apps/admin/src/components/dashboard/SnapshotHealthBadge.tsx`,
`apps/admin/test/dashboard-fidelity.test.tsx`.
Remaining: finish the `api/dashboard.ts` type + the `/assign?filter=critical-plus` preset, mount
`ZoneOperatingModeCard`/`Table` if not yet mounted, remove the dead `suggestedSes`, run the specs.

### #366 — warehouse pickup stop (nearly done)
Last action: *"Now typecheck backend and admin, and run the admin test."*
In the tree: `packages/shared/src/index.ts`, `apps/backend/test/day-plan-query.e2e-spec.ts`;
**new** `apps/admin/test/schedule-pickup-stop.test.tsx`.
**Check whether it got as far as `schema.prisma` + a migration** — it owned the schema this round.
If a migration exists, `npx prisma generate` may still be owed. Remaining: typecheck, admin test,
and `packages/shared` needs `npm run build` (its `dist/` is gitignored).

### #361 — notification producers (least far)
Last action: *"Now the departure auto-close notice to the ZM."*
In the tree: **new** `apps/backend/src/notifications/prd-event-notice.ts` (121 lines — the shared
`PRD_NOTICE_TYPES` vocabulary). **It was cut off mid-write once already; re-read it before trusting
it.** Remaining: nearly all the producers.

### #365 — SE productivity report (file list UNVERIFIED)
Last action: *"Now the controller route."* — so it had likely done the F7 split in
`fleet-uptime-aggregation.service.ts` and a `reports.service.ts` method. **Verify with git.**

## How to finish

**Do not relaunch four agents at once into a fresh rate-limit budget.** Either finish them yourself
one at a time, or relaunch at most two. `.scratch/PARALLEL-BRIEF.md` is current for this round (it
names #351/#358/#361/#365/#366 as in flight — #358 has since landed).

Order that respects the one real constraint: **#366 owns `apps/backend/prisma/schema.prisma`** and
no one else may touch it or run `prisma generate`. The other three are mutually disjoint and
disjoint from #366.

Then: full backend suite alone through the lock, then admin, then the four P12 rows + a session-log
line + the SYSTEM-STATE update for a **completed backlog**, then retire this file.

## Standing instructions from the user (still in force)

- **"Implement rest of remaining issues of scope-gap in proper sequence"** — the instruction that
  started this round. It is not finished until #351, #361, #365, #366 are in.
- *"Do NOT parallelize blindly by wave number. Use BOTH the explicit dependency graph and actual
  file ownership/overlap"*; *"uncertain ownership → treat as conflicting and serialize"*;
  **"The objective is maximum safe parallelism, not maximum simultaneous agents."**
- On a migration: **hand-write it and rely on the suite**, flagging that the drift gate was not run.
  Never regenerate `prisma/drift-baseline.txt`.
- Commits are **per slice, explicit paths only**. Agents run no state-mutating git; the orchestrator
  commits after reading each diff for a second author's hunks.
- AFK policy: stop only for architecture / business-rule conflict / backlog-ownership /
  external-access / security.

## The two design decisions taken today (already committed — do not re-ask)

- **#368** — SE productivity is a **filterable roster table**; rates suppressed below a small-sample
  threshold; diagnostic surface, never a league table. Design:
  `docs/ui/desktop/approved-designs/se-productivity-report.html`. It also makes audit finding **F7**
  structural: Repair and Departure are separate columns, because `se_repaired_closures`
  mis-attributes departure closures and #365 must split it **before** the page exists.
- **#369** — the warehouse pickup is **a stop row of its own kind at sequence 0**, naming the parts;
  `kind: 'PLANT' | 'WAREHOUSE_PICKUP'` as a discriminated union, not a boolean. Design:
  `docs/ui/desktop/approved-designs/warehouse-pickup-stop.html`. Mobile rendering is out of scope.

## Things learned today that outlive this round

- **`dispatch-crashed-zone-recovery` is NOT flaky** — it failed after 18:00 IST because three call
  sites did not pin the recovery cutoff their ten siblings pin. Fixed in `test/setup-env.ts`
  (`735a0b6`). If it fails now, it is real. `global-guard-validation` (#184) is still genuinely flaky.
- **A tinypool `Worker exited unexpectedly` orphans one file's results** without failing anything —
  the counts will not add up. Re-run the orphan alone before hunting a phantom failure.
- **A follow-up issue covers work not yet done, never a regression already shipped.** #357 made a
  reason mandatory and would have broken a live admin button; that was fixed inside #357's own
  commit rather than deferred to #358.
- **The harness kills a backgrounded Bash command at ~10 minutes.** Run the full suite detached via
  `Start-Process` (PowerShell) writing to a log, then poll the log — see
  `.scratch/round3-verify.log` for the pattern.
- Round 2's regression class: a test fixture returning a bare array where a **paged** envelope is
  now returned renders `undefined.map` and takes the whole admin page down.

## Open for the operator (not blocking)

- **INV-G2** (#353 built the assumed default: a recovery receipt writes a transaction row and moves
  no stock; reversal is one function).
- **#367** — the mobile Tickets screen still does not consume #360's poll contract.
- **#337 needs FCM credentials** to deliver for real; the seam is built and tested, default binding
  is `logging`.
- **The dev database has never been seeded** — `SEED_DEV_WALK_FIXTURES=true npm run seed:dev-fixtures`
  is an operator action.
