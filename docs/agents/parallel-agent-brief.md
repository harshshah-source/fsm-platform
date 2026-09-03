# Agent brief template — parallel implementation rounds

Copy this to `.scratch/PARALLEL-BRIEF.md` (untracked) at the start of a parallel round, adjust the
dates and the in-flight specifics, and have every agent read it before touching anything. The
orchestrator's side of the same contract is `docs/agents/parallel-execution.md`.

---

You are one of several agents working the same repository **concurrently** on **file-disjoint** slices.
Read this before you touch anything.

## Project rules that still apply

`CLAUDE.md` is in force. In particular:

- **Reading order:** `CLAUDE.md` → `docs/SYSTEM-STATE-2026-07.md` (current state) →
  `.scratch/fsm-platform-v1/INDEX.md` → your issue file.
- **The brief for your slice is `docs/module-gaps/IMPLEMENTATION-PLAN.md` §4** (find your slice number)
  **plus** `.scratch/fsm-platform-v1/issues/<n>-*.md`. **§1 of the plan lists 21 survey findings that
  were corrected or refuted — where §1 disagrees with the survey brief, §1 wins.**
- **Verify the finding against the current code before building it.** The survey has been wrong in both
  directions. Two slices this week found the issue named one defect and the code had two. If your
  issue's cited `file:line` no longer matches, say so in your report and build against reality.
- **Red-first (`/tdd`).** Each slice's *Verification* line names the tests to write first.
- **Surfacing rule.** An issue with UI acceptance criteria is not done until those are built. Before
  touching any page, read the authoritative reference under `docs/ui/desktop/v2-reference/` then
  `docs/ui/desktop/approved-designs/`. Match layout and hierarchy; do not redesign.
- **Strategic HITL / AFK:** keep going. Stop only for an architecture conflict, a business-rule
  conflict, backlog ownership, external access, or a security event. Record decisions in your report
  rather than blocking on them, and say which default you assumed.

## Concurrency rules — these are specific to this run

**1. You own ONLY the files listed in your task. Do not edit anything outside that list.**
If your slice genuinely needs a file another agent owns, **stop and report it** rather than editing it.
Other agents' edits will appear in the working tree around you — that is expected, not a problem, and
**not yours to revert, stage, or clean up**.

**2. Do NOT run any git command that mutates state.** No `git add`, `git commit`, `git checkout`,
`git stash`, `git restore`, `git reset`. Read-only git (`status`, `diff`, `log`, `show`) is fine.
**The orchestrator commits your slice for you** after inspecting its diff. Leave your work uncommitted
in the working tree and say in your report exactly which paths you touched.

**3. Backend tests MUST go through the lock.** There is one `fsm_test` database on this box and the
local `fsm` role cannot `CREATE DATABASE`, so two concurrent backend suites truncate and re-seed each
other. The symptom is dozens of files "failing" with `401 Unauthorized` at login — it looks exactly
like a real regression and is not one. Always:

```
/c/fsm-platform-backup/.scratch/locks/backend-test.sh npx vitest run test/your-spec.e2e-spec.ts
```

The script cds into `apps/backend` itself, blocks until the DB is free, and releases on exit. It may
wait several minutes; that is correct, let it wait. **Run your named specs, not the full suite** —
the full suite takes ~15 minutes and would hold the lock against everyone else. The orchestrator runs
the full suite once at the end.

**Admin tests need no lock** (jsdom, no database): `cd apps/admin && npx vitest run test/...`.

**4. Typecheck is free and unlocked:** `cd apps/backend && npx tsc --noEmit`, `cd apps/admin && npx tsc -b`.
Note `tsc --noEmit` does **not** cover `apps/backend/test/`, and `tsconfig.test.json` has ~50
pre-existing errors unrelated to any current work — it is not a green gate; grep it for your own error
class rather than reading the whole list.

## Deliverable

1. The slice implemented, red-first, meeting its acceptance criteria.
2. `docs/progress/<n>-<slug>.md` — the per-issue report.
   `docs/progress/341-acting-scope-write-doors.md` is the shape to copy: what it closes, the decisions
   worth keeping and *why*, what was tested and why in that shape, the ACs, the tests verbatim, and
   follow-ups the slice does not own.
3. The issue file's ACs ticked and `Status:` set to `done <date> — report docs/progress/<n>-...md`.
4. **Do not edit `.scratch/fsm-platform-v1/INDEX.md` or `docs/SYSTEM-STATE-2026-07.md`** — every agent
   would collide on them. The orchestrator writes both.

## Your final report back

Keep it short and concrete:

- what you built, and any place the issue's premise was wrong
- the **exact list of paths you touched** (the orchestrator commits by explicit path)
- test results verbatim (file counts and pass counts)
- decisions taken and the default assumed for anything you could not resolve
- anything you deliberately did not build, and why

## Gotchas paid for already this session

- The Bash tool truncates a long heredoc; write files over ~120 lines with the Write tool.
- `print()` of non-ASCII fails on this box (cp1252 stdout) *after* the write already happened — check
  the file before redoing an edit, a blind retry can double-apply.
- The generated Prisma client is TypeScript (`src/generated/prisma/client.ts`), so a throwaway `node`
  script cannot require it. Query the test DB from a spec, not a script.
- `apps/backend/src/generated/` is gitignored — run `npx prisma generate` after a schema edit.
- The Prisma drift gate cannot run on this box (no `CREATE DATABASE`). If your slice needs a migration:
  hand-write it and rely on the suite, and **say in your report that the drift gate was not run**.
  Do not regenerate `prisma/drift-baseline.txt`.
- Two backend files are known-flaky and neither is broken: `dispatch-crashed-zone-recovery`,
  `global-guard-validation` (#184).
- e2e fixture logins: `zm.north@fsm.test`, `csm@fsm.test`, `ops.head@fsm.test`, `wm@fsm.test`,
  `se.north@fsm.test`, password `correct-password`. There is no `oh@fsm.test`.
- Acting is now gated (#339), attributed (#340) and narrowing (#341): a manager write door takes
  `@CurrentScope()` / `@CurrentActor()`, never `{ role: user.role, zoneId: user.zone_id }`. A route
  sweep (`test/acting-scope-route-sweep.spec.ts`) fails any new door that hand-builds a scope — if you
  add a manager write route, use the decorators.
