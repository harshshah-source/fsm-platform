# 265 — Lost-race hygiene: clean conflict answers and first-writer-wins attribution

Status: done (2026-08-21)
Type: AFK · Backend
Decision: #258 Parts 5–6 (G4, G7)

## Objective

Every legitimate concurrency race on the manual paths ends with a correct winner, a clean explained
4xx for the loser, and untouched attribution — never a 500, never a silently overwritten
`removed_by`/`removal_reason`.

## Current behaviour (all verified 2026-08-20)

- `assignTicket`'s `ALREADY_ASSIGNED` check is outside its tx (`override.service.ts:344`); two
  admins assigning the same ticket both pass it, the loser's `batchAssignmentTicket.create` hits
  `batch_assignment_tickets_one_active_per_ticket` and the P2002 propagates as an unhandled 500.
- `ensureSchedule` find-then-create (`override.service.ts:585-596`): two concurrent assigns to the
  same SE race the schedule unique → loser 500s.
- `removeTicket` reads the live row outside the tx and updates **by primary key with no
  `removedAt: null` re-assertion** (`override.service.ts:196-206`): a concurrent remover — or the
  04:00 closure recycle, which correctly guards its own writes
  (`schedule-closure-scheduler.service.ts:263,270`) — gets its `removedAt`/`removedBy`/
  `removalReason` overwritten by the later committer. Same shape in `deferTicket` (`:245`) and the
  removal legs of `moveTickets`.
- Intraday `accept` omits the #249 deferral opt-in (`intraday-insertion.service.ts:190`, also
  `manualAssign:310`), so a ticket deferred between offer and accept burns the retry chain against
  an invisible hold. (#268 retires the acceptance flow for CRITICAL; the `manualAssign` leg and the
  shared `assignTicket` behaviour keep this relevant.)

## Required change

1. `assignTicket`: catch P2002 on the batch-ticket create → re-read → return `ALREADY_ASSIGNED`
   (existing outcome vocabulary); controllers already map it to 409.
2. `ensureSchedule`: catch P2002 on the schedule create → re-find with `liveScheduleFilter()` →
   proceed with the winner's schedule (the intent — "get me the SE's live schedule" — is satisfied).
3. All terminal stamps on `batch_assignment_tickets` (`removeTicket`, `deferTicket`, `moveTickets`
   removal leg) become conditional `updateMany({where: {id, removedAt: null}})`; count 0 → the row
   was already terminal → return a clean `CONFLICT`/`NOT_FOUND` outcome and write NO audit row
   claiming an action that did not happen.
4. `manualAssign` and any surviving intraday assign leg pass an explicit deferral decision to
   `assignTicket` (surface `CONFLICT_DEFERRED` to the ZM rather than mis-mapping it).
5. Sweep the other override actions (`swapSe`, `reorder`, `flagOverridden`) for the same two
   shapes (unguarded terminal writes; unhandled P2002) and fix inline — the sweep result is part of
   the report, the #218 lifecycle-drift style.

## Existing code to reuse

`transitionOrConflict` (#101's helper — items 3/4 are exactly its pattern); `OverrideOutcome`
union; `REMOVAL_REASONS` vocabulary; closure's guarded-write precedent.

## Data model / API

None / no contract change — only 500s become honest 409/conflict outcomes.

## UI surfaces

Admin: existing conflict banners already render `CONFLICT_*` outcomes; verify the two new paths
reuse them. Mobile: n/a.

## Acceptance criteria

- [x] Two concurrent `assignTicket` calls for one ticket: one OK, one `ALREADY_ASSIGNED` (409), no
      500, exactly one live batch row (asserted table-wide).
- [x] Two concurrent assigns to one schedule-less SE: both OK, ONE schedule row, stops sequenced
      without collision.
- [x] Concurrent remove/remove and remove/closure: first writer's attribution survives verbatim;
      loser gets a clean outcome and no audit row.
- [x] A deferred-mid-flight manual assign surfaces `CONFLICT_DEFERRED` to the caller.
- [x] Full override/batch spec suite (5 batch-override + 4 bulk-unassign specs) stays green.

## Corrections / found while building

**1. Two measured facts decided the whole implementation shape, and the usual idiom is wrong here.**
A throwaway probe against real Postgres established both:

- **`meta.target` is absent.** Under this repo's Prisma driver adapter a P2002 carries no `target` —
  the field every example keys on. The constraint identity is at
  `meta.driverAdapterError.cause.constraint.fields`, with the index name only in the raw message.
  `modelName` is the discriminator (`src/common/unique-violation.ts`), and it is *exact* here because
  `batch_assignment_tickets` and `work_schedules` each carry exactly one unique — a raw partial index
  invisible to `schema.prisma`. If either gains a second, that helper must start reading
  `constraint.fields`; the assumption is written down rather than left implicit.
- **A P2002 inside an interactive transaction aborts it.** Postgres answers everything after it with
  *"current transaction is aborted, commands ignored until end of transaction block"*, so item 2's
  "catch → re-find → proceed" **cannot** be done in place. Recovery retries the whole transaction from
  outside. That rollback is also what makes item 3's "no audit row" free: `withAudit` writes the audit
  row inside the same transaction.

**2. `ensureSchedule` was broken with no concurrency at all — a second defect of the same class.**
`work_schedules_one_active_per_se_zone_day` is partial-unique on `(se_id, zone_id, date_from)`;
`batch-assignment.service.ts:128` looks the row up on exactly those three columns. `ensureSchedule`
matched **`date_to` as well**. Two call sites, two answers to "which row is this engineer's schedule
for this day", and the database agreeing with only one. So any live schedule with a differing
`date_to` — a multi-day plan, which `swapSe`/`moveTickets` propagate by handing the *source* batch's
range down, or a null one, which the column allows — made **every** manual assign to that engineer for
that day find nothing, create, and 500. Deterministic, no race. The find now matches the constraint;
since the index permits no second ACTIVE row for the day, attaching to the one that exists is the only
legal outcome, not a compromise.

**3. `flagOverridden` resurrects closed day plans — the sweep's real catch.** Every override action
ends by calling it, and it wrote `status: 'OVERRIDDEN'` to `work_schedules` **by primary key with no
liveness guard**. `OVERRIDDEN` is a LIVE status (#153) while `COMPLETED`/`PARTIAL` are terminal, so an
override landing on a plan the 04:00 closure already shut brings it back to life — exactly what
`schedule-status.ts` warns of: *"widening past those would resurrect finished work onto today's plan."*
No race required; a manager on a stale screen is enough. `swapSe` spells the same stamp inline and
carried it too. **Fixed narrowly**: the withdrawal itself still happens (the ticket returns to the
pool, which is harmless on a finished plan) and only the provenance stamp is declined. Whether an
override should be *refused outright* on a terminal schedule is a lifecycle question owned by **#271**,
not one to smuggle in here.

**4. AC-2's concurrent pair does not reliably interleave, and saying so is the point.**
`Promise.all([assignTicket(), assignTicket()])` was written, passed immediately, and proved nothing —
the trap `test/support/concurrency.ts` was built by #107 to name: an unbarriered race *"passes without
ever having tried the case it claims to cover."* The test is kept (it pins the required outcome) with
that limitation stated in it, and the sensitivity comes from the deterministic sibling in finding 2.

**5. The race window for item 3 needed a seam, and one already existed.** `override()` takes no
injection point, but `AuditService` is an injected collaborator and every affected writer does its
pre-read **before** calling `withAudit` — so gating that call is precisely the gap between the read and
the write. No production seam was added for a test's benefit. The `ensureSchedule` race is the one
window nothing reaches (it needs a writer to commit *between* a `findFirst` and a `create` inside one
transaction), so its retry is tested at its own seam as a unit instead of asserted untested.

**6. Item 4 was two defects, not one.** `manualAssign` collapsed `CONFLICT_DEFERRED` into `NOT_FOUND`
→ a 404, so a ZM was told a held ticket "doesn't exist" and #249's confirm flow was unreachable from
the escalation queue. It now surfaces the outcome and accepts `confirm`/`reasonCode`, mapped to the
**byte-identical** 409 body `/schedules/assign` already returns (including
`DEFERRAL_OVERRIDE_REASON_REQUIRED`), so one held ticket answers the same way through either door.
And `accept` re-offered on a deferral — but **no SE can clear a hold**, so the next SE hit the same
refusal, and the next, until the chain exhausted and it escalated anyway, hours later, with a trail
recording several engineers declining nothing. It escalates immediately now, which is only useful
*because* the ZM's manual-assign path can resolve it.

**7. `reorder` swept clean.** It renumbers `stop_sequence` on `plant_batch_assignments`, which carries
no unique constraint and no terminal stamp. Two concurrent reorders can interleave into an order
neither operator chose, but nothing is lost and no attribution is overwritten — out of scope for this
issue, and recorded here so the next sweep does not re-derive it.

**8. The UI instruction resolves to a handoff note, not a change.** #265 asks to *"verify the two new
paths reuse the existing conflict banners"*. They cannot: **the intra-day manual-assign path has no
admin client at all** — `GET :id/available-ses` and `POST :id/manual-assign` are unreachable from the
app, and **#277** owns building the modal. The admin's `DeferralConflictError` / `DeferralConflict`
(`apps/admin/src/api/schedules.ts:117-136`) already exist for `/schedules/assign`, and this issue's
new 409 body is deliberately **byte-identical** to the one they parse — including
`DEFERRAL_OVERRIDE_REASON_REQUIRED` — so #277's modal reuses that vocabulary rather than inventing a
second one. Nothing on the admin side changed here, and nothing needed to.

## Tests

e2e race specs using two live connections (the #255-established fixture discipline); unit for the
P2002 re-read branches.

## Dependencies / Blocked by

None. Independent; safe to land before or after #262 (both touch `batch-assignment` messages —
coordinate the `SCHEDULE_CONFLICT` labeling with #262 item 3 if they land together).

## Risks

Low — behaviour-preserving on the happy path; the guarded updates change loser outcomes only.

## Rollback

Code-only.
