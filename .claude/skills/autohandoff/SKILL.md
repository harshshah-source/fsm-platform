---
name: autohandoff
description: Arm, disarm or inspect the context-budget auto-handoff loop for this repo. Use when the user wants long-running implementation work to survive a /clear, or wants to turn that behaviour off.
argument-hint: "on [note] | off | status"
---

The loop is **opt-in and off by default**. Run the switch and report its output:

```
python .claude/hooks/autohandoff.py on [note]   # arm, optionally labelled with the slice
python .claude/hooks/autohandoff.py off         # disarm
python .claude/hooks/autohandoff.py status      # armed? thresholds? handoff? current context %
```

With no argument, run `status`.

## What arming changes

Nothing about how you work — only what happens when the context window fills.

- **`PostToolUse`** (`.claude/hooks/context_guard.py`) — at 50 / 70 / 85% of the window it
  injects a stop-and-hand-off instruction. Follow it: land the tree, run the tests, run
  `/handoff`, commit, then print the ready line and stop.
- **`SessionStart`** (`.claude/hooks/session_resume.py`) — injects
  `docs/audits/handoffs/HANDOFF-ACTIVE.md` into the next session and tells it to resume
  immediately, so `/clear` continues the slice instead of restarting it. The user pastes
  nothing; their first message can be a single word.

Disarmed, both hooks exit silently and sessions behave exactly as they did before.

## Two modes at the threshold

`atThreshold` in `.claude/context-budget.json` decides what happens when the guard fires. No
hook can run `/clear` or send a message - those are user-only - so the choice is really
"stop and be restarted cleanly" versus "never stop".

- **`stop`** (default) - write the handoff, commit, print the ready line, stop. The user types
  `/clear` and one word. Two keystrokes, and the next session starts on a genuinely clean
  window, which is the best context the work will ever get.
- **`continue`** - write the handoff, commit, and carry straight on. Claude Code's own
  auto-compact reclaims the window when it needs to, and the `SessionStart` hook re-injects
  the handoff afterwards. Zero keystrokes, but the session then carries a compaction summary
  rather than a clean slate, and compaction can land mid-edit rather than at a chosen point.

In `continue` mode the handoff matters more, not less: compaction summarises and drifts, and
the file on disk is the only thing that does not.

## Notes worth passing on to the user

The arm marker is a file (`.claude/state/guard-armed.json`), not session state — it has to
survive the `/clear` it exists to make safe. So it stays armed until turned off, and expires on
its own after 7 days so a forgotten marker cannot guard unrelated work weeks later.

Arm at the **start** of a long slice, not when the window is already full: the point is that
the handoff is maintained as the work happens, and a handoff composed at 85% is reconstructed
from memory rather than from notes.

When the slice finishes, disarm and rename the handoff to `HANDOFF-<issue>-<date>.md` in the
same folder — a live handoff plus an armed guard will keep seeding new sessions.

`mode` in `.claude/context-budget.json` overrides the switch: `always` opts the whole project
in permanently, `off` disables it outright, `manual` (the default) honours the arm marker.
