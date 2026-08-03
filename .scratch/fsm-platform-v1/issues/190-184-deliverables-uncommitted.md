# 190 — #184's test-infra deliverables are uncommitted while #184 reads `done`

Status: ready-for-agent
Type: AFK · Test infra · Tracker integrity

Filed 2026-08-03 by operator directive during the mobile-readiness slice work. Not a re-opening of
#184's *investigation* (that work is real, and its conclusions are not in dispute) — this issue owns
the fact that **the work exists only in one machine's working tree**. `#184`'s own `Status:` line
says `done`; `git status` says otherwise.

## The defect

Every artifact `INDEX.md`'s #184 session-log entry describes as landed is **uncommitted** on
`feat/autoplant-integration` as of `ed40ddf`:

| Path | State | What #184 says it is |
|---|---|---|
| `apps/backend/scripts/run-tests.mjs` | modified, uncommitted | AC-4 crash auto-recovery — diffs vitest's per-file completion lines against the expected glob and retries only the dropped files |
| `apps/backend/vitest.config.ts` | modified, uncommitted | AC-1 instrumentation hook + the `TINYPOOL_CRASH_LOG` execArgv gate |
| `apps/backend/test/crash-diagnostics.ts` | untracked | AC-1 in-child crash logger |
| `patches/tinypool@1.1.1.patch` | untracked | AC-1 parent-side `(exit code, signal)` instrumentation |
| `pnpm-workspace.yaml` | modified, uncommitted | registers the patch via `patchedDependencies` |
| `audit/verify-run1.txt` | untracked | captured run evidence |

**Additionally — a dangling citation.** `run-tests.mjs` and `vitest.config.ts` both cite
`docs/progress/184-vitest-worker-exited-unexpectedly.md` as the authority for why
`poolOptions.forks.singleFork` was evaluated and rejected. **That file does not exist** — not
committed, not present on disk. The rationale for a live configuration decision is currently
unrecorded anywhere durable.

## Why it matters

The retry wrapper is not cosmetic: #184 established that the underlying Windows child-process
native fault (`STATUS_STACK_BUFFER_OVERRUN`, 5 of 6 captured crashes) **cannot be fixed** in test or
application code, and that `run-tests.mjs`'s targeted retry is what converts a silently-dropped test
file into a recovered one. A fresh clone or CI checkout gets:

- no retry wrapper → a crash silently drops 1-2 spec files and the run still reports a summary,
- no `tinypool` patch → no diagnostics if it recurs,
- no `crash-diagnostics.ts` → the `setupFiles` entry in an (also uncommitted) config,

i.e. **exactly the failure mode #184 was opened to eliminate, reintroduced for everyone except the
one machine that fixed it.** Concretely: CI or a new contributor sees non-reproducible failures, and
the natural conclusion — "the suite is flaky on my machine" — is the same wrong conclusion #184 spent
a full investigation correcting.

This is the sixth instance in a week of a status line diverging from what the repository actually
contains (#99, #176, #91, the 07-31 audit's #162 line, #184's own AMENDED-rate note, and this) — see
the standing convention note at the top of `INDEX.md`.

## What to do

1. **Commit the six artifacts above** as one coherent test-infra commit referencing #184. They are a
   single unit — committing `vitest.config.ts` without `crash-diagnostics.ts` breaks `setupFiles`,
   and committing `pnpm-workspace.yaml` without `patches/` breaks `pnpm install` for everyone.
2. **Write the missing `docs/progress/184-vitest-worker-exited-unexpectedly.md`**, or amend both code
   comments to cite whatever record actually holds the `singleFork` rejection rationale. Do not leave
   a live config decision citing a non-existent document.
3. **Verify from a clean checkout** that `pnpm install` succeeds with the patch registered and that
   `pnpm --filter backend test` uses the retry wrapper — the claim "CI's drift gate is the actual
   check" (#91 Slice 1's phrasing) applies here too: this has never been validated anywhere but the
   authoring machine.
4. **Reconcile #184's `Status:`** to reflect reality once the above lands.

## Acceptance criteria

- [ ] All six artifacts committed and pushed; `git status` clean of them
- [ ] `docs/progress/184-...md` exists, or the two code citations point at a document that does
- [ ] `pnpm install` from a clean clone applies `patches/tinypool@1.1.1.patch` without error
- [ ] A full-suite run on a clean clone demonstrably uses the retry path (force or simulate one
      dropped file and show it recovers)
- [ ] #184's `Status:` line matches the committed state

## UI surfaces

n/a — test infrastructure only.

## Blocked by

- None. Purely a commit-and-verify task; the engineering it depends on is already written.

## Comments

n/a.
