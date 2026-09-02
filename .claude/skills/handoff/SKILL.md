---
name: handoff
description: Write or refresh the rolling handoff for the slice in flight, so a fresh session can continue it after /clear. Invoke when the context-budget hook fires, when stopping work mid-slice, or when the user asks for a handoff.
argument-hint: "[what the next session should focus on]"
---

Write the handoff to **`docs/audits/handoffs/HANDOFF-ACTIVE.md`** — in the repo, committed.
Never to a temp directory: a handoff the next session cannot find is the same as no handoff.
The `SessionStart` hook injects this exact file into every new session, which is what makes
`/clear` safe mid-slice.

## Steps

1. **Land the tree first.** Finish or revert the in-flight edit. Run the tests covering what
   you touched and record the result verbatim — a red test is handoff content, not a blocker.
2. **Rewrite `HANDOFF-ACTIVE.md` from scratch** using `HANDOFF-TEMPLATE.md` beside it, filling
   in every section. Rewrite, do not append: a handoff that accumulates history stops being
   readable, and only the current state matters.
3. **Commit everything**, including the handoff. A WIP commit is correct here.
4. **Update `.scratch/fsm-platform-v1/INDEX.md`** — the status of every issue touched, plus one
   line in the Session log table (date · what landed · commit hashes).
5. Print exactly `HANDOFF READY - run /clear, then send any message (e.g. go)` and stop. Do
   not keep implementing after that line. The user pastes nothing — the `SessionStart` hook
   loads the file into the next session — which only works if it is complete.

## What goes in it

The test is: **would the next session be wrong without this?** Decisions and their rejected
alternatives, dead ends, environment gotchas, the exact next action. Those are the things that
exist nowhere but this conversation.

Scroll back through the whole session before writing — in particular for **corrections and
constraints the user gave you**, and put them under "Standing instructions from the user".
A user who has to repeat an instruction after every `/clear` is worse off than before the
handoff existed. Quote them; do not soften them into generalities.

Do not restate what the repo already holds — the issue file, the diff, the commit messages,
`docs/SYSTEM-STATE-2026-07.md`, the PRD. Reference them by path. Redact any secrets.

If the user passed arguments, treat them as the next session's focus and tailor the
"Next step" section to them.

## Arming

Writing a handoff by hand does not arm the 50% guard — that is `/autohandoff on`. If the user
is writing a handoff because the work is going to span sessions, arm it in the same breath, and
say so. If they just want a snapshot, leave the guard alone.

## When the slice is finished

Do not delete the handoff — rename it to `HANDOFF-<issue>-<date>.md` in the same folder, which
stops it seeding new sessions and leaves it as the audit trail. Then run `/autohandoff off`. If
you must leave the name alone, set `Status: consumed` in its header; the hook skips it.
