# 253 — A submission before the return date strands the primary SLA paused forever

Status: ready-for-agent
Type: AFK · Backend

Filed 2026-08-19 as a #247 follow-up (found while building it; deliberately **not** folded in, because
#247 AC2 pins its sweep as the single automatic resumer and widening that is a decision, not a detail).

## The gap

`troubleshoot-submission.service.ts:167` resolves any OPEN vehicle-unavailability report when the SE
submits (#245 AC5) and — by an explicit, correct decision at the time — does **not** resume the SLA:

> "The paused SLA is deliberately NOT resumed here — pause-reason-aware resumption is #247's slice,
> and guessing at it from this writer would resume clocks paused for a different reason entirely."

#247 has now built that reason-aware resumption, and the comment points straight at what is left. The
sequence that strands a cycle:

1. SE files a vehicle report on the 25th, vehicle due back the 27th. Primary SLA pauses
   (`VEHICLE_UNAVAILABLE`), ticket goes `UNASSIGNED` + deferred to the 27th.
2. On the 26th a manager assigns it anyway — the deferral override #249 just built — or the SE reaches
   it through the shared pool.
3. The SE submits. The report flips `RESOLVED`. **Nothing clears the pause.**
4. `VehicleReturnResumeService` only ever looks at **OPEN** reports (#247, pinned by
   `vu-auto-resume-sweep.e2e-spec.ts`), so the sweep can no longer see this cycle. There is no
   automatic path left, and the primary clock stays frozen for the life of the Failure Cycle.

The cycle is then closed with a permanently understated primary SLA — the exact failure #247 exists to
remove, reached by the one route #247's sweep cannot cover.

Manual recovery exists but is obscure: `resumeSla` works on a report id regardless of status, so a
manager who knows to do it can still resume (and re-resolve) the report. Nothing surfaces that they
should.

## Verified

- Grep: `slaPaused` has exactly two writers of `false` (`vehicle-unavailability.service.ts`,
  `component-request.service.ts`) plus #247's sweep. `troubleshoot-submission.service.ts` writes
  `slaPaused: true` (the component path) and never `false`.
- Nothing on cycle close resets the pause columns.
- Not reachable in the common case: the ordinary path is return date → sweep resumes → SE submits, and
  the sweep has already run by then. It needs a submission that lands **before** the return date.

## Likely shape

Fold a reason-checked resume into the submission transaction — the same predicate `resumeSla` and the
sweep already share (`slaPaused ∧ slaPauseReason = 'VEHICLE_UNAVAILABLE'`), so a component-paused cycle
is still untouched. That makes a third automatic writer, which is why it needs a decision rather than a
quiet edit: #247 AC2's "single writer" was written about the *date-driven* resumer, but the phrase is
worth re-ruling on explicitly.

Alternative considered and weaker: widen the sweep to RESOLVED reports. It would resume the clock a
day late (the sweep is daily) and would keep re-examining every resolved report forever.

## Acceptance criteria

- [ ] AC1 — A submission that resolves an OPEN vehicle report on a `VEHICLE_UNAVAILABLE`-paused cycle
      resumes the primary SLA, folding the interval in exactly once.
- [ ] AC2 — A component-paused cycle is untouched by that path (same reason check as #247 AC1).
- [ ] AC3 — The ordinary sequence (sweep resumes on the date, SE submits later) is unchanged and does
      not double-count.
- [ ] AC4 — Secondary SLA bit-identical (#247 AC5's pin extended).

## Blocked by

#247 ✅ (the reason-checked resume this reuses).
