# Agent Workflow

How an agent should execute work on this repo: when to keep going vs. stop (HITL), how to report
TDD slices, and how to treat the UI references. This file **owns** these three policies; `CLAUDE.md`
points here rather than restating them.

- Authority hierarchy and UI authority order: `docs/agents/domain.md`.
- Backlog, follow-ups, accepted-with-follow-up: `docs/agents/issue-tracker.md`.
- Triage label strings: `docs/agents/triage-labels.md`.
- The red-green-refactor protocol itself: the `/tdd` skill (`.claude/skills/tdd/`). Do not duplicate it.

## Strategic HITL policy

**Default mode is AFK — keep going.** "HITL" on an issue here means *blocked on a human-only input*
(external access, a genuine decision), **not** "needs per-step approval." An issue can be labelled
HITL and still be implemented by an agent; the label flags the blocker, not the author.

**Continue autonomously — do not stop for:** naming, DTO design, endpoint structure, component
organization, test strategy, validation details, or unavailable local infrastructure
(Redis, SMTP, FCM, APNs, WhatsApp). Build the seam: interfaces, adapters, mocks, placeholders, and
TODO integration points. Document assumptions inline and keep going. Do not ask permission between
slices.

**Scope of "build the seam":** it covers *unavailable external infrastructure only* (Redis, SMTP,
FCM, APNs, WhatsApp, SAP, AutoPlant). It does **not** cover an admin page or mobile screen whose
backend endpoint already exists in this repo — those are buildable surfaces, and deferring them
requires a tracked follow-up issue (see the Parity gate under "UI reference system"), not a seam.

**Stop only for a Strategic HITL event:**

- **Architecture decision** — a choice that would materially alter system architecture, service
  boundaries, aggregate ownership, the event model, or database ownership.
- **Business-rule conflict** — authoritative docs disagree (CONTEXT.md / PRD / workflow / issue
  definition). Document the conflict and stop.
- **Backlog-ownership change** — work requires moving ownership between issues, splitting, merging,
  or resequencing the roadmap. Recommend a solution and stop.
- **External access required** — credentials, production access, vendor provisioning, or
  infrastructure provisioning. **Complete all code possible first** (build to the seam); stop only
  at the final integration boundary.
- **Security decision** — changes to the auth model, authorization model, encryption, secrets
  handling, or production-data access. Stop for review.

The two HITL slices are `01` (foundation/infra: PostGIS install, dep installs behind FortiGate) and
`03` (notifications: FCM/APNs/WhatsApp accounts + template approval). Keep both marked HITL in
`INDEX.md`. Everything else is AFK (`ready-for-agent`).

> **Corrected 2026-07-22 (#149).** *"CI needs a git remote"* was removed from `01`'s blocker list: the
> remote exists (`origin` → `github.com/harshshah-source/fsm-platform`) and has for some time, so it
> never was a live blocker. It was, however, **the stated reason
> [#107](../../.scratch/fsm-platform-v1/issues/107-ci-concurrency-guard-migration-tests.md) CI stayed
> parked** — alongside an OOM warning that the 2026-07-22 review disproved by running the full backend
> suite unattended in ~9 minutes (independently re-measured at 539 s). Both obstacles were stale; #107
> slices 1–2 landed the same day. **Stale blockers are worth deleting, not just noting** — an
> untrue blocker parks real work indefinitely.

## TDD execution and per-slice report

All implementation is strict TDD via the `/tdd` skill — vertical tracer-bullet slices,
RED → GREEN → REFACTOR, one test at a time. **Never refactor while RED. Do not skip RED.**

After each slice, report:

- **AC targeted** — which acceptance criterion this slice advances.
- **RED** — the failing test and its failure.
- **GREEN** — the minimal implementation that passed it.
- **REFACTOR** — what was cleaned up (or "none").
- **Tests / typecheck** — counts and result for each affected package.
- **Remaining work** — what's left on the AC.

If RED was skipped, stop and redo the slice test-first.

## Context budget and rolling handoff

A long slice runs out of context before it runs out of work. The failure mode is not the
`/clear` — it is arriving at the `/clear` with the reasoning still in the conversation and
nowhere else. So the handoff is **rolling**: written when the slice starts, refreshed as it
goes, and already correct when the budget runs out.

**The live handoff is `docs/audits/handoffs/HANDOFF-ACTIVE.md`**, written from
`HANDOFF-TEMPLATE.md` beside it and committed with the work. There is exactly one at a time,
and it is rewritten in place, never appended to. That folder doubles as the audit trail: a
finished handoff is renamed `HANDOFF-<issue>-<date>.md` and stays there.

**The loop is opt-in and off by default.** Arm it at the *start* of a long slice with
`/autohandoff on [note]`, disarm with `/autohandoff off`, inspect with `/autohandoff status`.
Disarmed, both hooks exit silently and a session behaves exactly as it did before. The arm
marker is a file (`.claude/state/guard-armed.json`), not session state - it has to survive the
`/clear` it exists to make safe - and it expires after 7 days so a forgotten marker cannot
guard unrelated work. Set `"mode": "always"` in `.claude/context-budget.json` to opt the whole
project in permanently.

**Two hooks drive it** (wired in `.claude/settings.json`, tuned in `.claude/context-budget.json`):

- `.claude/hooks/context_guard.py` — `PostToolUse`. Reads the real context usage (the
  percentage Claude Code publishes to the statusline, falling back to the token accounting in
  the session transcript) and at 50% / 70% / 85% injects a stop-and-hand-off instruction. It
  fires once per threshold per session, and ignores subagents — they have their own windows.
- `.claude/hooks/session_resume.py` — `SessionStart`. If `HANDOFF-ACTIVE.md` exists and is not
  marked `Status: consumed`, it injects the whole file into the new session and instructs it to
  resume immediately. This is what makes `/clear` continuous rather than amnesiac: the user
  pastes nothing and their first message can be a single word.

**At the 50% mark, stop taking on new work.** Finishing the red-green step in flight is fine;
starting another is not. Then run `/handoff`, commit, and print the ready line. The user runs
`/clear` and sends any message; the SessionStart hook does the rest.

Fill in **every** section of the template, and scroll back through the whole session first —
especially for corrections the user gave you, which belong under "Standing instructions from
the user", quoted. A user who has to repeat an instruction after every `/clear` is worse off
than before the loop existed.

**What belongs in the handoff** is what exists nowhere else: decisions and the alternatives
rejected, dead ends already tried, environment gotchas, the exact next action. Not the issue
file, the diff, or the commit log — reference those by path. The rule of thumb: everything you
wrote down survives, everything you did not is gone.

**When the slice completes**, rename the handoff to `HANDOFF-<issue>-<date>.md` in the same
folder and run `/autohandoff off`. A live handoff for finished work keeps re-seeding sessions.

To change the thresholds, edit `.claude/context-budget.json` (`"thresholds": [50, 70, 85]`,
`"mode"`: `manual` / `always` / `off`, `"enabled": false` as a hard kill switch,
`"contextLimit"` to pin the window size). Everything in `.claude/state/` is disposable.

## Fixtures against a server-evaluated CHECK constraint (#183)

**Fixtures for tables with a `CURRENT_TIMESTAMP` default must set that column explicitly whenever
another column in the same row is compared against it by a CHECK constraint.** Never derive one half
of a constrained pair from a frozen absolute date and leave the other to the database default — such
a row is valid on the day it is written and rejected forever afterwards. Faking timers does not help:
the default is evaluated by Postgres, not Node.

Precedent: `apps/backend/test/tier-override-expiry-sweep.e2e-spec.ts:38-40,55-57` pins `createdAt`
relative to its own frozen `NOW` for exactly this reason (`company_tier_overrides_expiry_window_chk`).
Three sibling specs missed this for a week (#183) — `beforeAll` silently started throwing the moment
the frozen `expiresAt` fell behind the live `created_at` default, and stayed broken until diagnosed.

## UI reference system

For any issue touching a dashboard, page, screen, form, table, drawer, queue, report, navigation, or
workflow UX, the reference images are **authoritative inputs** (authority order in
`docs/agents/domain.md`):

- Desktop: `docs/ui/desktop/v2-reference/` (authoritative). `docs/ui/desktop/v1-legacy/` is superseded.
- Mobile: `docs/ui/mobile/`.
- **Approved designs: `docs/ui/desktop/approved-designs/`** (added 2026-08-20, #272) — operator-approved
  directions for screens the v2 set never drew, authoritative for those screens. Self-contained `.html`
  files; open one in a browser. First entry: the Assign Work Console (`/assign`). A v2 image always
  wins where one exists; an approved design may only add screens, never contradict one.

**File names (corrected 2026-07-28, #172):** mobile reference files are plain **single `.png`** —
`home-dashboard.png`, `verification.png`, and eight others in `docs/ui/mobile/`. This paragraph
previously claimed a double `.png.png` extension, which was false and had propagated into the
`## Reference` line of **22 mobile issues**, making every one of them a dead path. Those have been
corrected. Reference and open images by their on-disk name; list the directory if unsure.

### UI discovery (before any UI implementation)

1. Identify the relevant reference image(s) — check `v2-reference/` first, then `approved-designs/`.
2. Analyze the image structure (layout, sections, hierarchy).
3. Map image sections to the issue's acceptance criteria.
4. Identify reusable components already in `apps/admin` / `apps/mobile`.
5. Produce an implementation plan.
6. Begin TDD.

When images exist, match layout, information hierarchy, page composition, role visibility, and
navigation behavior. **Do not redesign pages** unless explicitly instructed. If an image and the PRD
conflict, follow the PRD and document the discrepancy.

### UI regression (when modifying an existing page)

Preserve layout, navigation, role visibility, and terminology. No opportunistic redesigns —
feature implementation and redesign are separate activities.

### Parity gate (per-issue, not a phase switch)

An issue carrying in-scope UI or mobile acceptance criteria cannot be marked done with those ACs
deferred unless **both**: (a) a follow-up issue owning them is filed and linked in `INDEX.md`, and
(b) the blocker is a true external integration. "No app shell yet" is not a valid deferral reason —
it is a backlog-ownership Strategic HITL event. Record the disposition in the issue's progress doc.

This is a **per-issue gate, not a phase switch**: backend-led TDD continues unchanged. The gate only
prevents an implemented backend slice from shipping with its admin/mobile surface silently dropped.

## Repo hygiene / versioning policy

Decided 2026-07-10 (#115). **The whole `docs/` tree is versioned** — PRD, business workflow, audits,
architecture docs, ADRs, UI reference imagery, progress/handoff reports, and `SYSTEM-STATE-*.md` — so a
fresh clone can run the documented process and a disk failure does not lose the requirements/audit
record. Secrets stay out via the `.env` / `.env.*` rules only; **never** re-introduce a blanket
`docs/*` ignore. Ignore rules for artifact dirs (`/data/`, `/backups/`) and build caches
(`*.tsbuildinfo`, `dist/`) must be **anchored** so they cannot shadow a source path that happens to
share a name (the `data/` → `apps/admin/src/components/data/` incident, #114).
