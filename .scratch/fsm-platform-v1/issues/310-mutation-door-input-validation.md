# 310 — Mutation-door input validation: override DTO, BigInt 404s, date sanity
Status: **done** (2026-09-02) — report [`docs/progress/310-mutation-door-input-validation.md`](../../../docs/progress/310-mutation-door-input-validation.md). The DTO deliberately does **not** enumerate `action`: an unimplemented action is a deploy-ordering problem, and the service's `UNSUPPORTED_ACTION` names it where an `@IsIn` would blame the client — both halves pinned. Uuids are validated as **Postgres** accepts them, not as RFC 4122 defines them; `@IsUUID`'s version check would refuse ids this repo's own specs use, and caught four of them on the first green run. `toBigIntId` returns null rather than throwing, because whether a malformed id is a 404 or a 400 is a question about the resource, not the parse. `INVALID_DATE` is a new outcome rather than reusing `TARGET_DATE_IN_PAST` — a move onto today is legal, a defer to today is not. **The suite's real find was not an over-strict DTO but seven spec files deferring and holding into the past**: each passed a date future relative to its own fixture clock and never passed that clock to the writer, so the very tests proving deferral works were exercising the silent no-op RC-11 describes. `placeHold` had no injectable clock at all and now takes one in its options bag. One correction to this issue's premise: "UI surfaces: n/a" holds for the override door but not for the hold panel, whose date input had no lower bound — see the UI surfaces section.
Type: AFK
Wave: 3 · Severity: P2 · Findings: CB-3 + CB-9 + RC-11(past-dates),
`audit/2026-09-01-scheduler-engine-forensics.md` §6/§8

## Problem

Three input-validation gaps on the same mutation surface:

1. **CB-3:** `POST /batches/:id/override` performs no body validation — the mandatory
   `reasonCode` writes through as NULL (`override.service.ts:355, 1267-1268`), missing `ticketId`
   is a Prisma 500. The sibling door (`intraday-updates.controller.ts:82,102`) correctly 400s.
2. **CB-9:** bare `BigInt(id)` throws unhandled SyntaxError → 500 on `batches.controller.ts:124`,
   `intraday-updates.controller.ts:84,104`, `intraday-insertion.controller.ts:59,68,81` (sibling
   handlers in the same files wrap and 404).
3. **Past/garbage dates accepted:** `placeHold` with `heldUntil <= today` returns OK holding
   nothing; `DEFER_TICKET` with a garbage `deferredToDate` → Invalid Date → 500, with a past date
   turning "defer" into a bare remove (`override.service.ts:415,432`;
   `scheduler-preview.service.ts:155-159`).

## Root cause

The override body is an interface, and the global pipe explicitly skips interface-typed bodies
(`app.module.ts:225-229`); the id/date parsing predates the repo's 404/400 conventions.

## Affected files / symbols

- `apps/backend/src/scheduling/batches.controller.ts` + `scheduling/dto/` (a validated DTO for
  `OverrideCommand`)
- `apps/backend/src/scheduling/intraday-updates.controller.ts`,
  `intraday/intraday-insertion.controller.ts` (BigInt guards)
- `apps/backend/src/scheduling/override.service.ts` (defer-date sanity),
  `scheduler-preview.service.ts` (hold-date sanity)

## Intended behavior after fix

- Missing/empty `reasonCode` on any override action ⇒ 400 `REASON_REQUIRED` (mirroring the
  intraday controller's shape); missing `ticketId` where the action needs one ⇒ 400.
- Malformed `:id`/`batchId`/`zoneId` ⇒ 404/400 per the sibling handlers' existing pattern, never
  500.
- `heldUntil`/`deferredToDate` must parse as `YYYY-MM-DD` and be strictly future (IST) ⇒ else
  400 naming the field; the parse uses `istWindowStart`, the repo's one parser.

## Implementation boundaries

- Validation only — no semantics change to any accepted command. The DTO must accept exactly the
  seven actions' current legal payloads (pin with the existing override e2e suites).
- Do not touch the ON_SITE/deferral confirm gates.

## DB / API / frontend impact

DB: none. API: previously-accepted invalid requests now 400 — the admin never sends them
(reason fields are required in every form), so no frontend change; the contract is stated in the
issue for any other client.

## Dependencies

Sequence after #298/#306/#307 on `override.service.ts` (shared file). Independent otherwise.

## Regression risks

- Over-strict DTO rejecting a legal action variant — every override e2e suite must stay green;
  add the DTO before tightening, run, then tighten.

## What the fixtures revealed (recorded — it is a finding, not a chore)

The stated regression risk was an over-strict DTO rejecting a legal action variant. Nothing of the sort
turned up; the seven `batch-override-*` suites passed untouched. What the suite found instead was
**seven spec files passing hold/defer dates that are future relative to their own fixture clock and
months past relative to the wall clock**, because they never passed that clock to the writer:

| spec | fixture clock | date it passed |
|---|---|---|
| `batch-override-defer-reorder` | 2026-06-21 | 2026-06-25 |
| `dispatch-defer-lifecycle` | 2026-06-26 | 2026-06-27 |
| `override-defer-frees-capacity` | 2026-06-25 | 2026-06-29 |
| `override-defer-leaves-today` | 2026-06-24 | 2026-06-28 |
| `override-schedule-live` | 2026-06-21 | 2026-06-25 |
| `scheduler-preview` (6 holds) | 2026-06-21 | 2026-06-23 |
| `hold-dispatch-integrity` (3 holds) | 2026-06-21 | tomorrow-of-fixture |

Every one of those defers was writing `deferred_until` into the past and "working" — the exact silent
no-op RC-11 describes, inside the tests written to prove deferral works. `override()` has always taken
`now`; `placeHold` had none, and now takes one in its options bag (its siblings `preview` and
`checkStaleness`, and the run/dispatch entry points, all already spell an injected clock that way, and
seven positional arguments is how a caller lands `{ confirm: true }` in the `now` slot). Two sibling
specs — `dispatch-changes-today`, `dispatch-today-read` — already passed their clock, which is what
makes this an oversight rather than a convention.

## Tests required

- Per action: missing reason ⇒ 400 (the pin CB-3 found absent); malformed id ⇒ 404; garbage/past
  dates ⇒ 400 with field name.
- Regression: all `batch-override-*` and deferral-confirm suites green.

## Acceptance criteria

- [x] AC1 — no request on these doors can produce a 500 from its own malformed input.
- [x] AC2 — a reason-less override cannot commit; the audit record can no longer be empty.
- [x] AC3 — a hold/defer that would hold nothing (past date) is refused, not silently a no-op.

## UI surfaces

**Correction, recorded rather than quietly worked around.** "n/a (admin already sends valid payloads)"
is exact for the override door — `ActionsBand` disables Confirm until `reason.trim() !== ''` and sends
the union verbatim — but **not** for the hold panel, whose `type="date"` input had no lower bound. So
this issue would have turned a silent success into a bare `REQUEST_FAILED_400`, the server writing a
usable sentence and the client discarding it. Two small changes rather than shipping a worse door:

- `min={addIsoDays(istIsoDate(), 1)}` on the hold date input, so the operator is steered before they
  type rather than after.
- the 400's `message` carried through in `api/schedulerPreview.ts`, exactly as `apiOverrideBatch`
  already does for `TARGET_DATE_IN_PAST` and for the reason that file's own comment gives about the
  409s.

The second is not redundant given the first: `min` is computed when the panel renders, so a console
left open across IST midnight offers a date that was future when it was drawn and is not when it is
sent.

## Reference

n/a.

## Blocked by

298, 306, 307 (shared files — sequence only, no semantic dependency)
