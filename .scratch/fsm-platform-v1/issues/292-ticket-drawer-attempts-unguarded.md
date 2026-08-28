# 292 — `TicketDetailDrawer` reads `attempts.attempts` unguarded, throwing on every full admin run

Status: **ready-for-agent**
Type: Bug · Frontend · XS
Found: 2026-08-28, incidentally, during the Scheduler Console slice. **Not fallout from it** — neither
the file nor its test is touched by any Console phase.

---

## What happens

`apps/admin/test/ticket-drawer-tabs.test.tsx` produces **one unhandled rejection on every full admin
suite run**:

```
TypeError: Cannot read properties of undefined (reading 'length')
 ❯ TicketDetailDrawer src/pages/tickets/TicketDetailDrawer.tsx:440
     {attempts.attempts.length === 0 && (
```

It fails no test. The suite reports green and then prints `Errors 1 error` underneath, which vitest's
own banner warns "might cause false positive tests".

## Why it is worth an issue rather than a shrug

Two reasons, and the second is the one that matters:

1. `attempts` is reached into without a guard, so **any** shape the attempts read does not return —
   an older payload, a partial response, an error path that resolves rather than rejects — takes the
   whole drawer down rather than costing the operator one tab. The same defensive-read argument is
   already written down for the assign console's candidate column, whose docblock explains that an
   additive panel must fail *additively*.
2. A permanently-red line in the runner output is a line nobody reads. The next genuine unhandled
   rejection arrives into a run that already prints one, and is indistinguishable from it.

## Acceptance criteria

- [ ] AC1 — `TicketDetailDrawer.tsx:440` guards the read; an absent or malformed `attempts` payload
      costs the Attempts tab its content and nothing else, with an explicit "not loaded" state rather
      than a blank.
- [ ] AC2 — A test covers the absent-payload path, so the guard cannot be removed silently.
- [ ] AC3 — `npx vitest run` in `apps/admin` completes with **zero** unhandled errors — the point of
      the issue is the clean baseline, not only the guard.
