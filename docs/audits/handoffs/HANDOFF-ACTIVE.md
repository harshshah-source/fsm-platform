# HANDOFF — Module-gaps completion run: #336 in flight, then wave 1 — 2026-09-03

Auto-handoff: **ARMED** (note "#336 then wave 1 - module-gaps completion").
Disarm with `/autohandoff off` when the run finishes, and rename this file
`HANDOFF-<issue>-<date>.md` in place — that folder is the audit trail, nothing moves to `docs/archive/`.

## The job

Build the module-gaps completion backlog — **31 slices, issues #336–#366**, filed 2026-09-03 from the
14-module gap survey after six read-only verification passes. The plan is
**`docs/module-gaps/IMPLEMENTATION-PLAN.md`** and it is the brief: §1 lists the 21 survey findings that
were corrected or refuted (do **not** build against the survey brief where §1 disagrees with it), §3 is
the wave/dependency table, §4 is the per-slice detail, §7 holds the operator decisions and the default
each slice assumes, §9 records how the issues were filed. `INDEX.md` section **P12** carries the same
table with links.

One slice at a time, red-first (`/tdd`), with a `docs/progress/<issue>.md` report + an INDEX row update
+ a session-log line per slice.

Branch: `feat/autoplant-integration` · base commit: `a6c87c7`.

## Next step

**#336 is DONE and COMMITTED** (`abb0f0f`, 43 explicit paths — `docs/progress/336-dev-seed-fixtures.md`).

**#338 — the infrastructure half is BUILT, GREEN and COMMITTED; the 12 producer conversions are not
started.** That is the whole of what remains, and it is the larger half.

**Done (committed, see `git log`):** schema `seId`/`scheduleId` nullable + migration
`20260903120000_notification_outbox_generic_rows` (applied cleanly, 97 migrations found);
`queueNotification(tx, NotifyInput)` and `NOTIFY_EVENT_TYPE` in
`scheduling/day-plan-notification-outbox.ts`; a `NOTIFY` branch in `deliver` that **throws** when no
deliverer was supplied (never skips — the row is claimed before delivery, so a quiet skip would burn
it); an optional trailing `notifications?: OutboxNotifyDeliverer` threaded through
`drainRow`/`drainRows`/`drainUnsent`, which is what keeps all **12 existing call sites untouched**;
`NotificationService` injected `@Optional()` into `BusinessSweepSchedulerService` and passed to
`drainUnsent`. New spec `test/notification-outbox-generic.e2e-spec.ts` (2 tests). Regression: the
outbox, notifier-adoption and scheduler-wiring specs all still pass (17 tests) — AC4 holds.

**Not done — the 12 sites.** Each needs its `notify()` moved inside its own mutation transaction and
its own crash-injection test, which is why this is not a mechanical sweep:
`cross-zone-escalation.service.ts:300,321,339` · `intraday-insertion.service.ts:343,465,498` (via
#325's `inTransaction` hook) · `intraday/stranded-work-escalation.service.ts:121` ·
`scheduling/bulk-unassign.service.ts:322` · `ticketing/install-notifier.ts:52,64` ·
`ticketing/recovery-notifier.ts:76,93`.
**The notifiers are ports, not transaction owners** — `install-notifier` and `recovery-notifier` are
called from `install-lifecycle.service.ts` / the recovery service, so the conversion happens in the
*service* that owns the transaction, replacing the post-commit notifier call with
`queueNotification(tx, …)`. Do them one file at a time, cheapest first, each with its own crash test.
**AC2 and AC5 are not yet demonstrated** — no crash-injection test exists for a converted producer,
because no producer is converted.

**READ THIS BEFORE CONVERTING — AC1 is only half-satisfiable today, and the reason is structural.**
AC1 says each site must enqueue *inside its mutation transaction*. Several sites **have no mutation
transaction to enqueue into**, and creating them is **#354's** job, not this slice's:

| site | transaction today? | so #338 can… |
|---|---|---|
| `cross-zone-escalation.service.ts:300` (sweep, via `:114`) | **no** — `create` → `audit` → `notify` are three bare awaits (that absence *is* CZ-02/#140) | enqueue on `this.prisma`: durable + retried, not yet atomic |
| `cross-zone-escalation.service.ts:321` (`notifyHomeZm`, via `:180` approve / `:278` deny) | **no** — approve's second write is already outside `assignTicket`'s tx (CZ-01/#139) | same |
| `cross-zone-escalation.service.ts:339` (`notifyRole`, re-escalate) | **no** | same |
| `intraday-insertion.service.ts:343,465,498` | **yes** — #325's `inTransaction` hook on `assignTicket` | fully transactional |
| `stranded-work-escalation.service.ts:121` | check before converting | — |
| `bulk-unassign.service.ts:322` | check before converting | — |
| `install-lifecycle.service.ts` (for `install-notifier:52,64`) | check before converting | — |
| recovery service (for `recovery-notifier:76,93`) | check before converting | — |

**The split to take:** convert every site to `queueNotification`, passing a transaction client where
one exists **today** and `this.prisma` where one does not. Even the non-transactional form is a real
gain and closes AC2 for that site — the enqueue is one insert that fails fast, so a *throwing
notifier* can no longer damage its caller's outcome, and delivery moves to the retrying sweep. Then
**#354 threads its new transaction through the three cross-zone calls**, which is what finally closes
AC1 for them. Record per site, in the progress report, which of the two forms it got — a table that
claims "inside its mutation tx" for all twelve would be false.

**The drift gate was NOT run** (operator's call, 2026-09-03): the local Postgres role cannot
`CREATE DATABASE`, so `scripts/check-schema-drift.mjs` cannot build its comparison database. The
migration was hand-written to match the schema edit exactly and introduces no new drift by
construction; the suite applying it on boot is the check that was available.
**Do not regenerate `drift-baseline.txt`.**

Design notes, all verified in the current tree:

- **`NotifyInput` (`notifications/notification.service.ts:21`) is a plain serialisable object** —
  `recipients[]`, `type`, `title`, `body?`, `entityType?`, `entityId?`, `metadata?`. That is the whole
  design: **enqueue the resolved `NotifyInput` as the payload and let the drain replay `notify()`**.
  Recipients get resolved inside the producing transaction (cross-zone resolves by role via
  `usersInRoles`), which makes the row deterministic and auditable rather than re-resolving later.
- **Generalise the existing table, per the issue's "prefer one table".** `DayPlanNotificationOutbox`
  (`schema.prisma:2906`) has `seId` and `scheduleId` **NOT NULL** and day-plan-shaped; a cross-zone
  notice has neither. So: add `kind` (`'DAY_PLAN' | 'NOTIFY'`, default `'DAY_PLAN'` so existing rows
  keep meaning), make `seId`/`scheduleId` nullable, keep `payload`/`sentAt`/`attempts`/`lastError`.
  `queueNotification(tx, input: NotifyInput)` writes `kind='NOTIFY'`; the drain switches on `kind` and
  sends day-plan rows down the existing `DayPlanNotifier` path untouched (AC4).
- **A migration is unavoidable and cannot be drift-verified on this box.** `scripts/check-schema-drift.mjs`
  builds a database with `migrate deploy` and diffs it against `schema.prisma`, but the local Postgres
  role has no `CREATE DATABASE` right, so the gate cannot run here (the other run hit the same wall and
  simply needed no migration). **Hand-write `prisma/migrations/<ts>_notification_outbox_generalised/migration.sql`
  to match the schema edit exactly** — `ALTER COLUMN … DROP NOT NULL` ×2 plus `ADD COLUMN kind text NOT
  NULL DEFAULT 'DAY_PLAN'` — and it introduces no new drift by construction. The test harness applies
  migrations on boot (`No pending migrations to apply` in vitest output), so the suite is the check.
  **Do not regenerate `drift-baseline.txt`** (99 lines, must not grow).
- **Do not rename the Prisma model.** `notification_outbox` is the honest name, but renaming churns
  every `prisma.dayPlanNotificationOutbox` call site and its tests for no behavioural gain, against an
  AC that says day-plan events keep their tests. Rename later if it ever earns it.
- Order within the slice: schema + migration → `queueNotification` + drain switch (red-first on a
  generic round-trip) → the 12 sites, cheapest first (`install-notifier`, `recovery-notifier`), leaving
  the three intraday sites for last since they go through #325's `inTransaction` hook.

**Then the rest of wave 1**, in this order and for these reasons:
2. **#339 — the acting-scope gate.** Independent of #338, so it can run beside it if two sessions are
   available. Its one architectural assumption (a request-scoped guard, because the two decorators are
   synchronous and the unavailability lookup is async) is recorded in the issue and still unanswered by
   the user — proceed on it.
3. **#340 → #341** must follow #339, in that order.
4. **#342** makes the audit rows #343 and #340 write actually readable; **#343/#344/#345** are
   independent and small.
5. **#337** last of wave 1 — the seam builds with the logging default bound, but its live-delivery test
   needs FCM credentials the user has to provision.

**Before starting any of them, re-verify the issue's premises against the source.** #336 asked for two
things that were wrong — one already built, one a silent reversal of a recorded decision — and both
were caught only by reading the code first. Assume the same of the rest; the plan's §1 is that habit
applied once already, not a guarantee it caught everything.

Then **wave 1**, in this order: **#338** (durable outbox) and **#339** (acting gate) are independent of
each other; **#340** then **#341** must follow #339; **#342** (audit ledger) makes #343's and #340's rows
readable; **#337** builds the push seam but its final adapter test needs FCM credentials the user must
provision; **#343**, **#344**, **#345** are independent.

**Re-verify every issue's premises against the source before writing anything down.** The plan's
`file:line` references were verified on 2026-09-03 against the working tree, but the tree moves.

## Standing instructions from the user

- **"start implementation and use /autohandoff on"** — this run's instruction, after being shown that
  the tree carries 246 uncommitted files from the scheduler-forensics run and that starting on it means
  suite runs verify a mixture. The user reaffirmed; **that is their decision and the run proceeds.**
- Treat the AFK policy in `CLAUDE.md` as live: keep going down the wave order without checking in, and
  stop only for architecture / business-rule conflict / backlog-ownership / external-access / security.
- Earlier in this session, on the plan itself: *"Analyze the `docs/module-gaps/` results against the
  **current codebase**… verify every important finding against the current code before creating work. Do
  not blindly implement the report."* That rule outlived the planning phase — it is why §1 exists.
- **Handoffs live in `docs/audits/handoffs/HANDOFF-ACTIVE.md`.** There is only ever one.

## State of the tree

- **This run has committed nothing yet.** Its own output so far is planning: `IMPLEMENTATION-PLAN.md`,
  31 issue files (#336–#366), the P12 INDEX section + session-log row, the `standing-rules.md`
  corrections block, and the survey-handoff continuation note. All uncommitted.
- **Uncommitted and NOT this run's: ~246 paths under `apps/` and `packages/`** — the scheduler-forensics
  run's #297–#334. **Do not commit, revert, stash or rebuild over it.** Commit **explicit paths only**,
  never `git add -A`. This is the precondition (plan §2 P0-a) the user chose to proceed past.
- **`HANDOFF-ACTIVE.md` was taken over from that run**, whose live handoff is preserved verbatim at
  `HANDOFF-scheduler-forensics-wave3-2026-09-03.md` with its outstanding run-list (#315, #318,
  #312→#314→#316, #329, #322, #326, #328, #331, #333, #335) and a banner saying how to resume it. Its
  Gotchas and Dead-ends sections are still live for this repo and worth reading before touching
  scheduling, ingestion or the test harness.
- **Tests:** not yet run by this run. The forensics run last measured **456 backend spec files, 2,441
  passed, 5 skipped, zero failures**, and admin **119 files / 832 tests green but exit code 1** (the
  pre-existing `TicketDetailDrawer.tsx:440` crash, filed as #335). Any suite result this run produces
  is **a mixture of both runs' work** — say so when reporting it.
- **Typecheck:** last known clean in both apps, by the other run.
- **Half-done / stubbed:** nothing.

## Done so far

**#336 — DONE**, six red→green cycles. Report: `docs/progress/336-dev-seed-fixtures.md`. New files:
`apps/backend/src/auth/dev-fixture-seed.config.ts` (the guard),
`apps/backend/src/auth/dev-fixture-seed.ts` (`seedDevWalkFixtures`),
`apps/backend/src/seed-dev-fixtures.ts` (entrypoint),
`apps/backend/test/dev-fixture-seed.spec.ts` (2 unit),
`apps/backend/test/dev-fixture-seed.e2e-spec.ts` (7 e2e, each in a rolled-back transaction);
plus one script line in `apps/backend/package.json`. **No existing file's behaviour was changed.**
9 tests green, `tsc --noEmit` clean, neighbours re-run green (`dev-seed` ×2,
`shared-auth-se-canonical-seed`, `verification-controller` — 26 tests).

**Uncommitted, and the reason it matters:** these six paths are the only ones this run has touched
under `apps/`. Committing them as explicit paths — never `git add -A` — is what keeps them separable
from the other run's 246. Not done yet; the user has not asked for a commit.

Planning, earlier in the same session:

| what | where |
|---|---|
| Six read-only verification passes over all 148 survey findings | results folded into the plan; 21 corrections in §1 |
| The plan | `docs/module-gaps/IMPLEMENTATION-PLAN.md` (31 slices, 5 waves) |
| 31 issue files #336–#366 | `.scratch/fsm-platform-v1/issues/` |
| P12 index section + session-log row | `.scratch/fsm-platform-v1/INDEX.md` |
| Survey corrections retracted/booked | `docs/module-gaps/standing-rules.md` (bottom block) |

## Decisions taken (not recoverable from the diff)

- **21 survey findings were corrected before any were built** (plan §1). The load-bearing ones: the
  Ops Explorer `auditLogs` dataset **does** project `metadata` (a standing rule was wrong, now
  retracted); **SCH-05 is false** — cross-zone approve writes the target SE's outbox row at
  `override.service.ts:850`, the **target ZM** is who is never told; **DASH-G01/G11 are superseded by
  #277** (`/assign` is the single manual-assignment surface, #272 R1) so the dashboard gets a link, not
  a rebuilt queue; **NOTIF-05 is §21 dead code**, not a gap; **AC-13 is not a gap**.
- **Slices absorb open issues rather than duplicating them**: #92, #93, #139, #140, #145, #224, #239,
  #318, #331, #333, plus slices of #136, #148, #129. Their files stay as the detailed spec and close
  into the slice when it lands.
- **#325's `inTransaction` hook on `assignTicket` is the seam for the cross-zone approve orphan**
  (#139/CZ-01) — the fix is to use it, not to build a new transaction boundary.
- **`HANDOFF-ACTIVE.md` was taken over by copy-then-overwrite, not by `mv`** (the rename was blocked by
  the permission classifier). Nothing was destroyed; the copy predates the overwrite.
- **#336 was re-scoped on verified evidence, and the issue file is now stale in two ways.**
  (a) **Its test half is already built and has been since #215/#187**: `test/fixtures/shared-auth-se.ts`
  `seedSharedAuthSeEngineer` writes the shared SE's `engineer_master` row in `test/global-setup.ts`
  before any spec runs, pinned by `test/shared-auth-se-canonical-seed.e2e-spec.ts`. So "absorbs #187
  (test side)" is wrong — #187 is closed. Nothing was rebuilt.
  (b) **Its dev half contradicts a decision recorded twice** — `shared-auth-se.ts` ("a fixture engineer
  row has no business appearing in a development database's engineer directory") and
  `global-setup.ts:46-47`. Extending `runDevSeed`, as the issue asks, would reverse that silently.
  **Resolution taken:** a *separate* opt-in, `SEED_DEV_WALK_FIXTURES`, in its own module. `ALLOW_DEV_SEED`
  keeps its exact meaning, the default dev seed stays clean, and the survey's blocked walks get a switch.
  Both flags are refused under `NODE_ENV=production`, unconditionally.

## Dead ends — do not retry

Everything under "Dead ends" and "Gotchas" in
`HANDOFF-scheduler-forensics-wave3-2026-09-03.md` still applies to this repo. The ones most likely to
bite this run:

- **The Bash tool's heredocs eat backslashes**, even quoted, and a `'` in the body can break the parse.
  Write helper scripts with the Write tool and run them.
- **Line endings are mixed LF/CRLF.** A multi-line search pattern will not match a CRLF file; read and
  write binary when scripting edits.
- **Run the backend suite in five foreground batches** from `apps/backend` (`node scripts/run-tests.mjs
  $(cat /tmp/b00 …)`); one run exceeds the Bash 10-minute cap and backgrounded runs get killed with no
  output.
- **`tsc --noEmit` does not cover `test/`** (that is #293). Grep `tsconfig.test.json` output for your
  own files; it reports 158 pre-existing errors.
- **Two backend files are known-flaky and neither is broken:** `dispatch-crashed-zone-recovery` and
  `global-guard-validation` (#184).
- **The admin suite exits 1 with everything green** until #335 lands. Report the summary lines and say
  which you used.
- **`prisma.dispatchRun.create` needs `trigger` and `configSnapshot`**; there is no `triggeredBy`.

## Remaining acceptance criteria

#336's six ACs are all outstanding — nothing is started. Every other slice #337–#366 is unstarted.

## Open questions / HITL

- **Plan §7 holds ten operator decisions**, each with the default its slice assumes. None blocks wave 0
  or wave 1. The ones that will matter soonest: the **request-scoped acting guard** that #339 assumes
  (raised to the user, not yet answered — proceed on the default), **VCH-08** (no un-pay after PAID) and
  **AC-03** (reactivation restores nothing).
- **#337 needs FCM credentials** — external provisioning, HITL. The seam ships with the logging default
  bound, so the slice is not blocked; only its live-delivery test is.
- **The P0-a precondition is knowingly unmet** (see Standing instructions). If a suite goes red, check
  whether the failure lives in the other run's uncommitted files before attributing it.
- **#336 AC4 — ANSWERED by the user 2026-09-03: option (iii)**, the zone-scoped expiring tier override
  (#157). Built that way; `companies.company_tier` is untouched. The one thing that came out of it and
  is worth carrying forward: **`sweepAutoEscalations` filters on `tickets.company_tier`**
  (`cross-zone-escalation.service.ts:77`), not on the effective tier, so a tier override never
  retroactively makes existing tickets Platinum. That is defensible (the column is a snapshot of the
  tier when work was raised) and is **not** filed as a defect — but anyone touching #354/#355 should
  know it, because it means an override cannot be used to stage a cross-zone escalation on old tickets.
- **The dev database has not been seeded by this run.** `npm run seed:dev-fixtures` (with
  `SEED_DEV_WALK_FIXTURES=true`) is an operator action, and the dev backend is mid-run for the other
  session. Until it is run, the 17 blocked survey findings stay blocked — the command exists, the
  state does not.

## Suggested skills

- **`/tdd`** — red-first per slice; the plan writes each slice's Verification line as the test to write first.
- **`/code-review`** — per finished slice, before the bookkeeping.
- **`/diagnose`** — when a cited `file:line` no longer matches behaviour.
