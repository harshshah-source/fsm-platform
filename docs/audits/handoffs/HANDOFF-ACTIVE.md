# HANDOFF — #339 acting-scope gate — 2026-09-03

Auto-handoff: **ARMED** (note "wave 1 - #339 acting-scope gate"). Fired at the 50% context threshold.
Disarm with `/autohandoff off` when the run finishes, and rename this file
`HANDOFF-<issue>-<date>.md` in place — that folder is the audit trail, nothing moves to `docs/archive/`.

Status: active
Issue: `.scratch/fsm-platform-v1/issues/339-acting-scope-gate-unavailability-windows.md`
Branch: `feat/autoplant-integration` · this run's commits: `abb0f0f` `1f20620` `fa11c55` `35bca9e`
`543e986` `d080433` `806bb7a` `deca11d` `ea155b3` `0001f9b` `aa0eaba` `a1270ad`

## The job

Build the module-gaps completion backlog — **31 slices, issues #336–#366** — filed 2026-09-03 from the
14-module gap survey. The brief is **`docs/module-gaps/IMPLEMENTATION-PLAN.md`**: §1 lists 21 survey
findings corrected or refuted (**do not build against the survey brief where §1 disagrees with it**),
§3 the wave/dependency table, §4 the per-slice detail, §7 the operator decisions and the default each
slice assumes. `INDEX.md` section **P12** carries the same table with links.

One slice at a time, red-first (`/tdd`), each with a `docs/progress/<issue>.md` report, an INDEX row
update and a session-log line.

**#336 and #338 are DONE and reported. #339 is functionally complete and committed as WIP** — what
remains is verification and bookkeeping, listed below.

## Next step

**Finish #339, in this order:**

1. **Read the full backend suite result.** A run was started after the guard landed and had not
   finished when this handoff was written: `apps/backend/.scratch/…` no — the log is
   **`.scratch/backend-suite-339.log`** (repo root), written by `npm test` in `apps/backend`. A global
   guard touches every route, so this is the check that matters. If it is not there or is stale,
   re-run `cd apps/backend && npm test`. Expect ~16 min and one `#184` worker-crash retry.
2. **Write `docs/progress/339-acting-scope-gate.md`** — the per-issue TDD report. #338's
   (`docs/progress/338-durable-notification-outbox.md`) is the shape to copy.
3. **Tick the ACs in the issue file** and set `Status: done …`.
4. **INDEX.md**: update the P12 row for #339 and append a session-log line (leave the file
   uncommitted, see below).
5. Then continue the wave: **#340** (acting attribution — 11 `actedAsRole: null` sites, bulk-unassign
   column overload, backup-share report), which #341 depends on together with #339.

## Standing instructions from the user

Quoted, not paraphrased:

- **"continue and use /autohandoff on"** — the most recent instruction. The loop is armed with the
  note "wave 1 - #339 acting-scope gate".
- **"start implementation and use /autohandoff on"** — given *after* being shown that the tree carries
  ~246 uncommitted files from the parallel scheduler-forensics run and that suite runs therefore
  verify a mixture. The user reaffirmed. **That is their decision; the run proceeds on the dirty base.**
- **"leave that, start implemettation of our issues and use /autohandoff on"** — said after I asked
  whether taking over `HANDOFF-ACTIVE.md` from the other run was acceptable. Settled; do not reopen.
- **"use option 3, then finish 336 and continue"** — the Platinum fixture is a scoped, expiring tier
  override (#157), never a re-tiered company.
- **"option 1"** — on #338's migration: hand-write it and rely on the suite, flagging that the drift
  gate was not run. **Standing answer for any later migration in this run.**
- **"commit it and start 338"** — commits are wanted per slice, **explicit paths only**.
- From the plan session, still live: *"Analyze the `docs/module-gaps/` results against the **current
  codebase** … verify every important finding against the current code before creating work. Do not
  blindly implement the report."*
- Treat the AFK policy in `CLAUDE.md` as live: keep going down the wave order, stop only for
  architecture / business-rule conflict / backlog-ownership / external-access / security.
- **Handoffs live in `docs/audits/handoffs/HANDOFF-ACTIVE.md`.** There is only ever one.

## State of the tree

- **This run's work is committed** through `a1270ad`, explicit paths only, never `git add -A`.
- **FOUR FILES THIS SLICE NEEDS ARE DELIBERATELY UNCOMMITTED**, because their diffs interleave the
  parallel run's uncommitted work with mine in the same hunks. Committing them would carry that run's
  code. **Do not stage them, and do not revert them — #339's tests do not pass without them:**
  - `apps/admin/src/components/shell/TopBar.tsx` — mine is 3 lines in `enterActing`: passing the
    picked zone's **name** to `setActingZone`. (The zone *picker* itself is the other run's work.)
  - `apps/admin/src/pages/settings/SettingsPage.tsx` — mine is one `GROUPS` entry:
    `{ id: 'manager-availability', … <ManagerAvailabilitySection /> }` under Field operations.
  - `apps/admin/test/acting-banner.test.tsx` — mine are the three `#339` assertions (banner by name,
    enter/exit recorded, ZM sidebar while acting) plus the `calls[]` fetch-recording stub.
  - `apps/backend/test/dashboard-acting-scope.e2e-spec.ts` — **untracked, entirely the other run's
    file.** Mine is the `zmOutWindowId` fixture in `beforeAll`/`afterAll`: the CSM case now needs an
    open ZM window, because the gate refuses without one.
- **`.scratch/fsm-platform-v1/INDEX.md` and `docs/SYSTEM-STATE-2026-07.md` are also deliberately
  uncommitted**, same reason. Their #338 content is written and correct; #339's INDEX rows are NOT
  written yet (step 4 above).
- **Uncommitted and NOT this run's: ~246 further paths** under `apps/` and `packages/` — the
  scheduler-forensics run's #297–#334.
- **Tests, verbatim, after the last code change (`a1270ad`):**
  - backend `acting-context.e2e-spec.ts` → **12 passed** (8 of them red before the change);
  - backend acting/guard neighbourhood (`dashboard-acting-scope`, `assign-batch-acting-scope`,
    `role-backup-controller`, `role-backup-service`, `global-guard-validation`, `exception-filter`,
    plus the five other specs that send the header) → **12 files, all passing**;
  - admin `manager-availability` 4 + `acting-banner` 5 + `acting-zone-scope` 2 → **3 files, 11 passed**;
  - **full admin suite → 120 files / 838 tests, all passing** (1 reported error = the known #335
    drawer crash, pre-existing, filed);
  - `npx tsc --noEmit` (backend) and `npx tsc -b` (admin) → **exit 0**.
  - **Full backend suite: STARTED, RESULT UNKNOWN.** See step 1.
- **Half-done / stubbed:** nothing. #339's code is complete; only verification and bookkeeping remain.

## Done so far

- **#336 — DONE** (`abb0f0f`). Report: `docs/progress/336-dev-seed-fixtures.md`.
- **#338 — DONE** (`1f20620` `35bca9e` `543e986` `d080433` `806bb7a` `deca11d` `ea155b3` `0001f9b`,
  bookkeeping `aa0eaba`). Report: `docs/progress/338-durable-notification-outbox.md` — it owns the
  detail. All twelve post-commit `notify()` sites are durable outbox rows.
- **#339 — code complete** (`a1270ad`). The commit message owns the per-part reasoning.

## Decisions taken (not recoverable from the diff)

**#339**

- **A CSM is allowed only when the cascade says so, not merely when the ZM is out.** The gate calls
  `currentActingRoleForZone(zone)` and requires the answer to be `CENTRAL_SERVICE_MANAGER`. So a CSM
  who is themselves marked unavailable is refused — the duty has already passed to Operations Head,
  and standing in would be acting for a role they no longer hold. An **OH is allowed unconditionally**
  (AC2): pan-India authority is already theirs, so the header only narrows what they see.
- **A ZM/WM sending the header is ignored, not refused** (AC7, unchanged behaviour). Refusing would
  turn a harmless header the admin shell may still be sending into a broken session for the one role
  that cannot widen anyway.
- **The decorators' fallback is the non-acting context, never a re-parse.** Re-deriving acting from
  the header inside `@CurrentActor`/`@CurrentScope` would restore exactly the ungated grant the guard
  removes, from a path that reads like a safety net. `notActing(role)` in `auth/acting-context.ts` is
  that fallback, and it is the only thing left in that file besides the role set and the type.
- **A window is ENDED, never deleted** (`DELETE /role-unavailability/:id` stamps `window_end`). The
  row is the record of who was covering a zone while decisions were being made in it, and Issue 27's
  CSM-backup-share report reads that history.
- **`role_unavailability.zone_id` has no FK relation in the schema**, so the list resolves zone names
  with one extra `zone.findMany` rather than an `include` — and rather than a migration this slice has
  no other reason to write (the drift gate cannot run on this box).
- **Manager availability is routed at `/manager-availability` for the CSM as well as living in
  Settings**, following #238's precedent exactly: Settings is OH-only, and widening it would hand the
  CSM zone/plant/user/company/SLA/scoring CRUD to reach one table. Both render the same component.
- **The acting audit calls are fire-and-forget and are fired AFTER `sessionStorage` is written**,
  because `authHeaders()` reads the zone from there — an exit posted before the clear would carry the
  zone, an entry posted before the write would carry none.

**#338** (still worth carrying forward)

- **Two row shapes.** A site that calls `NotificationService` directly enqueues a resolved
  `NotifyInput` (`queueNotification`); a site that goes through a **port** enqueues the *event* and the
  drain hands it to that port. Do not flatten a port into a resolved notice.
- **Any new deliverer goes in the `OutboxDeliverers` bag, and the sweep must carry it.** Part 1's
  defect was a `useFactory` one positional argument short of the notify deliverer.
- **#354's scope shrank**: #338 gave every cross-zone door its own transaction (CZ-02). #354 still
  owns CZ-01 (`approve`'s assignment and escalation update are two transactions). Plan §4 is stale on
  this point; the code says so at the site.

## Dead ends — do not retry

- **Do not `git add` a directory.** `git add apps/backend/test/` staged ~60 of the other run's files;
  caught with `git status --porcelain` before committing. Stage individual paths.
- **Do not commit the four mixed files listed under "State of the tree"**, `INDEX.md` or
  `SYSTEM-STATE-2026-07.md` while the other run's tree is uncommitted.
- **Do not defer an enqueue (or a gate) because "there is no transaction to enqueue into".** That
  reading was wrong three times in #338 — the mutations were local and a local transaction was
  available. Check before concluding a slice is blocked.
- **Do not hand an interfering Prisma proxy only to the service under test when the write goes through
  `withAudit`** — it opens its transaction on the **`AuditService`'s own** client. Build both on one
  client (#325's spec records the same trap).
- **Do not regenerate `prisma/drift-baseline.txt`** (99 lines, must not grow).
- Everything under **Dead ends**/**Gotchas** in `HANDOFF-scheduler-forensics-wave3-2026-09-03.md`
  still applies.

## Gotchas

- **The Bash tool truncates a long heredoc**, and the shell then fails with `unexpected EOF while
  looking for matching`. Write files over ~120 lines with the Write tool, or split the script.
- **`print()` of non-ASCII fails on this box** (`cp1252` stdout) *after* the file write has already
  happened — the traceback looks like the write failed when it did not. Check the file before
  redoing an edit; a blind retry can double-apply.
- **A backgrounded command piped through `tail` writes nothing until it exits.** Use `tee <log>` if
  you want to watch progress (that is why `.scratch/backend-suite-339.log` exists).
- **The e2e fixture logins are `zm.north@fsm.test`, `csm@fsm.test`, `ops.head@fsm.test`, `wm@fsm.test`,
  `se.north@fsm.test`** (`src/auth/auth-fixture-seed.ts`) — there is no `oh@fsm.test`.
- **`tsc --noEmit` does not cover `test/`** — a spec's type error surfaces only from the suite.
- **The generated Prisma client is TypeScript** (`src/generated/prisma/client.ts`), so a throwaway
  `node` script cannot require it. Query the test DB from a spec, not a script.
- **The drift gate cannot run on this box** — the local Postgres role has no `CREATE DATABASE`.
- **`apps/backend/src/generated/` is gitignored** — run `npx prisma generate` after a schema edit.
- **The Bash tool's cwd persists across calls**; a backgrounded `cd` does not affect it.
- **The admin suite reports 1 error with everything green** until #335 lands.
- Two backend files are known-flaky and neither is broken: `dispatch-crashed-zone-recovery`,
  `global-guard-validation` (#184).

## Remaining acceptance criteria

**#339** — all seven are **built and tested**; none is ticked in the issue file yet (step 3). AC1/2/3/5/7
by `acting-context.e2e-spec.ts`; AC4 by that file's backend half plus admin `manager-availability`;
AC6 by admin `acting-banner`.
**#336, #338** — none; both closed and reported.
Every other slice #337, #340–#366 is unstarted.

## Open questions / HITL

- **The request-scoped acting guard** #339 assumes was raised to the user and is unanswered. It was
  **built on plan §7's default** (recommended; no new framework) — `ActingContextGuard` as a global
  `APP_GUARD`. If the user answers differently, that is the file to change.
- **AA-06** (auto-open a ZM window from a >24 h login gap) — **not built**, per the issue's own
  recorded default. Windows are opened by OH/CSM from Settings.
- **Plan §7 holds ten operator decisions**, each with the default its slice assumes. None blocks #340.
- **#337 needs FCM credentials** (external provisioning). The seam builds; only live delivery is blocked.
- **The dev database has not been seeded.** `SEED_DEV_WALK_FIXTURES=true npm run seed:dev-fixtures` is
  an operator action; until it runs, the 17 blocked survey findings stay blocked.

## Suggested skills

- **`/tdd`** — red-first per slice; each slice's Verification line in plan §4 is the test to write first.
- **`/code-review`** — per finished slice, before the bookkeeping.
- **`/diagnose`** — when a cited `file:line` no longer matches behaviour.
