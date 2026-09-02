# Rolling handoff template

Copy this into `docs/audits/handoffs/HANDOFF-ACTIVE.md` when a slice starts, and rewrite it in
place as the work goes. The `SessionStart` hook injects `HANDOFF-ACTIVE.md` verbatim into every
new session while the auto-handoff loop is armed, so it is the **only** thing that survives a
`/clear`.

Write it for a reader who has never seen this conversation and cannot ask you a question. Two
rules decide what belongs:

1. **Would the next session be wrong without it?** If yes, write it down.
2. **Is it already in the repo?** If yes, link the path instead of restating it — the issue
   file, the diff, the commits and `docs/SYSTEM-STATE-2026-07.md` do not need summarising.

Completeness beats brevity here, but padding is worse than either: a handoff full of restated
repo content buries the three lines that actually matter. Delete this preamble in the real
file. Aim for 100-300 lines.

---

# HANDOFF — #<issue> <short slug> — <YYYY-MM-DD>

Status: active
Issue: `.scratch/fsm-platform-v1/issues/<file>.md`
Branch: `<branch>` · base: `<commit the slice started from>`

## The job

<One short paragraph: what this slice is trying to achieve and why, in plain terms. A fresh
session needs the goal before it needs the details — without it, every judgement call below
is unanchored.>

## Next step

<The single next action, concrete enough to start on without a decision. Name the file and the
function. If a test is red, quote the failing assertion. This is the first thing the next
session reads and the first thing it does.>

## Standing instructions from the user

<Every correction, constraint and preference the user gave during the session that is not
already written into an issue or a doc — "don't touch the migration", "use the v2 reference for
the header, not approved-designs", "stop asking, just build it". These are invisible to the
next session unless they are here, and re-litigating a decision the user already made is the
most annoying way to waste their time. Quote them; do not paraphrase into something vaguer.
If none: "none this session.">

## State of the tree

- Committed: `<hash> <subject>`, `<hash> <subject>` — nothing else is in git.
- Uncommitted: <files, or "none">
- Tests: `<exact command>` → <pass/fail, with the failing assertion quoted>
- Typecheck: `<exact command>` → <result>
- Anything half-done or deliberately stubbed: <what, and where the TODO is>

## Done so far

<Bullets tied to commit hashes. One line each — the diff holds the detail.>

## Decisions taken (not recoverable from the diff)

<Why the shape is what it is, and the alternative that was rejected, with the reason. Anything
a reviewer would otherwise ask "why didn't you just…" about.>

## Dead ends — do not retry

<What was tried and failed, and why. This is the highest-value section in the file: it is the
part that costs a fresh session the most to rediscover, and the part it will cheerfully
rediscover twice if you leave it out.>

## Gotchas

<Environment quirks, fixture ordering, a CHECK constraint that only fails server-side, a
migration that must run first. Anything that cost time once and will cost it again.>

## Remaining acceptance criteria

<From the issue, the ACs still unmet — including UI/mobile ones. The parity gate in CLAUDE.md
applies: unbuilt in-scope UI needs a filed follow-up issue, not silence.>

## Open questions / HITL

<Strategic HITL events only (see docs/agents/workflow.md). If none: "none — keep going.">

## Suggested skills

<e.g. `/tdd` for the next red-green step, `/code-review` before marking done.>
