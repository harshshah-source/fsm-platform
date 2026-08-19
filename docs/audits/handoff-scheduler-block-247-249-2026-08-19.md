# Handoff — the #240→#244 chain is closed; next is #247 / #248 / #249. Nothing is uncommitted.

**Written 2026-08-19.** For the session that continues the scheduler/assignment block.

**Nothing of this session's work is uncommitted.** This file exists to carry three things a fresh
agent cannot recover from the commits: what is *next* and why, a small set of measured facts about
this environment that cost real time to learn, and two open decisions nobody has ruled on.

---

## Read these first (do not re-derive)

Mandatory order per `CLAUDE.md`: `CLAUDE.md` → `docs/SYSTEM-STATE-2026-07.md` →
`.scratch/fsm-platform-v1/INDEX.md` → the issue being worked.

- `.scratch/fsm-platform-v1/INDEX.md` — the **"Scheduler-decisions block"** table (items 60–71) and
  the 2026-08-19 session-log rows. Those rows carry the findings in full; do not rebuild them.
- `docs/progress/242-unresolved-assignment-recycling.md` and
  `docs/progress/244-special-ticket-identification.md` — this session's two slices, frozen.
- `docs/archive/handoff-242-243-option-b-2026-08-19.md` — **consumed, historical only.** Its #243
  measurements are stale by design.

---

## State of the tree

Branch `feat/autoplant-integration`. Four commits this session, all gated:

| Commit | Slice |
|---|---|
| `98d933f` | #242 — unresolved assignments recycle at closure (`PLAN_EXPIRED`) + the bucket-less ledger counter |
| `fb045c5` | docs — #242 recorded, handoff archived, follow-up #252 filed |
| `e18a3a2` | #244 — Special ticket: derived identification, threshold, admin surfacing |
| `cb3cba4` | docs — #244 recorded |

**#242's migration is applied to the dev DB** (`fsm` @ `localhost:5433`):
`20260819140000_bucketless_dropped_ledger`. #244 needed no migration.

Latest full backend suite (at `e18a3a2`): **380 files all accounted for after one crash-triggered
retry, 1844 passed / 2 failed** — both the known pre-existing `voucher-controller` pair. Admin
514/515 (one flake, see below). Both typechecks and `vite build` clean.

The tree still carries **~73 uncommitted files of unrelated in-flight work** (admin chart redesign,
`manager-scope.ts` / acting-zone, `#238`, `#239`, visual baselines, `run-tests.mjs`, `audit/*`).
**Do not sweep them.** Three files needed hunk-level staging this session to keep that work out of
these commits — `INDEX.md`, `docs/SYSTEM-STATE-2026-07.md` and
`apps/admin/src/pages/reports/DeviceDetailPage.tsx`. The `git add -p`-style recipe works and is
worth reusing: write a reduced version (HEAD + only your hunks), `git add` it, restore the full
version, commit. Verify afterwards that the committed copy and the working copy each contain your
change exactly once.

---

## What is next

**#247 / #248 / #249 are all unblocked by #246 ✅ and are parallel** — no ordering between them:

- **#247** `resumeSla` pause-reason check + primary-SLA auto-resume sweep on the authoritative date.
- **#248** Option C: one comparator key below consolidated `CRITICAL_PLUS` (TS-only).
- **#249** Manual override of a return-date deferral requires explicit `confirm` + reason.

Two notes that affect them specifically:

- **#248 touches the comparator that #244's AC-6 pins.** That pin was written against the *ordering
  itself* (moving the Special threshold changes verdicts and leaves the row sequence byte-identical),
  precisely so it holds before and after #248 lands. If #248 legitimately changes the sequence, that
  test's fixture ordering may need updating — but the *property* it asserts (Special contributes
  nothing to ordering) must survive unchanged.
- **#252** was filed this session as a #244/#238 follow-up: neither `bucketless_dropped` nor
  `withheld_below_threshold` is projected by `DispatchRunZoneCard`, so neither reaches the admin
  transparency page. `ready-for-agent`, small, independent of the above.

**#243 stays HITL and is not yours to execute.** Both its prerequisites are now met, and Option B's
"clean once, on a frozen set" is now achievable — but every count in its issue file and in the
archived handoff is stale (the recycler released ~198 on its first nightly run, and the C2 class had
already moved +299 in one night before that). Re-measure, then ask. Do not `pg_dump`, do not write
the cleanup script into a runnable state.

---

## Measured facts about this environment (each cost real time)

- **The `#184` worker crash is probabilistic, and a single control run will mislead you.** This
  session a full-suite crash on `global-guard-validation.e2e-spec.ts` survived all three retries; one
  revert-and-rerun made it pass, and I wrongly concluded the crash was mine. Repeat measurement
  settled it: **1/5 on the changed tree vs 2/6 at HEAD with the change reverted.** If you suspect a
  crash is yours, measure a *rate*, not a single run.
- **Never run two full backend suites at once** (shared `fsm_test`, global-setup truncates), and note
  that a concurrent backend suite also makes the **admin** suite flake in a *different file each run*.
  Admin was 3-failures-under-contention, then 1 failure alone, then 4/4 green in isolation — same
  files, no code change. Judge admin only when it runs alone.
- **Known pre-existing failures: 2**, both `test/voucher-controller.e2e-spec.ts`.
- **`tsconfig.test.json` is not a clean gate.** `pnpm typecheck` is `src`-only by design; the test
  project has many pre-existing errors across the repo. Grep the output for *your* files.
- **Patch-script traps that bit this session** (Python/regex editing of TS):
  - backticks inside a SQL comment **inside a template literal** silently terminate the string —
    `TS1005` a hundred lines away;
  - an escaped apostrophe in a `it('...')` title came out unescaped and produced a bare
    `Syntax Error`. Avoid apostrophes in test names entirely;
  - the repo has mixed line endings — detect and restore the file's own ending on write.
- **`seedDefaults` upserts with `update: {}`**, so a `system_settings` row created by any other route
  (a test fixture, a hand edit) never gets its description backfilled. A #244 test caught exactly
  this. If you create a settings key outside the registry, include the description.
- **`OverrideService` takes no advisory lock**, which is why #242's writes key on `removed_at IS NULL`
  as well as on `id`. Assume manager writes can interleave with any sweep.
- Dev Postgres `localhost:5433`, db `fsm`; credentials in `apps/backend/.env`. `psql` is not on PATH —
  use `"C:\Program Files\PostgreSQL\16\bin\psql"`. No CREATEDB rights on this role.
- Runner is **vitest**, not jest, despite `.e2e-spec.ts` naming. Full suite:
  `node scripts/run-tests.mjs` from `apps/backend` (~12–25 min). Admin: `npx vitest run` +
  `npx vite build` in `apps/admin`. Mobile: `npx jest` + `npx tsc --noEmit`. After editing
  `packages/shared/src`, run its `npm run build` or the backend will not see the new types.

---

## Working conventions that mattered

- **Strict TDD** (`/tdd`): RED before GREEN. Where an implementation genuinely cannot precede its test
  (a schema column), prove redness by stashing and re-running, and say so in the record.
- **Verify test sensitivity, not just green.** Both slices this session broke each load-bearing
  behaviour one at a time and confirmed exactly the right test went red (#242: four probes, one of
  which proved the recycle-ordering is already pinned by #147's own spec; #244: five probes). Cheap,
  and it is the only thing separating a passing test from a test that would pass anyway.
- **Check reference images yourself.** `ls docs/ui/desktop/v2-reference/` is the truth; the issue's
  Reference line is a hint. Four issues in this block filed a wrong one.
- **Every session must** update the issue's `Status:`/ACs, the INDEX status row, append one INDEX
  session-log row (date · what landed · commit hashes), and write `docs/progress/<issue>.md`. Edit
  `docs/SYSTEM-STATE-2026-07.md` **in place**.
- When an issue's own text turns out to be wrong, **correct it in place and say so** rather than
  quietly building the right thing — three corrections landed this session (#242's false "surfaces
  through the transparency page" claim, its superseded enablement gate, #244's vague Reference line).

---

## Open items nobody has ruled on

- **A native mobile date picker** (#246). Entry follows the leave form's plain `YYYY-MM-DD`
  precedent; a native picker is an Expo dependency decision, not a gap. Unchanged.
- **`CLAUDE.md` is stale** where it says the SE Mobile App is "auth shell only so far" — mobile has
  49 suites and a dozen screens. Left unedited because it is the operator's file, but a session could
  wrongly escalate a mobile AC as a missing-shell backlog gap on the strength of that line.
- **No review pass** (`/review` or `/code-review`) has been run over #240/#241/#250/#251/#245/#246,
  and now #242/#244 either. Offered and deferred repeatedly in favour of implementation.
- **`/field-ops-director`** on #245/#246 — flagged in three previous handoffs, still not done.
- **Special affecting sort order** is deliberately *not* built (#244 is identification-only). If it is
  ever wanted, that is a materialisation decision requiring a follow-up issue, not a quiet change.

---

## Suggested skills

- **`/tdd`** — the red-green-refactor protocol every slice in this block has followed. Invoke it
  before writing code for #247/#248/#249, not after.
- **`/implement`** — for driving an issue file end to end once its ACs are understood.
- **`/code-review`** or **`/review`** — the outstanding gap above. #247–#249 are small; a review pass
  over the whole `#240…#244` chain would be more valuable than one over a single slice, and the
  operator has deferred it four times, so **ask before spending the tokens**.
- **`/field-ops-director`** — domain review of the VU/return-date slices (#245/#246) now that they are
  built; would also be the right lens on #247's SLA-resume semantics.
- **`/triage`** — if you file follow-ups; the five-role label vocabulary is used verbatim.
- **`/diagnose`** or **`/diagnosing-bugs`** — only if a suite failure looks new. Measure a rate first
  (see the #184 note above) before concluding it is yours.

Archive this file to `docs/archive/` with a 2-line ARCHIVED banner as soon as it is consumed.
