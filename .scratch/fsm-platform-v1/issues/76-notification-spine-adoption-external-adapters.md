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
