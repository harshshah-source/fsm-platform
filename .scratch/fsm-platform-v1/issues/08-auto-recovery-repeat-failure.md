# 08 — Auto-recovery + repeat-failure detection

Status: done
Type: AFK
Progress: DONE (2026-06-21) — strict TDD slices 1–5. Backend 50 files / 167 tests, tsc clean.
Decisions: (a) repeat detection is event-driven at cycle creation; escalation is a daily scan
(`RepeatEscalationService.runEscalationScan`, no cron — scheduling deferred like Issue 04). (b) I1
partial-unique widened to cover REPEAT + ESCALATED (both are active episodes; DB is the final guard
behind `has_open_failure_cycle`). PARTIAL_RECOVERY/FRAUD badges remain Issue 18/19.
See docs/progress/08-auto-recovery-repeat-failure.md.

## What to build

Self-healing and recurrence detection on the failure-cycle layer. When an inactive device resumes pinging without SE intervention, the open Ticket closes as `CLOSED_AUTO_RECOVERY` (no form required) and is kept distinct from SE-repaired closures so SE productivity metrics aren't inflated. ZM can also mark a recovery Ticket `CLOSED_AUTO_RECOVERY` manually when appropriate. Repeat-failure detection flags a new Failure Cycle on a device that has prior cycles, with a link back to the previous cycle; ESCALATED tickets flagged distinctly. A repeat-failure cycle starts a new immutable cycle (VERIFIED cycles are immutable).

End-to-end: a device that resumes pinging auto-closes its Ticket as `CLOSED_AUTO_RECOVERY`; a device that fails again gets a REPEAT FAILURE-flagged ticket linking to its prior cycle.

## Acceptance criteria

- [x] Device resuming pings auto-closes its open Ticket as `CLOSED_AUTO_RECOVERY` without a form
- [x] Auto-recovery closures are separable from SE-repaired closures in queries/reports
- [x] ZM can manually mark `CLOSED_AUTO_RECOVERY`
- [x] Repeat-failure detection flags new cycles on devices with prior cycles, linking the previous cycle
- [x] ESCALATED tickets flagged distinctly
- [x] VERIFIED failure cycles are immutable; a repeat failure opens a new cycle

## Blocked by

- #05
