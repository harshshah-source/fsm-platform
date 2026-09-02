---
name: implement
description: "Implement a piece of work based on a PRD or set of issues."
disable-model-invocation: true
---

Implement the work described by the user in the PRD or issues.

Use /tdd where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

**For a slice that will outlast one context window, arm the auto-handoff loop first** —
`/autohandoff on <issue>` — and disarm it when the slice lands. It is off by default; ask the
user before arming if it is not obvious the work is that long.

**Keep the rolling handoff current.** At the start of the slice, write
`docs/audits/handoffs/HANDOFF-ACTIVE.md` from `HANDOFF-TEMPLATE.md` beside it; refresh it after
every green test run — at minimum its "Next step", "State of the tree" and "Dead ends"
sections. It costs seconds and it
is the only thing that survives a `/clear`. When the context-budget hook fires, follow it: run
`/handoff` and stop. See "Context budget and rolling handoff" in `docs/agents/workflow.md`.

Once done, use /code-review to review the work, rename the handoff to
`HANDOFF-<issue>-<date>.md`, and run `/autohandoff off`.

Commit your work to the current branch.
