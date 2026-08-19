> **ARCHIVED 2026-08-19** — consumed. #251 committed `92dc7a5`; #245 built and committed `fc0b142`.
> Historical only: nothing here is current. Live state is `.scratch/fsm-platform-v1/INDEX.md`.

# Handoff — Scheduler block: #240/#241/#250 landed, #251 built-but-uncommitted, #245 is next

**Written 2026-08-19.** For the session that continues implementing the scheduler/assignment block.
Implementation approval was given this session and is **still in force** — do not re-ask for it. The
one exception is #243, which keeps its own separate execution gate (see "Do not do" below).

---

## Read these first (do not re-derive)

Mandatory order per `CLAUDE.md`: `CLAUDE.md` → `docs/SYSTEM-STATE-2026-07.md` →
`.scratch/fsm-platform-v1/INDEX.md` → the issue file being worked.

The block's own context is already written down — reference it, don't rebuild it:

- `.scratch/fsm-platform-v1/INDEX.md` — the **"Scheduler-decisions block"** table (items 60–71) plus
  the 2026-08-19 session-log rows for #240/#241 and #250. Those rows carry the full findings.
- `docs/audits/scheduler-slice-plan-2026-08-19.md` — architecture fit, dependency graph, risks.
- `docs/audits/four-decisions-final-analysis-2026-08-18.md` — the deep verification.
- `docs/progress/240-*.md`, `241-*.md`, `250-*.md` — per-slice completion records (frozen once written).
- `docs/archive/handoff-scheduler-implementation-2026-08-19.md` — the **previous** handoff, consumed
  and archived. Historical only.
- The issue files `.scratch/fsm-platform-v1/issues/240-*.md` … `251-*.md` are **the spec**.

---

## State of the tree

Branch `feat/autoplant-integration`. Four commits landed this session:

| Commit | Slice |
|---|---|
| `eb80645` | #240 — IST day boundary (closure cron timezone, `plannerForDate`, `assignTicket`) |
| `ada87b8` | #241 — `removal_reason` + 7 writer stamps + backfill + indexes |
| `e7a4205` | docs — the block's paper trail; previous handoff archived |
| `639aa72` | #250 — recommender dry-run seam + `targetDate` + `previewActiveZones` + future-date guard |

**#241's migration is applied to the dev DB** (`fsm` @ `localhost:5433`): 7,891 removed rows
backfilled (6,799 `HUMAN_REMOVED`, 1,092 `AUTO_RECOVERY`), 0 orphans. Verified with `EXPLAIN` that
the per-ticket history read is now an index scan.

### #251 is complete but NOT committed — finish this first

All code is written, all targeted tests green, both apps typecheck, `vite build` clean, **full admin
suite 99 files / 500 tests green**. What remains is the **full backend suite**, which was still
running when this handoff was written.

New files (untracked):
- `apps/backend/src/scheduling/preview-token.ts`, `scheduler-preview.service.ts`
- `apps/backend/test/preview-token.spec.ts`, `scheduler-preview.e2e-spec.ts`,
  `scheduler-preview-wiring.e2e-spec.ts`
- `apps/admin/src/api/schedulerPreview.ts`, `apps/admin/src/pages/schedules/SchedulerPreviewPage.tsx`
- `apps/admin/test/scheduler-preview-page.test.tsx`
- `docs/progress/251-admin-scheduler-preview.md`

Modified (only these lines are #251's — see "Do not sweep" below):
- `apps/backend/src/recommender/recommender.service.ts` — `ZoneProjection` gains `mode`,
  `recommended`, `unassignable`, `withheldBelowThreshold`, `unassignableReasons`
- `apps/backend/src/scheduling/bulk-unassign.service.ts` — consumes the shared token module
- `apps/backend/src/scheduling/schedules.controller.ts` — 3 endpoints
- `apps/backend/src/scheduling/scheduling.module.ts` — provider **and export**
- `apps/backend/test/schedules-route-conflicts.e2e-spec.ts` — provider stub added to its hand-rolled module
- `apps/admin/src/AppRoutes.tsx`, `apps/admin/src/components/shell/nav.ts`
- `.scratch/fsm-platform-v1/INDEX.md`, `.scratch/.../issues/251-*.md`

**To finish #251:** confirm the backend suite is green (only the 2 known pre-existing
`voucher-controller.e2e-spec.ts` failures — see below), commit, then append the INDEX session-log row
with the hash. The `docs/progress/251-*.md` record is already written and describes everything.

---

## The mistake this session made — do not repeat it

I added `SchedulerPreviewService` to `SchedulingModule`'s **providers** but not its **exports**.
`SchedulesController` is registered in `AppModule`, so it resolved when `SchedulingModule` was booted
alone and failed the instant the real app was assembled: **122 spec files died at boot**, each
reporting `Cannot read properties of undefined (reading 'close')` from its own `afterAll` — three
hops from the cause, with nothing naming the missing export.

Every targeted test I ran passed, because the ones that passed were structurally incapable of
catching it: `scheduler-preview.e2e` constructs the service by hand, `schedules-route-conflicts.e2e`
stubs it, `schedule-closure-wiring.e2e` boots only `SchedulingModule`.

Fixed, and pinned by `test/scheduler-preview-wiring.e2e-spec.ts` (boots the real `AppModule`;
verified red when the export is removed).

**Rule for the next session: after any module-wiring change, boot the real `AppModule` before
declaring anything done.** `test/acting-context.e2e-spec.ts` is the cheapest smoke test for this.

---

## Next work, in order

### #245 — VU approval lifecycle (START HERE; `Blocked by: Nothing`)

`.scratch/fsm-platform-v1/issues/245-vehicle-unavailability-approval-lifecycle.md`. Backend +
migration + Admin. The two authority gate answers are **recorded in the issue and must not be
re-litigated**: Q1(a) the SE's proposed date takes effect immediately as a provisional deferral;
Q2(a) the latest valid in-scope managerial action supersedes regardless of role.

**Reference-image finding (the issue's Reference section is wrong).** It says the page was "built
without a v2-reference image". **`docs/ui/desktop/v2-reference/11-vehicle-unavailability.png`
exists and is directly authoritative.** Read it before building. What it dictates:

- KPI strip: Open Reports ("awaiting window confirmation") · SLA Paused · Vehicle On-Trip · Resumed
- Search box + a `STATUS` filter dropdown + an "N / N results" counter
- Columns: `REPORT / TICKET` · `VEHICLE / PLANT` · `REASON` · `FILED BY` · `EXPECTED BACK` ·
  `PRIMARY SLA` · `STATUS`, with two-line cells (e.g. `VUR-10393` over `TKT-TS-10393`)
- **The reference already shows a `CONFIRMED` status** alongside `OPEN` and `RESUMED`. So #245's
  approve/override decision state belongs in the existing Status column, and proposed-vs-authoritative
  dates belong as a two-line cell in the existing "Expected Back" column — **extend the reference, do
  not add columns to it.**

One useful fact already established: `vehicle_unavailability_reports` today has `status` (`OPEN` |
`RESOLVED`) and `expectedFrom`, and #251's `SchedulerPreviewService.placeHold` already reads an OPEN
report to refuse overwriting a return date. #245 adds `SUPERSEDED`, `proposed_from`, and the decision
columns.

### Then, in dependency order

- **#246** (return-date deferral wiring) — blocked by #241 ✅ and #245.
- **#247 / #248 / #249** — parallel after #246.
- **#242** (recycling) — prerequisites #240 ✅ and #241 ✅ are done, but its **enablement is gated on
  #243 being executed**.
- **#244** (Special ticket) — blocked by #241 ✅ and #242.

---

## Do not do

- **Do not execute #243.** It is `Type: HITL` — a data operation on ~9,086 dev-DB rows (C1 3,310 ·
  C2 4,684 · C3 1,092) requiring its own explicit execution approval **and re-measured counts** at
  execution time. The general "keep going" approvals in this session do **not** cover it. It now has
  the `DEV_CLEANUP` marker it depends on (from #241).
- **Do not sweep pre-existing uncommitted files into commits.** The tree carries a lot of unrelated
  in-flight work that predates this effort: admin chart redesign, `#238`, the acting-zone work
  (`apps/backend/src/common/manager-scope.ts`, `current-scope.decorator.ts`,
  `apps/admin/test/acting-zone-scope.test.tsx`), `apps/backend/scripts/run-tests.mjs`,
  `vitest.config.ts`, `main.ts`, several controllers, `docs/kpi-definitions.md`, `pnpm-*`. Commit
  per-slice and only what the slice touched. Two files needed hunk-level splitting this session
  (`override.service.ts` across #240/#241, `SYSTEM-STATE-2026-07.md`) — the `git add -p`-style
  approach works: write a reduced version, `git add` it, restore the full version, commit.
- **Do not import `apps/backend/src/common/manager-scope.ts`.** It is untracked pre-existing work.
  #251 deliberately used the committed pattern `{ role: user.role, zoneId: user.zone_id }` instead,
  which every other service in `schedules.controller.ts` uses. Consequence, recorded in
  `docs/progress/251-*.md`: acting-as-zone is not honoured on the preview surface.
- **Do not edit `src/` while a full backend suite is running.** Vitest transforms on demand, so
  mid-run edits contaminate the result. This happened once this session and the run had to be killed.
  New files are safe; edits to existing files are not.

---

## Environment / test notes

- Dev Postgres `localhost:5433`, db `fsm`; credentials in `apps/backend/.env` (not repeated here).
  `psql` is not on PATH — use `"C:\Program Files\PostgreSQL\16\bin\psql"`.
- Test DB is `fsm_test`; `test/global-setup.ts` migrates it automatically. Runner is **vitest**, not
  jest, despite `.e2e-spec.ts` naming. Full suite: `node scripts/run-tests.mjs` from `apps/backend`
  (~15–25 min, `fileParallelism: false`).
- **Known pre-existing failures: 2, both in `test/voucher-controller.e2e-spec.ts`.** Proven unrelated
  by stashing every change from this session and re-running — fails identically, and differently
  again in isolation (fixture-state dependent, the #156 class). Do not attribute them to new work,
  and do not "fix" them as part of a scheduler slice.
- `scripts/run-tests.mjs` retries files a Windows worker crash drops (#184) and prints
  `recovered — all N files accounted for`. A run without that line and without `SUITE INCOMPLETE` is
  clean.
- Admin: `npx vitest run` in `apps/admin` (~99 files / 500 tests), plus `npx vite build`.

---

## Working conventions that mattered

- **Strict TDD** (`/tdd`): RED before GREEN, one seam at a time. Where an implementation genuinely
  cannot precede its test (a migration column that must exist before any test can reference it), prove
  redness by **stashing the implementation and re-running** — and say so in the record. #241 and parts
  of #250/#251 did this.
- **Verify test sensitivity, not just green.** Several tests this session passed for the wrong reason
  until checked: an AC-5 test used a fixture date that was historical by run time so the guard never
  fired; the hold-date off-by-one and the deferral-date threading were both confirmed by reverting the
  one line and watching the test go red. Do this for any assertion that could pass vacuously.
- **Every session must** update the issue's `Status:`/ACs, add the INDEX status-row marker, append one
  INDEX session-log row (date · what landed · commit hashes), and write
  `docs/progress/<issue>.md`. Edit `docs/SYSTEM-STATE-2026-07.md` **in place** when reality changes.
- **Check the reference images yourself.** Two issues in a row (#251, #245) filed a Reference section
  claiming no v2 image existed when one did (`12-batch-schedule-review.png`,
  `11-vehicle-unavailability.png`). Treat the issue's Reference line as a hint, and `ls
  docs/ui/desktop/v2-reference/` as the truth.

---

## Suggested skills

- **`/tdd`** — the mandatory red-green protocol for every slice. Invoke it per slice, not per session.
- **`/review`** (or `/code-review`) — run over the #240/#241/#250 diffs and the #251 diff before
  starting #245. None of the four has had a review pass; the user was offered one and it was deferred
  in favour of continuing implementation.
- **`/field-ops-director`** — genuinely worth a pass on **#245 and #246**. They are the
  approval-workflow and mobile-date-entry slices, where field reality (an SE standing at a plant, a
  manager rewriting a return date) should sanity-check the design before the UI is built. This was
  flagged in the previous handoff and still has not been done.
- **`/simplify`** — optional post-green pass on #245, which is the largest remaining slice.
- **`/diagnose`** — if the two voucher failures ever need to be actually resolved rather than
  documented as pre-existing.
