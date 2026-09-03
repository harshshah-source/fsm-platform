# #295 — Scheduler Console → dispatch board (TDD completion report)

**Date:** 2026-09-01 · **Branch:** `feat/autoplant-integration` · **Status:** done.
**Issue:** [`.scratch/fsm-platform-v1/issues/295-scheduler-console-dispatch-board.md`](../../.scratch/fsm-platform-v1/issues/295-scheduler-console-dispatch-board.md)
**Investigation it was specified from:** [`docs/audits/scheduler-console-dispatch-board-investigation-2026-09-01.md`](../audits/scheduler-console-dispatch-board-investigation-2026-09-01.md)

Frozen once written. Corrections go to `INDEX.md` / `SYSTEM-STATE-2026-07.md`, not here.

---

## What shipped

The Console at `/dispatch/today` stopped being a technical assignment table. Three visible changes,
each with a rule behind it, plus two pre-existing defects fixed because the new work would have
inherited them.

1. **One engineer representation.** `PeopleRail` deleted; the board's first column is the personnel
   column — avatar, name, load, coverage, workload, availability, and the drop target the rail owned.
2. **Work cards instead of eight hex characters.** Device, vehicle, plant, company, transporter,
   device inactivity.
3. **A tri-state action status** — `IN_PROGRESS` / `NOT_STARTED` / `AGING_UNTOUCHED` — derived on the
   server from an unresolved `TROUBLESHOOT_STARTED` and the **assignment** clock.

---

## Slices

Strict TDD throughout: every slice below went RED first, and the RED output is quoted.

### Slice 1 — `deriveTicketActionStatus` (pure)

- **AC targeted:** AC2 (precedence, boundary, the two clocks).
- **RED:** `test/ticket-action-status.spec.ts` — `Failed to load url ../src/scheduling/ticket-action-status`.
- **GREEN:** `src/scheduling/ticket-action-status.ts` — `deriveTicketActionStatus` (started wins,
  then `>=` threshold, then not-aged) and `hoursSinceAssignment`.
- **REFACTOR:** none.
- **Tests:** 8 passing.

The boundary is `>=`, matching `overCapacity`'s `committed >= dailyCapacity` in the same payload, so
one comparison means "has reached its limit" across the surface. A negative age (clock skew) reads as
`NOT_STARTED` rather than wrapping into aged.

### Slice 2 — the soft-state read the board needed

- **AC targeted:** AC3 (ON_SITE alone is not "started").
- **RED:** `test/soft-state-conflict-port.e2e-spec.ts` —
  `TypeError: port.activeTroubleshootStartedTicketIds is not a function`.
- **GREEN:** a second method on `SoftStateConflictPort`, implemented in `PrismaSoftStateConflictPort`
  (`type: 'TROUBLESHOOT_STARTED'`, `resolvedAt: null`, `distinct`), no-op on `NoConflictSoftStatePort`.
- **Tests:** 4 passing (2 new).

**Why not a flag on the existing method.** `activeOnSiteTicketIds` deliberately unions ON_SITE with
TROUBLESHOOT_STARTED — an override that disturbs an engineer standing at the plant is a conflict
either way, and the union is its whole point. A green card is a different claim. Two questions, two
methods; the same reasoning that keeps `decidedBy` and `deferredBy` apart on `TodayHold`.

The empty-list guard is in both, deliberately: the sibling's missing guard produced a live 500 on
2026-09-01 (`TypeError: Cannot read properties of undefined`), and a zone with no committed work calls
this with `[]` on every Console load.

### Slice 3 — the aging threshold as a registry key

- **AC targeted:** AC6 (operator-tunable, no hard-coded rule).
- **RED:** `test/aging-threshold.spec.ts` — `Failed to load url ../src/settings/aging-threshold`.
- **GREEN:** `src/settings/aging-threshold.ts` (`assigned_untouched_aging_hours`, ladder
  `[1,2,4,6,8,12,24]`, default 4, `parse`/`coerce`/`read`) + `SETTINGS_DEFAULTS` and
  `SETTING_VALIDATORS` entries.
- **Tests:** 10 passing.

No migration: `system_settings` rows are seeded from the registry.

### Slices 4–5 — the read model

- **AC targeted:** AC1, AC2, AC3, AC4, AC5.
- **RED:** `test/dispatch-today-work-cards.e2e-spec.ts` — 11 failures across identity, null handling,
  the three statuses, published thresholds and batching.
- **GREEN:** `dispatch-today-query.service.ts` — `TodayTicket` widened with `deviceId`, `vehicleNo`,
  `companyName`, `transporterName`, `inactivityHours`, `assignedAt`, `troubleshootingStarted`,
  `actionStatus`; `bucketByTicket` grown into `identityByTicket` (still **two** queries — the join
  proven by `ticket-query.service.ts`); `failureCyclesByDevice`; the soft-state port injected
  `@Optional()` per the `OverrideService` precedent; `chronicThreshold` and `agingThresholdHours`
  published.
- **REFACTOR:** `bucketByTicket` was replaced rather than supplemented — it already read both tables
  this needs, so adding a third helper would have meant two passes over `device_states`.
- **Tests:** 16 passing.

### Slice 6 — `POST /dispatch/card-summaries`

- **AC targeted:** AC5 (non-today columns, no N+1), AC7 (zone clamp).
- **RED:** `svc.cardSummaries is not a function` ×5.
- **GREEN:** the service method (zone check as `today()` does it, plant-zone filter on the ids, 500
  cap, `TOO_MANY_TICKETS`), the controller route and `CardSummariesDto`.
- **REFACTOR:** the cap moved **before** de-duplication after the oversized test caught it passing —
  `[...new Set()]` collapsed 501 copies of one id to 1, so the bound has to be on what was sent.
- **Tests:** 21 passing in the file.

### Slice 6b — the finished job that read as an untouched one

The issue's §11 flagged one thing to verify rather than assume: whether a *submitted* ticket can still
sit on today's board, in which case the literal rule would flip its card green → red after the
engineer did the work. **It can, and it did.** Traced before changing anything:

- submitting resolves every unresolved soft state for that `(ticket, se)` pair in the same
  transaction — `troubleshoot-submission.service.ts:157-160`, stamped `FORM_SUBMITTED`;
- the assignment row is **not** retired: `retireAssignmentOnClosure` (`close-assignment.ts:42-50`) is
  called only from the terminal paths (verification decision, recovery, install lifecycle,
  non-operational, the backfill), never from submission;
- the ticket moves to `VERIFICATION_PENDING`, which is not in `RESOLVED_TICKET_STATUSES`, so neither
  the backfill nor the nightly closure sweep retires it either;
- `dispatch-today-query` filters on `removedAt: null` and no ticket status, so the card stays on the
  board — and would have aged to amber while sitting in a verification queue.

- **RED:** *"a submitted report keeps the card green"* — `expected false to be true`.
- **GREEN:** `submittedInWindow()` — one batched read of `troubleshooting_submissions` for the board's
  ticket ids, kept where `submittedAt >= batch_assignment_tickets.created_at`.
  `troubleshootingStarted` is now true on **either** proof: the engineer is holding the state now, or
  they already filed the report that resolved it.
- **Tests:** 23 passing (2 new), plus a teardown fix (submissions hold an FK to tickets).

Bounded to the current assignment window — the same bound #244 uses to decide an attempt was
*reached* — because a report filed against an earlier dispatch of the same ticket says nothing about
this one, and letting it vouch would leave a device permanently green across every future assignment.
That bound has its own test.

### Slices 7–10 — the frontend

- **AC targeted:** AC8–AC14.
- **RED:** `test/scheduler-console-dispatch-board.test.tsx` — 18 of 19 failing
  (`Unable to find an element by: [data-testid="avatar-se-1"]`,
  `[data-testid="action-status-…"]`, `Found multiple elements by: [data-testid="load-se-2"]`).
- **GREEN:** client types + `apiDispatchCardSummaries`; `console/WorkCard.tsx`; the personnel cell in
  `BoardGrid.EngineerRow` (column widened `7–8rem` → `13–18rem`); `PeopleRail.tsx` deleted and the
  page grid dropped to two tracks; `useDayContext` gained one batched summaries fetch for the focused
  committed-future column; `--color-action-*` tokens; the legend taught the new channel.
- **Tests:** 19 new passing.

### Slice 10b — the future column that only enriched when deep-linked

Caught by writing the test for how an operator actually reaches tomorrow — by **clicking** it.

The enrichment was originally fired inside the counts request's `.then()`. Counts are cached per
`(zone, version, day)` and fetched once for every visible column, so by the time somebody focuses
tomorrow its rows are already in hand and no request is re-issued — meaning the enrichment fired only
for a day that was *already* focused when its counts landed. A column reached by URL showed cards; the
same column reached by clicking showed compact chips for ever.

- **RED:** *"enriches a future column when the operator focuses it, not only when deep-linked to it"* —
  `expected "spy" to be called with arguments`.
- **GREEN:** a second effect keyed on **focus** rather than chained onto the counts response.
- **Then a second bug inside the fix**, also caught by that test: the new effect depends on `counts`,
  and every *other* column calls `setCounts` as its own request lands. A per-effect `let live = true`
  cleared in cleanup was therefore cleared by an unrelated column resolving a moment later, throwing
  away a valid in-flight response — intermittently, depending on which day won the race. Replaced with
  the two guards that are genuinely about staleness (`generation` for zone/version changes,
  `requested` for duplicates) plus a `mounted` ref for teardown. The reasoning is written into the
  effect so it does not get "tidied" back.

### Slice 10c — the crash on first run against a live stack

Reported from the browser, not from a test: `Cannot read properties of undefined (reading 'text')` in
`WorkCard`, repeated for every card and taking the whole page down with it.

**Cause: a non-null assertion on a lookup keyed by a network value.** `ACTION_STATUS[actionStatus]`
was dereferenced as `status!.text`, and the running backend was serving `dist/` built before this
slice — a payload with no `actionStatus` at all. The type system was satisfied because the client
*declares* the field required; the wire is under no obligation to agree, and an admin build deployed
ahead of its backend is an ordinary state, not an exotic one.

- **RED:** two tests — a payload with the field absent (`Unable to find [data-testid="chip-…"]`,
  i.e. the card never rendered), and the tooltip reading `undefinedh` when the threshold is missing too.
- **GREEN:** `?? null` on the lookup, the status word rendered only when the lookup hits, and
  `statusTitle()` quoting the threshold only when the payload sent one.
- **The fallback is the codebase's existing rule, not a new one:** absent is drawn as absent — no
  rail, no word, the rest of the card unchanged — exactly as an unrecorded `addSource` is drawn as
  unknown rather than guessed into "system".

The backend was rebuilt (`npm run build`) so `dist/` serves the new fields; the fix stands regardless,
because version skew between the two apps will happen again.

---

## Verification

| Package | Typecheck | Tests |
|---|---|---|
| `apps/backend` | `tsc --noEmit` clean | **2262 passed, 0 failed**, 5 skipped · 431 files |
| `apps/admin` | `tsc --noEmit` clean | **802 passed** · 119 files |

`vite build` succeeds and the three new tokens emit real utilities — verified by grepping the built
CSS, not assumed from the config.

**On two failures that appeared and were not real.** An earlier full backend run reported two
failures: `dispatch-crashed-zone-recovery` and `dispatch-in-flight-guard`, both two-connection
concurrency tests, both **wall-clock timeouts** — 5028ms against a 5000ms budget and 20049ms against
20000ms. Margins of 28ms and 49ms are the signature of a loaded machine rather than a logic change,
and the cause was mine: the admin suite, `tsc` and `vite build` were running concurrently against a
backend suite that is deliberately serial (`fileParallelism: false`). Both passed in isolation, and a
clean full re-run with nothing else running was green end to end. Recorded here because "it passes in
isolation" is also what a real load-sensitive regression looks like, and the clean re-run is what
distinguishes them.

**Test-surface retargets, exactly the four the investigation predicted:**
`scheduler-console-composition.test.tsx` ×2 (`person-` → `lane-`),
`scheduler-console-phase1.test.tsx` ×1 (click-to-inspect), `todays-dispatch.test.tsx` ×1 (the rail
assertion became a direct "named once" assertion). `scheduler-console-phase1.test.tsx:229` — the rail
is absent with no zone chosen — stayed valid and was not touched.

Seven fixture files gained the new required `TodayTicket` fields. That churn is the type system doing
its job: every one of those sites would otherwise have rendered a blank card.

---

## Decisions taken during implementation

Four things the issue left open or under-specified were decided here, with reasons, because each
would otherwise have been decided implicitly.

**1. The chronic threshold is a new constant, not a shared export.** The issue said to publish
ADR-0021's `REPEAT_THRESHOLD` "via one shared exported constant". Sharing it would have coupled two
different rules: ADR-0021 is *3 repeat episodes within a rolling 7 days* and crossing it **acts**
(drives cycle and ticket to ESCALATED, notifies); the badge is a *lifetime* count with no window that
only **says** something. An operator retuning escalation sensitivity would have silently repainted
every board. `ticketing/chronic-device.ts` holds its own constant, numerically equal today — exactly
how #238's dial shipped equal to its twin — with the reasoning written down where the next person
will look.

**2. `activeOnSiteTicketIds` could not be reused.** See slice 2. This is the difference between "an
engineer is at the plant" and "somebody has started the work", and the card's whole purpose is the
second.

**3. The colour rule got an explicit amendment rather than a quiet exception.** `index.css` carries
the governing sentence — *never the same colour for two meanings* — because #290 was a slice spent
undoing over-capacity rendered in crimson. The traffic light is red and yellow, so the rule needed
answering rather than dodging. It is answered three ways, all written into that file: own values
(`--color-action-*`, not `--color-critical` / `--color-warning`), own channel enforced by position
(the card's left rail and its label only — never a border, fill, token background or cell), and never
hue alone (the word always prints). All four existing channels keep their hue *and* their position.

**4. The legend's drag sentence was stale and was corrected.** It read "onto the same engineer on a
later day to **defer** it", which stopped being true when the 2026-09-01 cross-day fix made that
gesture `MOVE_TICKET` for any engineer. Corrected while editing the same sentence for the rail
deletion.

---

## For the operator

**`assigned_untouched_aging_hours = 4` is a filed guess.** No existing rule in this repo states when
an untouched assignment becomes worth chasing, and deriving one would have dressed a judgement call as
a finding. Four hours is about half a field shift. It is tunable from the settings registry with no
restart, on the ladder `1 · 2 · 4 · 6 · 8 · 12 · 24`. This is the first number worth revisiting once
the board has been used for a week.

## The one open question, closed

**Submitted-but-visible work** (issue §11) was real, not hypothetical — see slice 6b. It is fixed
along the line the issue pre-authorised, and the widened meaning is written into the field's own
docblock rather than left for a reader to infer: `troubleshootingStarted` is true on either proof
that this assignment has been worked.

**What this does *not* claim.** A submitted ticket now reads `STARTED`, which is understated — it is
finished and waiting on a verification decision. A fourth state ("submitted / awaiting verification")
would be more precise, and it was not added, because the three-state design is the operator's and
widening it is their call rather than an implementation detail. The understatement is safe in the
direction that matters: the dispatcher is told not to chase it, which is correct. **If a fourth state
is wanted, that is a small follow-up** — the server already distinguishes the two cases internally
(`activeTroubleshootStartedTicketIds` vs `submittedInWindow`), so it is a publish-and-render change
with no new read.

## Not done, deliberately

- **Past columns stay counts.** Enriching them would mean painting today's live inactivity onto a day
  that has already happened.
- **`GET /schedules?detail=stops` was not widened.** It is pan-zone and consumed by four other
  surfaces, which would all have paid for a join only the board needs. A separate zone-clamped read
  was the cheaper and safer seam.
- **Chip fill stays reserved** (correction §7.3 / D13). The action status took a channel of its own.
