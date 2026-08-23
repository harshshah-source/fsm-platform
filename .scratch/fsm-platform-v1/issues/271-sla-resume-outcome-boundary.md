# 271 — SLA resume at the real lifecycle boundaries: fold-and-resume on submission, terminal at verification

Status: done (2026-08-24) — see `docs/progress/271-sla-resume-outcome-boundary.md`
Type: AFK · Backend
Decision: #258 Q7 — supersedes #247 AC2's "the sweep is the single automatic resumer" invariant.
Supersedes #253 (the stranded-pause defect is AC-1 here).
**Corrected 2026-08-20 by the pre-implementation review** — the first draft placed the branch at the
submission boundary on the belief that submission knows the ticket outcome. It does not; see below.

## Objective

No active ticket is ever left permanently SLA-paused after its vehicle-unavailability condition has
ended, no completed ticket ever has an SLA clock restarted, and no pause interval is ever lost from
the accounting.

## Current behaviour — the actual lifecycle, verified in code

The outcome is **not known at submission**. There are three distinct boundaries:

1. **Submission** (`troubleshoot-submission.service.ts`):
   - resolves the OPEN VU report (`:167-175`) — the vehicle absence has demonstrably ended, someone
     worked the vehicle;
   - **normal path** (`:232-239`): ticket → `VERIFICATION_PENDING`, cycle → `SUBMITTED`. **The
     ticket is still ACTIVE, not terminal.**
   - **component-unavailable path** (`:186-193`): ticket stays OPEN, cycle → `WAITING_COMPONENT`,
     and it writes `slaPaused: true, slaPausedAt: now, slaPauseReason: 'WAITING_COMPONENT'`
     **without folding any pause already running** — so an active VU pause is silently overwritten
     and its elapsed seconds never reach `slaAccumulatedPauseSeconds`. **A pre-existing accounting
     bug, found by this review, owned here.**
   - the in-code comment at `:163-166` still states the SLA is deliberately not resumed — that was
     #247 AC2, now superseded.
2. **Verification** (`verification.service.ts`) is where the ticket becomes terminal: success →
   terminal ticket status + cycle `VERIFIED` + `closedAt` (`:134-136`, `:310-312`); failure →
   `ESCALATED` (`:89`) and the ticket stays active.
3. **The 03:30 sweep** (`vehicle-return-resume.service.ts:68-72`) selects **OPEN reports only** —
   hence #253: an early submission resolves the report, the sweep can never see it, and the pause is
   stranded forever.

**Damage, stated correctly (review correction).** Every reader of `sla_paused` is a reporting or
display consumer — the WAITING_COMPONENT dashboard panel (`dashboard.service.ts:921-922`),
`ticket-query.service.ts:177`, the component-receipt resume, and the sweep itself. Dispatch urgency
comes from `device_states.sla_bucket`, **not** this flag. So a stranded pause corrupts pause/downtime
accounting and SLA reporting; it does **not** suppress the dispatch urgency bucket. Do not describe
it as the latter.

## Required change

Place each half at the boundary that actually owns it:

1. **At submission — fold and resume, because the ticket is still active.** The VU condition has
   ended and `VERIFICATION_PENDING` is not terminal, so Q7 Case 2 applies: fold the running VU pause
   into `slaAccumulatedPauseSeconds` (fold-once) and clear `slaPaused`/`slaPausedAt`, audited with a
   `resumedBy: 'SUBMISSION'` discriminator so the ledger distinguishes this writer from the sweep.
2. **At submission, component-unavailable path — fold BEFORE re-pausing.** Any running VU pause is
   folded first; only then is the `WAITING_COMPONENT` pause opened. The ticket ends this path paused
   for a *different, correctly-attributed* reason with no interval lost.
3. **At verification — terminal, and therefore nothing to restart.** Success closes the cycle; the
   clock stops because the cycle is terminal, not because anything restarts it (Q7 Case 1 satisfied
   exactly). Add terminal bookkeeping only: a cycle reaching `VERIFIED` must not carry
   `sla_paused = true` — fold and clear if it somehow does, so downtime maths cannot inherit a live
   pause on closed work. Verification **failure** (`ESCALATED`) needs no SLA action at all: the
   clock has been running since step 1.
4. **Reason-guard preserved**: a `WAITING_COMPONENT` pause is never resumed by the VU logic (the
   #247 sweep's reason check, now living in the shared helper).
5. **One fold implementation, not a fourth.** The fold-once + reason-check logic currently exists in
   three spellings (`vehicle-return-resume.service.ts:79-89`, `component-request.service.ts:316-323`,
   and the VU resolve path `vehicle-unavailability.service.ts:447`). Extract ONE helper
   (`ticketing/sla-pause.ts` or equivalent) and route all writers — old and new — through it.
6. **The 03:30 sweep is unchanged** and its OPEN-only selection becomes correct rather than a trap,
   because the submission path now owns the early-submission case.
7. Record the re-ruling: #247 gains a status note (already applied), and `CONTEXT.md` gets the Q7
   line with #258's recording.

## Existing code to reuse

The sweep's fold-once maths and reason check (extracted per item 5); `transitionOrConflict` for the
guarded report/cycle flips; the audit spine and the `VU_SLA_AUTO_RESUMED` action family.

## Data model

None expected — existing `slaPaused`, `slaPausedAt`, `slaPauseReason`, `slaAccumulatedPauseSeconds`,
report status. **If the implementation finds that "the ticket is still active" cannot be determined
at the submission site, STOP and surface it** rather than inventing a rule (#258's standing rule).
Note the reviewed reading: `VERIFICATION_PENDING` is unambiguously non-terminal, so this is expected
to be a non-issue.

## API / UI surfaces

None / n/a — state-machine correctness; existing surfaces read the corrected flags.

## Acceptance criteria

- [x] **AC-1 (#253's scenario, dead)**: submission *before* the return date, normal path → report
      RESOLVED, VU pause folded exactly once, `sla_paused = false`, ticket continues under SLA.
- [x] **AC-2**: same submission but component-unavailable → VU interval folded first, THEN the
      `WAITING_COMPONENT` pause opens; `slaAccumulatedPauseSeconds` contains the VU interval and
      `slaPauseReason = 'WAITING_COMPONENT'` (the overwrite bug pinned dead).
- [x] **AC-3**: verification success → cycle `VERIFIED` with `closedAt`, `sla_paused = false`, and
      **no resume/restart event of any kind** recorded after closure.
- [x] **AC-4**: verification failure → ~~ticket `ESCALATED`~~ **corrected: ticket `FAILED_VERIFICATION`**
      (the automatic sweep's own terminal status — `ESCALATED` is reached only via the separate manual
      `escalateFraud()`, never automatically; see the completion report §4), clock still running from
      the submission resume, no second fold.
- [x] **AC-5**: vehicle returns with no submission → the 03:30 sweep resumes exactly as today
      (regression pin on #247's specs).
- [x] **AC-6**: a `WAITING_COMPONENT` pause is never touched by any VU path (reason-guard pin).
- [x] **AC-7**: exactly one fold per pause regardless of writer interleaving — submission racing the
      sweep resolves through the guarded flip; the loser is a no-op and adds no seconds.

## Tests

e2e: extend `vehicle-return-resume` and troubleshoot-submission specs with AC-1..AC-5; verification
spec for AC-3/AC-4; unit tests for the extracted fold helper incl. the interleaving case.

## Dependencies / Blocked by

None. Fully independent of the concurrency track — can start immediately.

## Risks

The interleaving fold (AC-7) is the subtle maths; the three-writers-into-one-helper extraction is
the safety mechanism and should land before the new writers. Every touched writer is on the SE's
critical submission path, so regression coverage on submission specs matters more than usual.

## Rollback

Code-only; no schema change.
