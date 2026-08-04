# 198 — DECISION: what is the operating "day", and when does dispatch run?

Status: needs-triage — **decision required before [#204](./204-time-semantics-day-boundary-implementation.md) can be built**
Type: HITL · Decision · Backend + Admin + Mobile
Parent: [#197](./197-mobile-pilot-readiness-remediation-epic.md) · Filed 2026-08-04

**Nothing is decided in this issue. It exists to put the options in front of a human.**

## Root cause

The system runs an Indian field operation on a UTC calendar day, and no document in the authority
chain ever ratified that. `utcDayStart` was consolidated into `src/common/utc-day.ts` as a
side-effect of #146's slice 3, not as a decision, and roughly fifteen call sites now depend on it —
so "today" flips at **05:30 IST**, and everything an SE does between midnight and 05:29 IST is filed
under the previous calendar day. Meanwhile the admin planner defines "today" in device-local time
and the dispatch cron has no timezone at all, so three surfaces disagree about the same word.

## Findings closed

Audit 2: **A6** (cron TZ unpinned), **C7** (three definitions of today), **B8** (leave-window shift),
**B7** (admin date-render traps, latent).

## Evidence — verified 2026-08-04

- `apps/backend/src/common/utc-day.ts:9-11` — `Date.UTC(...)`, no offset anywhere. Doc comment frames
  it as de-duplication of three copies, **not** as a timezone decision.
- Depended on by: `me-tickets-query.service.ts:64,78` · `se-ticket-access.ts:34` ·
  `recommender.service.ts:120,170,182` · `intraday-insertion.service.ts:107` ·
  `cross-zone-escalation.service.ts:83` · `shared-pool.service.ts:48` ·
  `bulk-unassign.service.ts:156,212` · `schedule-closure-scheduler.service.ts:100` ·
  `override.service.ts:296,350` · `dispatch-run.service.ts:80` · `day-plan-query.service.ts:27,37`
  · `zone-mapping.service.ts:209`.
- `apps/backend/src/scheduling/dispatch-scheduler.service.ts:50` — `@Cron` with **no `timeZone`
  option**; default `'0 5 * * *'` at `:10`. Its own comment at `:6-8` says "early morning, before the
  field day starts". No `TZ=` is set in any compose/Dockerfile/env file in the repo, so the effective
  hour is host-dependent — on a UTC host it fires at **10:30 IST**, hours into the field day.
- `apps/admin/src/pages/planner/PlannerPage.tsx:33-47` — builds `YYYY-MM-DD` from
  `getFullYear/getMonth/getDate` (device-local), with a comment explaining it avoids `toISOString`'s
  UTC shift. Correct in isolation, opposite convention to the backend.
- `apps/backend/src/engineers/leave-request.controller.ts:52-53` — `new Date('2026-08-10')` is UTC
  midnight, so an approved leave day actually spans 05:30 IST → 05:30 IST the next day.
- **No specification exists.** Zero hits for `Asia/Kolkata`, "day boundary", or IST-midnight
  semantics across `CONTEXT.md`, the PRD, the workflow doc, the backend design docs, or any ADR. The
  only IST clock time in the authoritative set is an *advisory* 08:00 IST reminder
  (`CONTEXT.md:211`, `fsm-backend-low-level-design.md:681`), explicitly "not a workflow gate".
  `fsm-backend-low-level-design.md:113` says "All timestamps stored UTC… **IST is a display concern
  only**" — a *storage* convention, which does not answer how to bucket a day.
- The only IST mention anywhere in the 218-file backlog is an unrelated prose aside in #122.

## The decision

### Q1 — Is the operating day IST-boundaried or UTC-boundaried?

**Option A — IST day (`Asia/Kolkata`, midnight-to-midnight).** Matches what a field operator means
by "today". Fixes the 00:00-05:29 IST misfiling and aligns the backend with admin's planner.
*Cost:* a change to `utcDayStart` touches ~15 call sites and every test that pins a day boundary;
deferral gates, SLA day maths and report cubes all shift by 5h30m for one transition day.

**Option B — keep UTC, and say so.** Zero code change; make it explicit in `CONTEXT.md` and fix
admin's planner to match instead. *Cost:* the operation permanently runs on a day that starts at
05:30 IST — a ticket raised at 01:00 IST belongs to "yesterday" in every report and every day plan,
which will surface as recurring operator confusion rather than a one-time migration.

**Option C — IST for user-facing day semantics, UTC for storage and aggregation cubes.** Most
correct, highest cost: two clearly-named helpers and a rule about which applies where.

### Q2 — What time should the daily dispatch run fire, in what timezone?

No document specifies one. Options: pin `@Cron(..., { timeZone: 'Asia/Kolkata' })` at an operator-
chosen hour (the repealed ADR-0002 suggested ~06:30 IST "before shift start", and ADRs are
historical-only per `docs/agents/domain.md:23`); or pin the container `TZ` and leave the cron
expression alone. **Either way the current state — unpinned and therefore environment-dependent —
is not a defensible answer.**

### Q3 — Are leave/availability dates calendar days or instants?

The docs model leave requests as **dates** (`CONTEXT.md:476`, `workflow:1667`) and availability
windows as **instants** (`CONTEXT.md:687`), with conversion at ZM approval — but never say in which
timezone the date is interpreted. Falls out of Q1, but confirm it explicitly: an SE asking for
10 Aug off should not be available for the first 5h30m of it.

## Acceptance criteria

- [ ] Q1, Q2 and Q3 answered and recorded in `CONTEXT.md` (highest authority per `docs/agents/domain.md:10`)
- [ ] The ruling names which existing behaviour is being kept vs changed, so #204 has a target
- [ ] If Option A or C: a one-transition-day migration note is recorded (deferral gates and report
      cubes shift)

## Verification

Ruling recorded in `CONTEXT.md`; #204 unblocked and its ACs rewritten to match.

## Risk if deferred

Every day-scoped read stays 5h30m out of phase with the operation. Concretely: work an SE does
before 05:30 IST lands on the wrong day plan and the wrong report; deferred tickets can be released
early (the exact failure #146 was filed for); and the dispatch run that is supposed to precede the
field day may fire in the middle of it. None of this is visible in tests, because the tests were
written against the same assumption.

## Size estimate

Decision: S (one sitting with the operator). Implementation (#204): M, larger under Option A/C.
