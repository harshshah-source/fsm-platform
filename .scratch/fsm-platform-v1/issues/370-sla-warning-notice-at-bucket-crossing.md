# 370 — SLA-warning notice when a ticket crosses an SLA bucket

Status: `ready-for-agent` — filed 2026-09-04 as the one PRD notification event #361 did not cover.

**Blocked by:** nothing (#337 and #338 both landed). **Parent slice:** [#361](./361-notification-producers-prd-events.md)

## Why this exists

#361 built producers for eight PRD notification events. **This is the ninth, and the only PRD event
still without a producer.** It was named in the issue and in plan §4 but was absent from the
executing brief's event list, and it belongs at the ticket SLA recompute — outside the file set #361
owned, so it was correctly reported rather than reached for.

The gap matters because an SLA warning is the one notice whose *whole value is being early*. Every
other event in #361 tells somebody that a thing has happened; this one tells them a thing is about
to. Delivered after the crossing it is a report, not a warning, and the person it was for has
already lost the time it existed to give them.

## Acceptance criteria

- [ ] When a ticket crosses into a warning band on the SLA recompute, one notice is produced for
      the role that can still act on it (the assigned SE if assigned; the zone's ZM if not — confirm
      against PRD before building).
- [ ] The notice is enqueued via #338's helper **inside the recompute's own transaction**, matching
      every producer #361 built. `docs/progress/338-durable-notification-outbox.md` is the pattern.
- [ ] **Deduplicated per (event, ticket, bucket)** — not per day. A ticket crossing one band must
      warn once; the same ticket crossing the *next* band down is a new, louder fact and must warn
      again. This is the one place #361's per-day key is the wrong shape, so do not copy it blindly.
- [ ] A ticket that is resolved before the recompute runs produces no notice.
- [ ] Pinned by running the recompute twice: two crossings of one band, one notice.

## Notes for whoever takes it

- The producer belongs at the ticket SLA recompute (`device-state` / ticket SLA service per plan §4)
  — find the real path first; #361 found two of its own issue's paths stale.
- Reuse `PRD_NOTICE_TYPES` in `apps/backend/src/notifications/prd-event-notice.ts` rather than
  inventing a type string: the mobile tap-router and the admin tray both switch on `type`, and an
  unknown one lands in whatever their `default` branch does.
- **Rig trap #361 paid for:** a plain `Proxy` on `PrismaService` does **not** reach inside
  `$transaction`, so an atomicity test written that way passes the mutation straight through and
  proves nothing. Use `test/fixtures/outbox-crash-injection.ts`, which wraps the transaction client.
- `notifier-adoption-wiring.e2e-spec.ts` is where the per-event cases live.
