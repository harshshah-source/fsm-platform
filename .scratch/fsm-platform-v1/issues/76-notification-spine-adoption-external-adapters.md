# 76 — Notification spine adoption + external channel adapters

Status: ready-for-human
Type: HITL

## Context

Issue 03 built the notification **spine** — `NotificationService` (in-app always-fires + push→SMS→WhatsApp→
email fallback chain + first-class SE-Acceptance WhatsApp), the in-app list/read endpoints, and the
audit-trail viewer — over a single external-delivery seam (`NotificationChannelGateway`, default
`LoggingChannelGateway`). Two things were deliberately left out of #03 (user-confirmed Option 1):

1. **Adoption** — the existing per-feature notifier seams still fire into their own `Logging*Notifier`
   stubs instead of the central spine.
2. **External adapters** — no real FCM/APNs/WhatsApp/SMS/SMTP delivery (HITL: accounts + WhatsApp template
   approval).

## What to build

1. **Rewire the per-feature notifier seams to `NotificationService.notify`** — `day-plan-notifier`,
   `recovery-notifier`, `install-notifier`, `customer-confirmation-notifier`, the component-request
   notifications, and `repeat-escalation`. Each event maps to a notification `type` + recipients + role +
   delivery model (SE-Acceptance events use `SE_ACCEPTANCE`). Preserve each existing contract; the
   `Logging*Notifier` defaults can delegate to the spine.
2. **Real external channel adapters** behind `NotificationChannelGateway` — FCM (Android) / APNs (iOS) push
   incl. quick-action Accept/Decline payloads, WhatsApp Business, SMS, SMTP. Each reports SENT/FAILED so the
   fallback chain resolves correctly. Includes a **device push-token registration endpoint**
   (`POST /api/notifications/device-token`, SE-bound; clear on logout) consumed by the mobile push client (#89).
3. Per-role notifiable-event coverage audit (new assignments, SLA warnings, verification failures, component
   approvals, batch status changes, recovery decisions, leave decisions) — ensure each fires the spine.

## Acceptance criteria

- [ ] Every existing per-feature notifier routes through `NotificationService` (in-app always fires)
- [ ] FCM/APNs push adapter delivers, incl. Accept/Decline quick-action payloads
- [ ] Device push-token registration endpoint (`POST /api/notifications/device-token`) registers/clears an SE's token (consumed by #89)
- [ ] WhatsApp / SMS / SMTP adapters deliver; fallback chain resolves on real SENT/FAILED
- [ ] All listed per-role notifiable events produce a notification

## Blocked by

- #03 (done)
- external account setup (FCM/APNs, WhatsApp Business + template approval, SMS/SMTP) — HITL

## Comments

### 2026-07-28 — mobile-readiness extension (docs/status/backend-mobile-readiness-plan-2026-07-28.md §A-§6)

Re-verified: the gateway seam still has no adapter (`notification-channel.gateway.ts:35-41` returns
`'UNAVAILABLE'`); this issue's device-token registration AC is confirmed as the right owner for the
registry endpoint. Two additions:

1. **Durable outbox requirement.** Day-plan dispatch fires its notifier post-commit, in-process,
   with no outbox (`batch-assignment.service.ts:55-57, 232-234`) — a crash between commit and the
   notify loop loses the event silently (same family as #140). Rewiring per-feature notifiers into
   the spine (item 1 here) does not fix that; add an outbox (or re-scan driver) AC so a push a
   mobile SE depends on survives a crash.
2. **Token-table schema is decision-blocked.** `platform` column (HITL D1: FCM-only vs +APNs),
   one-row-per-user vs per-device (HITL D4, must match #91's `refresh_tokens` device model),
   last-seen/invalidation handling. Decide D1/D4 before the migration is written.

Mobile context: push-triggered refetch is the structural answer to the 1,000-poller load (plan doc
§C fix ranking) — this issue plus #89 is preferred over any WS/SSE seam, which stays deliberately
unbuilt.

### 2026-07-28 — payload decision settled, plus two live UUID-leak bugs

**Ticket number in the WhatsApp payload — settled: add `ticketNo` to `metadata` alongside
`entityId`.** Additive and non-breaking; `entityId` stays the entity-resolution key used for
deep-links. The rejected alternative — resolving the number at send time inside the adapter —
would couple the adapter to the ticket table, which is precisely what this issue's gateway seam
exists to avoid.

**Sequencing (not a date):** `#161` mints `ticketNo` → the notify call sites add it to `metadata` →
**this issue's adapters consume it**. The decision had to precede adapter design; it now has. Do not
design the WhatsApp payload before `ticketNo` exists.

**Two live UUID-leak bugs, folded in here** (same class, both user-visible today, both independent
of `ticketNo`):

1. `intraday-insertion.service.ts:214` — the SE-Acceptance confirmation body is
   `` `Ticket ${ins.ticketId} added to your Day Plan.` ``, so the message reads *"Ticket
   3f7a-…-… added to your Day Plan."* Required to carry the **Ticket number** by workflow:1461 and
   PRD:228.
2. `intraday-insertion.service.ts:477,:482` — the ghost notification interpolates the routed-to
   SE's **UUID** into user-visible text (`` `routed to ${nextSeId}` ``) where PRD:547 requires
   "[SE Name]". `_now` is also accepted and discarded at `:476`, so neither `offeredAt` nor
   `routedAt` reaches the client.

Both body templates can be fixed **before** `ticketNo` lands (fall back to plant/vehicle context and
a resolved SE name); the `ticketNo` field is the follow-on. Folding these here rather than filing
separately because they are notification-payload defects and this issue owns that surface.

### 2026-07-28 — WhatsApp delivery address: the column already exists

Closing a question raised while settling D-2. WhatsApp is a **first-class channel** for the
SE-Acceptance Confirmation (CONTEXT §16), so the adapter needs a number to send to. It has one:
**`User.phone`** — `String @unique`, non-null (`schema.prisma:136`) — and `EngineerMaster` defers to
it explicitly (*"SE identity + contact (name/phone/email) live on `users`"*), so an SE is reachable
via their `users` row with no join gymnastics and **no new column**.

**No new issue.** The datum is a *human contact* field and is unrelated to session/device binding
(**#91**'s `refresh_tokens.device_id`) and to the push-token registry this issue owns — a device can
hold a session with push disabled, and a push token can go stale while the number is fine. Its only
other consumer is **#161**, which must expose it on `/api/me` for the Profile screen.
