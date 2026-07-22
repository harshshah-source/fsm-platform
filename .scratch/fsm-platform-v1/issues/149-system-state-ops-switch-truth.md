# 149 — Current-state docs misstate the single most consequential operational fact
Status: ready-for-agent
Type: AFK

> Source: `docs/audits/2026-07-22-adversarial-review-admin-backend.md` §2.1 and §6.1 (X1, `advisory`),
> plus two additional stale-doc defects found independently during roadmap conversion (2026-07-22).

## Background

`CLAUDE.md` makes `docs/SYSTEM-STATE-2026-07.md` **the only** current-state document: *"when reality
changes, edit its sections **in place**; never create a new 'current state' / 'progress' / 'status'
doc."* Its accuracy is therefore load-bearing — it is the second thing every new session reads.

## Problem

`docs/SYSTEM-STATE-2026-07.md:67` states:

> *"…(3) two **deliberately-OFF** ops switches (`INGESTION_SCHEDULER_ENABLED`,
> `BUSINESS_SWEEPS_ENABLED`). **Nothing runs unattended today.**"*

**False.** `apps/backend/.env:38` carries `BUSINESS_SWEEPS_ENABLED="true"`.

## Root Cause

The sentence describes **code defaults** in a form phrased as **deployed reality**. The two are
genuinely different things here, and only this one sentence conflates them.

The audit checked the document line by line and correctly narrowed the finding — a distinction worth
preserving, because a reviewer inheriting a "SYSTEM-STATE is stale" verdict would over-correct:

| Line | Claim | Verdict |
|---|---|---|
| `:449` | *"All three master switches **default** OFF"* | **Accurate** — a claim about code defaults (`business-sweep-scheduler.service.ts:27-36`), which are OFF |
| `:751` | *"`BUSINESS_SWEEPS_ENABLED` unset"* | **Accurate** — inside a dated `>` blockquote recording an earlier session; historical records are correctly frozen |
| `:67` | *"two deliberately-OFF ops switches … Nothing runs unattended today"* | **FALSE** |

**The defect is one sentence, not a stale document.**

## Evidence

`apps/backend/.env`, verified 2026-07-22:

```
18: INGESTION_SCHEDULER_ENABLED="false"
24: PARTITION_MAINTENANCE_ENABLED="false"
38: BUSINESS_SWEEPS_ENABLED="true"        ← sweeps fire every 5 minutes
```

### Two additional stale-doc defects (not in the audit)

Found while verifying [#107](./107-ci-concurrency-guard-migration-tests.md)'s blockers:

1. **`docs/agents/issue-tracker.md:3`** — *"This repo is not (yet) a git repository and has no
   GitHub/GitLab remote, so there is no `gh`/`glab` workflow — operate on files."*
   It **is** a git repository with a live remote:
   `origin  https://github.com/harshshah-source/fsm-platform.git`, and the working tree is in sync
   (`git rev-list --left-right --count origin/feat/autoplant-integration...HEAD` → `0 0`).
2. **`docs/agents/workflow.md:47`** — lists Issue 01 as HITL partly because *"CI needs a git remote"*.
   That blocker no longer exists, and it is currently the stated reason #107 is parked.

Combined with the audit's measured ~9-minute unattended full-suite run (which disproves the standing
OOM objection), **both stated obstacles to #107 are gone.**

## Current Behaviour

An operator reading the only current-state document concludes the system is fully quiescent. In fact
a sweep with an irreversible failure mode ([#148](./148-sweep-staleness-precondition.md)) fires every
five minutes. The two agent docs additionally park #107 behind a blocker that no longer exists.

## Expected Behaviour

`SYSTEM-STATE:67` reads true against `.env`, and states the **consequence**, not just the fact — it
points at #148. The two agent docs reflect the real remote, and #107's HITL framing is corrected.

## What to build

Three in-place doc edits. No code.

> **Edit in place.** `CLAUDE.md` forbids forking a new current-state doc. `:449` and `:751` must be
> left **unchanged** — both were verified accurate, and `:751` is frozen history.

## Acceptance criteria

- [ ] `SYSTEM-STATE:67` reads true against `apps/backend/.env`: business sweeps **are** enabled and running; ingestion and partition maintenance are OFF.
- [ ] That line states the consequence, not merely the fact, and points at [#148](./148-sweep-staleness-precondition.md).
- [ ] `SYSTEM-STATE:449` and `:751` are **unchanged** — verified by `git diff` touching only the one region.
- [ ] Edited **in place**; no new status / progress / current-state doc is created.
- [ ] `docs/agents/issue-tracker.md:3` corrected — the repo has a git remote; the "operate on files" convention for *issues* is retained (that part is still true and is the project's chosen workflow).
- [ ] `docs/agents/workflow.md:47` corrected, and **#107's HITL framing updated** to record that the remote exists and the OOM objection is disproven.
- [ ] `.scratch/fsm-platform-v1/INDEX.md` session log appended.

## TDD Strategy

**TDD does not apply — this is documentation.** There is no behaviour to assert and no test that could
meaningfully fail.

**Verification is direct and cheap:** read the corrected line against `apps/backend/.env` and confirm
`git diff` touches only the intended regions of the three files. The one real risk is over-correction
— editing `:449` or `:751`, both of which are accurate — so the diff review *is* the acceptance check.

## Implementation Slices

### Slice 1 — Correct all three doc defects

- **Objective:** current-state and agent docs read true.
- **Files:** `docs/SYSTEM-STATE-2026-07.md` (line 67 region only),
  `docs/agents/issue-tracker.md` (line 3), `docs/agents/workflow.md` (line 47),
  `.scratch/fsm-platform-v1/INDEX.md` (session log).
- **Services / Database / Frontend / Tests:** none.
- **Acceptance criteria:** all seven above.
- **Definition of Done:** `git diff` shows only the intended regions; `:449` and `:751` untouched.

Single slice — all three edits belong to one coherent commit ("make the docs true").

## Rollback Plan

Documentation-only revert. No runtime surface, no schema, no data.

## Dependencies

None. **Should land before or alongside [#148](./148-sweep-staleness-precondition.md)** — this
document is what currently conceals that risk.

## Estimated Effort

15 minutes. **Priority: P1** — trivial effort, and it removes an actively misleading operational claim
from the one document every session is required to read.

## UI surfaces
n/a (documentation)

## Reference
n/a

## Blocked by
None.
