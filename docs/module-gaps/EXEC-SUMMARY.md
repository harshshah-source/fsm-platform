# FSM platform — what's actually there

14 modules checked against the PRD, the code, and the running system — nothing taken from a status document.
The platform is roughly **two-thirds built**, and that is genuinely most of the way. The engine works:
scheduling dispatches, the recommender scores, zone boundaries hold, and permissions are in far better shape
than expected — rounds of deliberately hostile testing found almost no way for the wrong person to see or do
the wrong thing.

What is missing is not features. It is **the last hop of almost every process** — the moment work leaves one
person's screen and has to arrive on another's. Plans are made and never delivered to the engineer. Stock is
consumed and never recorded. Escalations are approved and the receiving zone is never told. Money is approved
by the same person who pays it.

## The five that matter most

**1. Nobody in the field is told anything.** Notifications queue durably, then hit an exit that always reports
itself unavailable. An engineer learns their day only by opening the app. Five modules fail for this one reason.

**2. The uptime number is wrong in the flattering direction.** Fleet uptime reports **100%** for the current
month; the one month with real data reports **56%**; target is 98%. The trend repeats the fabrication, reading
as recovery rather than missing data — and nobody investigates good news.

**3. One person can approve and pay the same expense claim.** Reproduced, not inferred: a single Operations
Head account cleared both halves of a two-person control.

**4. Anyone senior can act inside any zone, absent manager or not.** The "is that manager away" check was
written and never wired up. Of 34,758 audit records, exactly **one** notes someone acting on another's behalf.

**5. Parts used in the field are never recorded.** The app never sends the consumed-components list, so van
stock never depletes and the warehouse queue never fills — and the stock-return logic, which is built and
tested, has nothing to act on. A related bug makes "component unavailable" fail outright, every time.

## What is genuinely good — do not rebuild it
Zone boundaries hold server-side and fail safely when widened. Permissions are strong (one module: 32 probes,
32 correct refusals). Audit *writing* is sound — the faults are that it drops the acting role and almost
nothing reads it back. Pipeline failure detection works; only a pipeline that quietly *stops* goes unnoticed.
Several suspected problems turned out not to exist, and were struck out rather than reported.

## What it would cost

**Engineering size** is relative only — most modules are large, the biggest being reports/analytics and the
ticket lifecycle. **AI build cost** is on the order of **400M–800M context units** across all 14 modules, and
is **indicative only**: the model was calibrated on a different codebase, never on this one, every module came
out low-confidence, and the model's own checks disagree by up to 15×. The *ranking* is trustworthy; the
absolute figures are not a commitment. Completeness moves **63% → 78%** if the whole backlog is built — the
remaining third is mostly connective work, not new capability.

## Where to start

1. **Fix the test data** — 17 findings are unresolved only because the sample data is incomplete (the one
   field-engineer login is not registered as an engineer). Costs almost nothing; unlocks a re-run.
2. **Build the notification exit** — nothing blocks it; five modules wait behind it.
3. **Fix the acting-scope check, then the audit attribution.**
4. **Make the uptime report tell the truth** — three fixes, one a single query change.
5. **Restore the parts-consumption path**, which revives the whole warehouse chain.

**What would most change this assessment:** fixing the sample data and re-running. Much of what is recorded as
unproven is unproven because there was nothing to test against, not because the code was unclear.

*14 modules · 148 findings · 28 dangerous · 17 blocked on test data. Evidence in `docs/module-gaps/`.*
