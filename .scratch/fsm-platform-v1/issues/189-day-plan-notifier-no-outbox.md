# 189 — Day-plan dispatch notifier fires post-commit with no durable outbox — a crash silently loses the event

Status: superseded → [#264](./264-day-plan-notification-outbox.md) (2026-08-20, #258 Part 7 ratified the outbox). This file stays as the defect record.
Type: AFK · Backend defect (latent today, data-loss once real channels exist)

Filed 2026-08-03 by operator directive (moved out of #76's 2026-07-28 comment — "memos get
skimmed"; a data-loss defect needs its own status line). Duplicate-checked against the full issue
list before filing: **#140** is the same *family* (non-atomic escalation/audit/notify in the
cross-zone sweep) but owns a different call site and an idempotency-exclusion bug — it names a
durable outbox only as one possible fix. No issue owns the outbox mechanism itself. This one does.

## The defect

`batch-assignment.service.ts` buffers day-plan notification events in a **process-local array**
during the dispatch transaction (`:57` — deliberately, so a rolled-back plan never announces
itself) and fires them **after commit, in-process, with no persistence** (`:232-235`):

```ts
for (const event of notifications) {
  await this.notifier.dayPlanDispatched(event);
}
```

A crash, OOM, or deploy between commit and the end of that loop loses the remaining events
**silently and permanently** — nothing re-scans for dispatched-but-unannounced plans. If SEs learn
their day plan by notification (the PRD's model once #76's adapters exist), that is a lost day of
work with no trace: the schedule exists, the SE was never told.

**Why this is filed now, before push exists:** today the notifier is `LoggingDayPlanNotifier`, so
the loss is log lines. The moment #76 rewires notifiers into the spine, the same gap swallows
push — and SMS and email the same way, since every channel hangs off the same post-commit,
in-memory hop. Fixing it after adapters ship means retrofitting durability under live traffic.

## Scope

1. **Durable outbox for spine-bound events.** An outbox row written **in the same transaction** as
   the business event it announces; a drain loop (existing `@nestjs/schedule` machinery — no new
   infra) delivers with retry/backoff and marks sent. Per-channel outcomes recorded truthfully
   (coordinates with #76's per-channel delivery-status fix).
2. **Primary call site:** the day-plan dispatch loop above.
3. **Sweep the other `Logging*Notifier` fire sites** (#76 item 1 lists them: recovery, install,
   customer-confirmation, component-request, repeat-escalation) for the same post-commit in-memory
   pattern; route them through the same outbox as they are rewired to the spine.
4. **#140 relation:** #140's cross-zone fix ("make notification delivery retryable and decoupled
   from the idempotency gate: drive it off a durable outbox") should consume this issue's outbox
   rather than build its own. #140 keeps its own bug (the `none: {}` re-sweep exclusion); this
   issue provides the mechanism.

## Acceptance criteria

- [ ] The outbox row is written in the same transaction as the dispatch commit — a crash at any
      point after commit leaves a pending row, never a lost event
- [ ] A drain pass delivers pending events with bounded retry and records per-channel outcomes
      truthfully (SENT only when sent)
- [ ] A rolled-back dispatch writes no outbox row (preserves the existing "never announce a
      rolled-back plan" invariant, `batch-assignment.service.ts:56-57`)
- [ ] Redelivery is idempotent for the recipient (no duplicate in-app rows for one event)
- [ ] The remaining `Logging*Notifier` post-commit sites are audited; each is either routed through
      the outbox or documented why not

## Dependencies / notes

- Coordinate with **#76** (spine adoption — the outbox is what its adapters should drain from) and
  **#140** (consumes this mechanism). Independent of any HITL account setup — buildable now.
- No Redis/BullMQ: Postgres is the queue, consistent with the platform's no-new-infra posture.
