# 140 — Cross-zone auto-escalation sweep: non-atomic escalation/audit/notify orphans the notification, and the ticket is excluded from re-sweep

Status: needs-triage
Type: backend defect (latent — needs a notify throw mid-sweep)

> Source: `docs/audits/pattern-tracing-audit-2026-07-21.md` **NEW-A5**.

## Pattern

Pattern 2 — three related writes (escalation row, audit row, notification) are issued as independent
awaits with **no transaction and no per-ticket try/catch**; a partial failure leaves the escalation
without its notification, and the sweep's idempotency filter then excludes the ticket from ever being
re-processed.

## Where

`cross-zone/cross-zone-escalation.service.ts:95-111` — per qualifying Platinum ticket:
`crossZoneEscalation.create` (`:95`) → `auditEscalation` (`:106`) → `notifyCrossZoneQueue` (`:110`),
three independent awaits, no `$transaction`, no per-ticket catch. Idempotency is the WHERE clause
`crossZoneEscalations: { none: {} }` (`:79`) — "ticket has no escalation at all."

## What happens

If `notifyCrossZoneQueue` (or the audit write) throws for ticket *N*, the exception propagates out of
`sweepAutoEscalations` and is swallowed by the scheduler's `runGuarded` catch
(`business-sweep-scheduler.service.ts:135-137` — the known **NEW-4** silent-sweep-failure hole). Ticket
*N* already has its escalation row committed (`:95`) but **no notification**. On the next sweep the
`none: {}` filter now **excludes** *N* (it has an escalation), so the notification is **never** retried.
The CSM's notification shade silently misses a Platinum cross-zone escalation. (The queue *read*
`listForScope` still shows the row — which is why this ranks below #139.)

## Trigger

Any throw from the notification or audit write mid-sweep (a bad recipient row, an FK hiccup, a downstream
notifications bug) after `BUSINESS_SWEEPS_ENABLED=true`.

## Confirmation on the dev DB (2026-07-21)

Read-only (`scratchpad/confirm2.cjs`, uuid/text cast corrected).

- **Escalations without their notification** — auto/manual escalations with no matching
  `notifications` row (`entity_type='ticket' AND entity_id=cze.ticket_id::text AND type IN
  ('CROSS_ZONE_AUTO_ESCALATION','CROSS_ZONE_MANUAL_FLAG')`) → **0 rows**.
- Consistent with #139's `total escalations = 0` on dev.

**Verdict:** LATENT — no orphaned notification exists on dev today (0 escalations), but the structure
guarantees it: once the escalation row is committed, the `none: {}` filter removes the ticket from every
future sweep, so a failed notification is unrecoverable by the sweep itself.

## Blast / likelihood

- **Blast:** one un-notified Platinum escalation per failure; bounded, and softened because the queue
  read still surfaces the row (so it is not fully invisible).
- **Likelihood post-activation:** LOW.

## Proposed fix approach (for triage, NOT built here)

1. Wrap `create` + `auditEscalation` in one `$transaction`.
2. Make notification delivery **retryable and decoupled** from the idempotency gate: drive it off a
   durable outbox, or re-scan for escalations lacking a notification, rather than gating solely on
   `none: {}` — so a notification failure cannot be masked by the "ticket already has an escalation"
   filter.
3. Add a per-ticket try/catch so one ticket's failure does not abort the rest of the sweep (compounds
   with fixing NEW-4 / #133-adjacent sweep-ledger work).

## Acceptance criteria (draft — triage owns)

- [ ] A notification failure during the sweep does not permanently prevent that escalation's
      notification from being (re)delivered.
- [ ] One ticket's failure mid-sweep does not abort escalation of the remaining tickets.

## Dependencies / notes

- Gated by `BUSINESS_SWEEPS_ENABLED` (sweep off today). Related: **NEW-4** (silent sweep failure hides
  this), #126 (orphan-state family). No fix in this session (audit → triage contract).
