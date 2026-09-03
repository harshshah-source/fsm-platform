# 337 — Push delivery exit behind the existing gateway seam
Status: done 2026-09-03 — report docs/progress/337-push-delivery-exit-fcm-gateway.md
Type: AFK
Type: AFK (build the seam) + HITL (FCM credentials — external provisioning)
Wave: 1 · Severity: P1 · Found by: module-gaps survey 2026-09-02, verified against the working tree 2026-09-03 (`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4)

## Problem

`LoggingChannelGateway.deliver` returns `'UNAVAILABLE'` unconditionally
(`notifications/notification-channel.gateway.ts:35-40`) and is the only implementation bound
(`notifications.module.ts:18`). The outbox, the in-app rows and the `device_tokens` table
(`schema.prisma:225`) all exist; nothing ever leaves the server. Five modules bottom out here —
scheduling, intraday, cross-zone, inventory and tickets all write notices that never reach a device.

The survey's SCH-01 ("SE never told of a changed day plan") was falsified by the survey itself — the
outbox is written in-tx at `batch-assignment.service.ts:521` and at 7 `override.service.ts` sites.
The residual is exactly this dead push exit (plan §1).

## Current code

- `notifications/notification-channel.gateway.ts:35-40` — `LoggingChannelGateway.deliver` returns
  `'UNAVAILABLE'` unconditionally
- `notifications.module.ts:18` — the logging gateway is the only bound implementation
- `schema.prisma:225` — `device_tokens` table exists
- `device-token.service.ts` — no `findForUser`
- `notification.service.ts:168-175` — per-channel result handling; nothing records a provider
  message id or error
- `notification-seam.ts:47-60` — the #218c assertion currently says "must be the logging gateway"
- `.env.example` — no push-provider switch

## What to build

- New `notifications/fcm-channel.gateway.ts` — FCM HTTP v1 adapter with service-account auth;
  sends `{title, body, data:{type, entityId}}`
- `notifications.module.ts:18` — env-switched provider: `PUSH_PROVIDER=fcm|logging`, default
  `logging`
- `device-token.service.ts` — add `findForUser`
- `notification.service.ts:168-175` — per-channel result; write the provider message id / error
  onto `notification_deliveries`
- `notification-seam.ts:47-60` — the #218c assertion becomes "no real provider unless explicitly
  configured", not "must be the logging gateway"
- `.env.example` — document `PUSH_PROVIDER`
- Expected behaviour: with a token row and `PUSH_PROVIDER=fcm`, `notify()` delivers a push and
  records `SENT`; without a token the PUSH channel returns `UNAVAILABLE` and the chain continues
  exactly as today
- External: FCM project credentials are HITL provisioning — build the seam (CLAUDE.md "build the
  seam" applies). Mobile token registration stays #89 (excluded — mobile)

## Acceptance criteria

- [x] AC1 — the FCM adapter sends `{title, body, data:{type, entityId}}` and maps HTTP 200 → SENT;
      404/410 (stale token) → FAILED + token row deleted; 5xx → FAILED with retry left to the outbox
- [x] AC2 — default binding unchanged (logging), so every existing test passes untouched
- [x] AC3 — seam assertion rewritten and its e2e updated
- [x] AC4 — `notification_deliveries` carries `providerMessageId` / `error`
- [x] AC5 — no SMS/WhatsApp/email adapter is added (those channels stay UNAVAILABLE)

## Verification

e2e with an injected HTTP stub for FCM asserting the SENT / FAILED / stale-token paths;
`notification-seam-assertion` e2e; manual: one real push to a test device once credentials exist.

## UI surfaces

n/a (backend only)

## Reference

n/a

## Blocked by

- #336 (to walk the SE side)
- External: FCM project credentials (HITL provisioning — does not block building the seam)

## Absorbs / supersedes

- survey ids: NOTIF-01, INTRA-G1, INV-G7, SCH-01 residual
- existing issues: #89 backend half, #76 adapter half (close into this slice when it lands; the
  mobile token-registration half of #89 stays excluded)

## Downstream

361 (notification producers) depends on this and 338 (plan §3).
