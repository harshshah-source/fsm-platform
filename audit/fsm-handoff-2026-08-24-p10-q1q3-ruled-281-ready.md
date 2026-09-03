# Handoff — #280 Q1–Q3 ruled (R8–R10), #281 flipped to `ready-for-agent`, docs committed (`9ee738f`)

**Date:** 2026-08-24 · **Branch:** `feat/autoplant-integration` @ `9ee738f`, **44 ahead of `origin`, not pushed**
**Working tree:** 134 uncommitted files remain — same unrelated in-flight workstreams as before (see §3).

This session's job was narrow and is finished: resolve #280's three open product questions (Q1–Q3),
record the rulings, and bring #281 to `ready-for-agent`. **No application code was touched.** The next
session's job — per this handoff's own trigger — is to actually build #281.

**Read `audit/fsm-handoff-2026-08-24-p9-committed-p10-filed.md` first if you haven't** — it's the
previous handoff and covers P9's completion + why P10 exists. This document only covers what changed
since then.

---

## 1. What happened this session

The operator asked for #280's three open questions (Q1–Q3) to be resolved through a structured
process, not decided silently: for each, show the current screens/routes, summarize what the two
2026-08-19 audits establish, state the UX trade-offs, recommend an option with reasoning, and present
it for explicit approve/reject. All three were researched against the live working tree (not assumed
from the issue text), presented, and **approved by the operator as proposed**.

**The rulings (now in `#280` as R8–R10 — read the issue file, not this summary, for the full reasoning
and code citations):**

- **R8 (Q1 — cross-view control):** contextual, per-record links between Preview/Schedules/Dispatch
  Runs/Intra-day — **not** a shared date-anchored switcher and **not** a tab strip. Verified only
  Scheduler Preview is single-date scoped; Schedules and Dispatch Runs are unfiltered lists/ledgers, so
  a switcher would mean restructuring two pages' data shape (out of scope per R6). A tab strip was
  rejected as visually asserting the three views are interchangeable — the exact confusion R2 forbids.
- **R9 (Q2 — does Intra-day join the cluster):** yes, but presented as **subordinate to Schedules**
  ("changes to today's plan"), not a flat fourth peer beside future/present/past.
- **R10 (Q3 — where the `Run → Zone → Batch` chain terminates):** **both** the SE day plan
  (`/schedules/:engineerId`, primary) **and** the ticket detail drawer (per ticket) — plus `plantName`
  linked too, which was flagged to the operator as an expansion beyond Q3's original three listed
  options (R4's own text names engineer/plant/tickets together) and approved.

Only **#280 Q4** (whether to commit the two source audits, `navigation-ia-audit-2026-08-19.md` /
`frontend-ux-audit-2026-08-19.md`) remains open, and it does **not** block #281 — it's a separate,
still-untracked-files question.

**#281 was then updated in a second, separate operator instruction:** status flipped from
`needs-triage` to `ready-for-agent`; the stale "blocked on Q1–Q3" language removed; all 14 acceptance
criteria individually re-verified against R8–R10, with wording changed only where the new rulings had
left ambiguity (AC1/AC2, AC3, AC6/AC7, AC8 — see the issue file's own diff/content for exact wording;
AC4/AC5/AC9–AC14 needed no change). **Implementation was explicitly not started** — this was bookkeeping
only, and the issue file itself says so.

**Both were committed** as `9ee738f` — but selectively: the working tree had ~135 unrelated uncommitted
files (P8/P9 completion bookkeeping, MUI/theme work, #264/#267/#270 remainders, etc. — see the previous
handoff's §3 table). Committing `INDEX.md` whole would have pulled in P8/P9 status bookkeeping that
has nothing to do with #280/#281. **The commit was built by hand-constructing an isolated blob** (HEAD
content + only the P10 section + only the two new session-log lines, via `git hash-object -w` +
`git update-index --cacheinfo`, verified diff-clean before committing) so only the #280/#281-relevant
hunks landed. The rest of `INDEX.md`'s pending edits are still uncommitted in the working tree, exactly
as before. Do not assume `git add -A` is ever safe in this tree — see the previous handoff's warning,
still true.

## 2. Where things stand — the three source-of-truth files

Read these directly; this handoff does not restate their content:

- **[`#280`](../.scratch/fsm-platform-v1/issues/280-decision-dispatch-timeline-ia.md)** — decision
  record, R1–R10 all ruled, only Q4 (commit the audits) open and non-blocking.
- **[`#281`](../.scratch/fsm-platform-v1/issues/281-dispatch-timeline-navigation.md)** — implementation
  issue, `Status: ready-for-agent`, 14 ACs, all reconciled against R8–R10. This is the issue the next
  session builds.
- **[`INDEX.md` P10 section](../.scratch/fsm-platform-v1/INDEX.md)** — search for `## P10`. Table + one
  paragraph of framing; the session log's last two entries (search `#281 flipped` and `#280 Q1–Q3
  ruled`) carry the full narrative of this session, more detail than this handoff repeats.

## 3. The working tree — still ~134 files, still not yours to bulk-add

Unchanged from the previous handoff's §3 table except two files moved from untracked → committed
(`280-*.md`, `281-*.md`) and `INDEX.md`'s tracked diff shrank by the P10-related hunks. Everything else
is exactly as it was: MUI/theme work, #264/#267/#270/#267 UI remainders, #239 acting-scope
infrastructure, test-harness diagnostics, and **the root `package.json` regression is still present and
still not committed** (accidental `@mui/material`/`@emotion/*` `dependencies` block that belongs only in
`apps/admin/package.json` — see previous handoff §3 for detail). None of this is #281's concern; don't
let it bleed into the next commit either. `git status --porcelain -- <exact files you touch>` before
every commit, the same discipline this session used.

## 4. What the next session is actually for

**Build #281** — make the dispatch timeline (Preview / Schedules / Dispatch Runs / Intra-day Queue)
navigable as one concept, per its 14 ACs and R8–R10. The issue file is the spec; do not re-derive it
here. Two things worth flagging before you start:

- **No approved design is needed** (R8's own conclusion) — the mechanism is contextual per-record
  links added to each page's existing furniture, not a new layout. Don't reach for `/design` or the
  artifact-design skills unless something changes that.
- **AC3 is the one a passing test suite won't catch.** An implementation that unifies the four views too
  eagerly — makes a link *feel* like a tab, or blurs which view you're on — teaches the operator that a
  preview is a commitment. Read #280 R2/R3 before writing the first line, not after.
- **This repo's HITL culture has been very deliberate about the line between "ready-for-agent" and
  "authorized to start building."** The operator has drawn that line explicitly, twice, earlier in this
  work (see #280/#281's own text). This handoff's own trigger — "so next session can start proper
  implementation" — reads as that authorization, but if anything in the operator's first message of the
  next session suggests otherwise, don't assume; ask.

## 5. Environment — deltas only

Nothing changed in the environment this session (no code run, no server started, no tests run — this
was a documentation-only session). See the previous handoff's §6 for the standing facts: the stale-`dist`
trap, how to drive the app with Playwright, seeded dev logins, and the full-suite-kills-the-dev-backend
gotcha. All still true, unverified-but-unchanged this session.

## 6. Suggested skills for the next session

- **`/tdd`** — the primary tool for building #281. Red-green-refactor per AC; the issue's own "Tests"
  section names the specific test files/cases expected (breadcrumb regression, Scheduler Preview render
  test, catch-all route test, batch→day-plan/ticket/plant navigation test, cross-view link test, nav
  visibility per role).
- **`/field-ops-director`** — before or immediately after implementing, per the previous handoff's own
  suggestion (still valid, never used): the AC3 risk (teaching an operator a preview is a plan) is a
  domain-reality failure a code review won't catch, but a field-ops persona review will.
- **`/code-review`** — once #281 is implemented, `--since 9ee738f` (or `6ceaea5` if you want P9+P10
  together) before it's pushed.
- **`/grilling`** — optional, if you want to stress-test the *implementation approach* for R8's
  contextual-links mechanism before committing to a specific link placement/copy pattern on each page.
- Do **not** reach for `/design` or the artifact-design skills — R8 already settled that no new layout
  is needed (§4 above).

## 7. Do not

- Do not re-litigate Q1–Q3 — they're ruled (R8–R10), approved by the operator, and committed.
- Do not `git add -A`. Stage only what you touch, and verify with `git status --porcelain -- <paths>`
  before committing, the same way this session isolated the P10 hunks from unrelated pending work.
- Do not push (`44` commits ahead of `origin`, still nothing pushed all session).
- Do not touch `/assign` or anything in P9 (`6ceaea5`) — #280 R7 / #281 AC13 rule it untouched.
- Do not invent a new layout for the four dispatch views — R8 rules that out.
- Do not assume #280 Q4 (commit the two audits) needs resolving before #281 can start — it's explicitly
  non-blocking.
