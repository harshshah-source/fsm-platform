# #321 — The two numbers in a day-plan notification share one basis

**Finding:** CB-8 (`audit/2026-09-01-scheduler-engine-forensics.md` §6) · **Wave 4** · P3
**Landed:** 2026-09-03 · branch `feat/autoplant-integration`
**Issue:** [`.scratch/fsm-platform-v1/issues/321-dispatch-notification-counts.md`](../../.scratch/fsm-platform-v1/issues/321-dispatch-notification-counts.md)

---

## What was wrong

`dispatchForSe` built the `DAY_PLAN_DISPATCHED` payload from two different clocks. `stops` was the
running `stopSequence`, which on a same-day append (#127) continues from the plan's existing maximum —
cumulative. `tickets` was the counter of rows *this run* wrote — incremental. An SE with three stops
receiving one more stop of two tickets was told `stops=4, tickets=2`.

That pair is not merely imprecise: it describes no state the plan has ever been in. And the two are
only ever read together — `SpineDayPlanNotifier` puts both into one notification's metadata — so there
is no reading under which it is true.

## The basis, and why the argument is not stylistic

The issue allowed either basis and required one. **Cumulative**, because this notification is
checkable against a screen.

Its body is *"Your Day Plan is live. Tap to start."*, and what the tap opens is the SE's day plan — the
notifier's own docblock says so (`Home *is* the Day Plan`). An incremental pair would be internally
consistent and still contradicted the moment the SE looked: the push says 2, Home shows 5. A count the
recipient can disprove by following the notification is worse than either basis chosen consistently.

So the numbers are not derived from this transaction's bookkeeping at all. They are **read back the way
`DayPlanQueryService` reads them** — live stops that still carry at least one live ticket, and the live
ticket rows across them:

```ts
const planStops = await tx.plantBatchAssignment.count({
  where: { scheduleId, ...liveBatchFilter(), tickets: { some: { removedAt: null } } },
});
const planTickets = await tx.batchAssignmentTicket.count({
  where: { removedAt: null, batch: { scheduleId, ...liveBatchFilter() } },
});
```

Deriving them instead from `stopSequence` and the run's counters would have been cheaper and subtly
wrong twice over: `stopSequence` is a *numbering*, not a count, and a stop whose every ticket has been
removed is not on the plan at all (#179 slice 3 hides it), so both would over-report after a ZM
withdrawal.

On a fresh plan the two bases coincide exactly, which is why AC2 (first dispatch unchanged) needs no
special case.

## `liveBatchFilter` — one status list for the two readers that must agree

`['AUTO_ASSIGNED', 'OVERRIDDEN']` is now `LIVE_BATCH_STATUSES` / `liveBatchFilter()` in
`scheduling/schedule-status.ts`, beside its schedule-level sibling and for the same reason (#153): the
notification's counts are *asserted against* the day-plan read, and two hand-written copies of a status
list is how that agreement rots.

Seven other readers still spell the pair inline (`engineers-query` ×2, `me-tickets-query`,
`se-ticket-access`, `dispatch-today-query`, `zm-schedule-query` ×2). They answer different questions on
different screens and were deliberately left rather than swept into a payload slice; folding them in is
a tidy follow-up, not a correctness one, and it is recorded in the constant's docblock so the omission
is visible rather than accidental.

## What did NOT change

`DispatchSummary.tickets` — the number that becomes `dispatch_runs.tickets_dispatched` — stays
incremental. It answers a different question ("what did *this run* place?"), and a cumulative summary
would count the morning run's tickets again in the afternoon run's ledger row. The spec pins this
explicitly, because the obvious over-application of this fix is to make both cumulative.

No notifier or outbox mechanics, no schema, no migration.

## Verification

- `test/day-plan-notification-counts.e2e-spec.ts` — 3 cases. Red first: the append payload was
  `{ stops: 3, tickets: 2 }` against an expected `{ stops: 3, tickets: 5 }`, and the run-ledger case
  showed the same mix at a smaller scale. The fresh-plan case (AC2) passed red **and** green, which is
  the point of having it.
- The append case asserts the payload `toEqual` the `DayPlanQueryService` read rather than a
  hand-computed constant, so the stated argument is the assertion.
- 12-file targeted regression (both dispatch write paths, the outbox and its writers, the notifier
  spine, day-plan reads, the run ledger and transparency) — 43/43.
- Full backend suite with #330: **455 files, 2,423 passed, 5 skipped, zero failures**, five batches,
  every batch exit 0.
- `npx tsc --noEmit` clean. No migration.

## Acceptance criteria

- [x] **AC1** — stops and tickets share one basis, stated in a comment (cumulative; the comment gives
      the "checkable against the screen the notification sends the SE to" reason).
- [x] **AC2** — fresh-plan notifications unchanged.

`UI surfaces: n/a` (push metadata), so the parity gate does not apply.
