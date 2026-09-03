# #310 — Mutation-door input validation: the override DTO, the BigInt 404s, and the dates that held nothing

**Findings:** CB-3 + CB-9 + RC-11 (past dates) · `audit/2026-09-01-scheduler-engine-forensics.md` §6/§8
**Wave 3 · P2 · Landed:** 2026-09-02 · branch `feat/autoplant-integration`

---

## What was wrong

Three gaps on one mutation surface, and they share a shape: **the request itself was never checked**,
so what the caller typed reached the driver, or the database, or committed.

1. **CB-3 — the override body was validated by nothing.** `POST /batches/:id/override` takes an
   `OverrideCommand`, which is a TypeScript *union*. The global `ValidationPipe` skips interface-typed
   bodies by design — Nest gives it no class metatype to reflect on (`app.module.ts:225-229`) — so the
   one door whose contract says "mandatory reason" enforced nothing. `reasonCode` wrote through as NULL
   onto the accountability record #275/#282 read back; a missing `ticketId` reached Prisma as a 500.
   The sibling door on the same concept (`intraday-updates.controller.ts:82,102`) has always 400'd both.
2. **CB-9 — five bare `BigInt(id)` calls.** `BigInt('abc')` throws a `SyntaxError` nothing caught, so
   `POST /api/batches/abc/override` was a 500. In three of those files a *sibling handler* wrapped the
   same parse and answered 404. The asymmetry was the bug, not any one missing try/catch.
3. **RC-11 — a past-dated hold or defer returned OK having done nothing useful.** `notDeferredOn` is
   inclusive: a ticket with `deferred_until = D` is dispatchable **on** D. So a defer to today removes
   the ticket from the batch, writes the audit row, and lets the very next run re-plan it — a bare
   remove wearing the word "defer". `placeHold` had the same hole with none of the effect at all.

## What landed

| | |
|---|---|
| `src/common/parse-id.ts` | **new** — `toBigIntId(raw): bigint \| null` |
| `src/scheduling/dto/override-command.dto.ts` | **new** — the validated body + `asOverrideCommand` |
| `scheduling/batches.controller.ts` | DTO on both override doors; the write door's id guard |
| `scheduling/intraday-updates.controller.ts` | id guards on `remove` / `reorder` |
| `intraday/intraday-insertion.controller.ts` | id guards on `fire` / `available-ses` / `manual-assign` |
| `scheduling/override.service.ts` | `INVALID_DATE` outcome + the `DEFER_TICKET` date rule |
| `scheduling/scheduler-preview.service.ts` | `INVALID_DATE` outcome + the `placeHold` date rule + an injectable clock |
| `scheduling/schedules.controller.ts` | the hold door's 400 mapping |
| admin `api/schedulerPreview.ts`, `console/ActionsBand.tsx` | carry the refusal's sentence; `min` on the hold date |

## Six decisions that are judgements, not transcription

**1. The DTO deliberately does not enumerate `action`.** An `@IsIn` over the seven actions is the
obvious move and it is wrong here. An action this build does not implement is, in practice, the admin
bundle deployed ahead of the API — the exact 500 `batches-controller.e2e-spec.ts` was written to pin
after it happened live on 2026-09-01 — and the answer to it is `UNSUPPORTED_ACTION` with a sentence
naming the real problem ("the admin app may be newer than the API"). An `@IsIn` would replace that
with a generic field error blaming the client for a deploy-ordering problem. So the pipe checks that
an action was *named*; the service's own exhaustive switch still decides whether it *exists*. Both
halves are pinned: the pipe must pass an unknown action through, and the service must still refuse it.

**2. Uuids are validated as Postgres accepts them, not as RFC 4122 defines them.** `@IsUUID()` also
insists on a valid version nibble, and the repo's own fixtures and specs use ids like
`00000000-0000-0000-0000-0000000000aa`. Enforcing the version would refuse requests the database is
perfectly happy with while buying nothing — a v1 uuid is no more a real ticket than a v4 one, and
whether the row *exists* is the service's question. The rule that earns its place is the 8-4-4-4-12
hex shape: without it a `ticketId` of `'abc'` reaches a `uuid` column as a cast error, i.e. AC1's 500.
This surfaced as four red tests in the very first green run, which is what a discrimination case is for.

**3. `toBigIntId` returns `null` instead of throwing.** *Which* refusal a malformed id deserves is a
question about the resource, not about the parse: a path segment naming a batch is an absent batch
(404), while a body field naming the zone to sweep is a malformed request (400). Centralising the
throw would have forced one answer on both. It is also stricter than `BigInt`, on purpose — `BigInt('')`
is `0n`, `BigInt(' 7 ')` is `7n`, `BigInt('0x1f')` is `31n`, and each of those surprises reaches the
database as a real query for a row nobody asked about.

**4. Date *shape* at the pipe, date *meaning* in the service.** `YYYY-MM-DD` is a question about the
request. "Is that date in the past" is a question about today — which the service already owned for
`MOVE_TICKET` (`TARGET_DATE_IN_PAST`), and which a caller passing an explicit `now` must be able to
answer against **their** clock. That is not hypothetical: seven existing specs do exactly that, and it
is why `placeHold` gained an injectable clock rather than reading `new Date()`.

**5. `INVALID_DATE` is a new member, not `TARGET_DATE_IN_PAST` reused.** The two rules genuinely
differ: a `MOVE_TICKET` onto **today** is an ordinary same-day reassignment, and a `DEFER_TICKET` to
today is not a deferral at all. Folding them would have needed one of the two to change meaning. Both
map to 400 rather than 409 for the same reason the existing one does — there is no `confirm` that makes
a date which holds nothing hold something.

**6. Each date rule fires as early as the action is known.** `placeHold`'s runs first, before the
ticket is even read: it needs no row, it leaks nothing (the answer depends only on the caller's own
input), and an operator who mistypes the year should be told that rather than told the ticket cannot be
held. `DEFER_TICKET`'s runs inside the switch, because that is the first point at which the field
exists — the same place `MOVE_TICKET`'s has always lived, so an out-of-zone batch still answers 404 and
learns nothing.

## Eight fixtures had been deferring and holding into the past

The regression risk the issue names is "an over-strict DTO rejecting a legal variant". What the suite
actually found was different and more interesting: **seven spec files were passing dates that are
future relative to their own fixture clock and long past relative to the wall clock**, because they
never passed that clock to the writer. `override()` has always taken `now`; `placeHold` did not have
one at all.

So every one of those defers was writing `deferred_until` into the past — and "working", because
nothing refused it. That is precisely the silent no-op RC-11 describes, sitting inside the tests
written to prove deferral works:

| spec | fixture clock | date it passed |
|---|---|---|
| `batch-override-defer-reorder` | 2026-06-21 | 2026-06-25 |
| `dispatch-defer-lifecycle` | 2026-06-26 | 2026-06-27 |
| `override-defer-frees-capacity` | 2026-06-25 | 2026-06-29 |
| `override-defer-leaves-today` | 2026-06-24 | 2026-06-28 |
| `override-schedule-live` | 2026-06-21 | 2026-06-25 |
| `scheduler-preview` (6 holds) | 2026-06-21 | 2026-06-23 |
| `hold-dispatch-integrity` (3 holds) | 2026-06-21 | tomorrow-of-fixture |

Each now passes its own clock, so the fixture means what it says. Two sibling specs
(`dispatch-changes-today`, `dispatch-today-read`) already did — which is what shows this is a fixture
oversight rather than a convention.

`placeHold`'s clock rides in its options bag rather than becoming an eighth positional argument. Its
own siblings (`preview`, `checkStaleness`) and the run/dispatch entry points all already spell an
injected clock that way, and seven positional arguments before the one you need is how a caller passes
`{ confirm: true }` into the `now` slot.

## The issue's "UI surfaces: n/a" was true of override and not of holds

The issue records no frontend impact because "the admin never sends them — reason fields are required
in every form". That is exact for the override door: `ActionsBand` disables Confirm until
`reason.trim() !== ''` and sends the union verbatim. It is **not** true of the hold panel, whose date
input had no lower bound, so #310 turned a silent success into `REQUEST_FAILED_400` — the server
writing a good sentence and the client throwing it away. Two small changes rather than shipping a worse
door:

- `min` on the hold date input, so the operator is steered before they type rather than after.
- the 400's `message` carried through, exactly as `apiOverrideBatch` already does for
  `TARGET_DATE_IN_PAST`, with the same reasoning that file's own comment gives about the 409s.

The second is not belt-and-braces for the first: `min` is computed when the panel renders, so a console
left open across IST midnight offers a date that was future when drawn and is not when sent.

## Verification

- **Full backend suite green: 449 spec files, 2,396 tests passed, 5 skipped, ZERO failures**, run as
  five foreground batches (a single run exceeds the Bash tool's 10-minute cap). Batch 3 was re-run in
  full after the three fixtures it caught were corrected. One batch lost 6 tests to a worker crash and
  `run-tests.mjs`'s #184 retry recovered all of them.
- **Admin suite green: 119 files / 829 tests**, the handoff's exact baseline. `tsc --noEmit` clean in
  both backend and admin.
- The new spec (`test/mutation-door-input-validation.e2e-spec.ts`, 24 cases) was red first on all
  three ACs: 14 failures, including every one of CB-9's five 500s reproduced by name in the log
  (`SyntaxError: Cannot convert abc to a BigInt`) and the AC3 defer returning `OK` against a real batch
  while retiring the row it claimed to hold.
- Two flakes seen once and not reproduced, neither touching this change: `intraday-queue.test.tsx`
  failed in one parallel admin run and is 9/9 green isolated and on re-run; the committed
  `ticket-drawer-tabs.test.tsx` logs an unhandled post-test render error in `TicketDetailDrawer`
  (`attempts.attempts.length` on undefined) while all 829 tests pass. Both files are unmodified in the
  working tree, so both predate this slice.

## What this does not do

It validates requests. It does not make the override door's *semantics* stricter: every command the
seven actions legally accepted before is accepted now, which is what the existing `batch-override-*`
suites assert and why they were left alone. The flat DTO also means a `DEFER_TICKET` body may still
carry a `stopSequence` this build ignores — extra fields were always ignored, and the defect was the
missing ones.
