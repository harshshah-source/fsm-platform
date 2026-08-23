# 271 — SLA resume at the real lifecycle boundaries: fold-and-resume on submission, terminal at verification

**Status:** DONE · 2026-08-24 · branch `feat/autoplant-integration`
**Issue:** `.scratch/fsm-platform-v1/issues/271-sla-resume-outcome-boundary.md` · **Decision:** #258 Q7
(supersedes #247 AC2's "the sweep is the single automatic resumer"; #253's stranded-pause scenario is
now dead by construction)
**Suite at completion:** backend **410 files / 2053 passed / 5 skipped / 0 failed** (four foreground
chunks, all exit 0). No admin/mobile surface — this issue has none.

---

## 1. What was wrong

The SLA fold-and-resume math existed in three independent, near-identical spellings
(`vehicle-return-resume.service.ts`, `component-request.service.ts`, `vehicle-unavailability.service.ts`),
none of them race-safe (read-then-write under READ COMMITTED), and none of them reachable from the one
place that actually ends a `VEHICLE_UNAVAILABLE` pause first: **submission**. `submit()` resolved the
OPEN vehicle report as a side effect of ending the SE's absence but explicitly declined to resume the
clock — "pause-reason-aware resumption is #247's slice" — leaving that to the nightly sweep, which
selects `status: 'OPEN'` reports only. Submission had just flipped the report to `RESOLVED`, so the
sweep could never see it: a submission before the vehicle's authoritative return date stranded the
pause forever (#253). Worse, the component-unavailable submission branch overwrote the pause columns
to open `WAITING_COMPONENT` **without folding the standing VU interval first** — those seconds simply
vanished from `sla_accumulated_pause_seconds`, an accounting bug this review found rather than one the
original issue draft knew to ask for.

## 2. What was built

One helper, four callers.

```
src/ticketing/sla-pause.ts
  foldAndResumeSlaPause(tx, cycleId, now, { onlyReason? })
    read → guard (paused? right reason?) → transitionOrConflict-guarded updateMany → fold or no-op
```

| Caller | Mode | Change |
|---|---|---|
| `troubleshoot-submission.service.ts` | `onlyReason: VEHICLE_UNAVAILABLE` | **New.** Folds right after the report resolve, BEFORE the `componentUnavailable` branch |
| `verification.service.ts` `finalize()` | unguarded (any reason) | **New.** Defensive clear inside the CLOSED branch, before `state: 'VERIFIED'` |
| `vehicle-return-resume.service.ts` (sweep) | `onlyReason: VEHICLE_UNAVAILABLE` | Rewired — pre-filter kept as a cheap candidate list, the actual fold+write now goes through the guarded helper (race-safety it didn't have before) |
| `vehicle-unavailability.service.ts` `resumeSla` (manual ZM path) | `onlyReason: VEHICLE_UNAVAILABLE` | Rewired, same behaviour |
| `component-request.service.ts` `resumeSla` (WM receipt/resubmit) | unguarded | Rewired, same behaviour |

Placement follows the real lifecycle, not the original draft's guess: `VERIFICATION_PENDING` is
**not** terminal, so submission is where an ended VU pause has somewhere to resume running — Q7 Case 2.
Verification (CLOSED or FAILED_VERIFICATION) is where the ticket goes terminal, so there is nothing
left to restart — Q7 Case 1 — and the only code added there is a defensive backstop, not a resume.

## 3. Decisions worth keeping

**Race safety came from switching the write, not from adding a lock.** Every existing writer was
`find → check in JS → update`, exactly the idiom this repo's own `transition-or-conflict.ts` docstring
names as the bug class (`intraday-insertion.service.ts`'s Accept/Reroute race is the same shape). The
helper reads once, then issues a `transitionOrConflict`-guarded `updateMany` keyed on the exact
`(slaPaused: true, slaPausedAt: <value just read>[, slaPauseReason: onlyReason])` triple. A concurrent
resume of the SAME pause can win at most once: the loser's guard matches zero rows, it reports
`{resumed: false, addedSeconds: 0}`, and folds nothing. Pinned directly (`sla-pause.e2e-spec.ts`, AC-7)
over **two real connection pools** racing the same cycle — the closest a single test file gets to two
processes, following the pattern `#259`/`#263` established for exactly this kind of claim.

**`onlyReason` generalizes #247's asymmetry fix instead of re-deriving it per caller.** The three VU
writers pass `VEHICLE_UNAVAILABLE` — the guard that stops a vehicle-side resume from silently clearing
a `WAITING_COMPONENT` pause it does not own. The two callers that omit it do so for opposite reasons:
`component-request.service.ts`'s resume fires only where its own lifecycle already guarantees the
standing pause is the `WAITING_COMPONENT` one it opened (unconditional is correct there, not an
oversight); the verification backstop is deliberately generic — a defensive clear that only handled
one reason would still let the other leak into closed-work accounting.

**The submission fold runs BEFORE the `componentUnavailable` branch, unconditionally.** This is what
makes AC-2 "fold before re-pausing" true by construction rather than by a second special case: the same
one call handles both the normal path (nothing left to re-pause) and the component-unavailable path
(the VU interval is already safely in the running total by the time `WAITING_COMPONENT` opens).

**Verification's ordinary-path tests (AC-3, AC-4) needed zero changes to `verification.service.ts` to
pass.** Written and run against the codebase BEFORE the defensive backstop was added, both went green
immediately — proof that the boundary placement is correct: by the time a ticket reaches
`VERIFICATION_PENDING`, submission has already done the only SLA work there is to do. Only the
deliberately-synthetic defensive-backstop test (a cycle manually re-paused after submission, a state
the ordinary flow cannot produce) required the new code in `finalize()`.

**The nightly sweep is not weakened, it is narrowed to the one case that's actually its own.** Its
`status: 'OPEN'` selection, which the original issue draft called a trap, is now simply correct: a
submission resolves its own report (and folds the pause) before the sweep would ever see it, so the
sweep's remaining job — "the vehicle is due back and nobody has submitted anything" — is exactly what
its selection already expressed. Regression-pinned unchanged in `vu-auto-resume-sweep.e2e-spec.ts`
(6/6 green, no edits).

## 4. A correction to the issue text

**"Verification failure → ticket `ESCALATED`" (AC-4) does not match the code.** `runVerification`'s
automatic failure path — both the 24h-timeout branch and the fraud branch — sets `ticket.status =
'FAILED_VERIFICATION'` (`verification.service.ts:309`, pinned by the pre-existing
`verification-run.e2e-spec.ts`), which is itself a **terminal** status
(`RESOLVED_TICKET_STATUSES`/`resolved-ticket-status.ts`, and explicitly documented so at
`verification.service.ts:180` — *"ages into an IRREVERSIBLE FAILED_VERIFICATION"*). `ESCALATED` is
reachable only via the separate, human-invoked `escalateFraud()` action on a fraud-flagged run — never
automatically. AC-4 is tested here against the real automatic outcome (`FAILED_VERIFICATION`); the
substance of the criterion — no second fold, the clock keeps running from the submission resume — holds
regardless of which terminal status name is involved, since by that point nothing is paused for either
path to touch.

## 5. Tests

| File | What it pins |
|---|---|
| `test/sla-pause.e2e-spec.ts` (7, new) | The helper directly against a bare cycle: no-op, exact-interval fold, additive (not overwriting) accumulation, `onlyReason` guard both ways, unguarded mode, **AC-7** two-pool race |
| `test/troubleshoot-submission.e2e-spec.ts` (+4) | **AC-1** normal-path fold · **AC-2** component-unavailable fold-before-repause, interval preserved · **AC-6** a WAITING_COMPONENT pause survives a resubmission fold · no-op on an unpaused ticket |
| `test/verification-run.e2e-spec.ts` (+3) | **AC-3** one fold total (submission), none at CLOSED · **AC-4** FAILED_VERIFICATION path — clock keeps running, no second fold · defensive backstop against a synthetically re-paused cycle |
| `test/vu-auto-resume-sweep.e2e-spec.ts` (6, unchanged) | **AC-5** regression — the sweep's own behaviour, byte-for-byte pinned before touching it |
| `test/vu-sla-resume-correctness.e2e-spec.ts` (2, unchanged) | **AC-6** regression — the manual ZM path's reason-guard |
| `test/component-request-receipt.e2e-spec.ts` (4, unchanged) | Regression on the WM receipt/resubmit resume |

17 files / 85 tests in the targeted run, all green; full suite 410/2053/0 failed.

## 6. Files

**New:** `src/ticketing/sla-pause.ts` · `test/sla-pause.e2e-spec.ts`.

**Modified:** `troubleshoot-submission.service.ts` (new fold call + comment rewrite),
`verification.service.ts` (defensive backstop), `vehicle-return-resume.service.ts` (rewired through the
helper, kept the pre-filter), `vehicle-unavailability.service.ts` (rewired), `component-request.service.ts`
(rewired) · `test/troubleshoot-submission.e2e-spec.ts`, `test/verification-run.e2e-spec.ts` (new cases
+ afterAll cleanup for the new `vehicleUnavailabilityReport`/`componentRequest`/`failure_cycles`-audit
rows) · `CONTEXT.md` (Decisions §20 + a precision fix to the Vehicle Unavailability Report glossary
entry's resume list) · `docs/SYSTEM-STATE-2026-07.md` §3i.

**Rollback:** revert the four call sites to their pre-#271 inline logic (each is a small, self-contained
diff); `sla-pause.ts` and its test go inert. No schema change, no migration to revert.
