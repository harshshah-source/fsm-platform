# 89 — SE mobile Push Notifications (device-token registration + handlers + tap-routing)

Status: ready-for-agent
Type: AFK · Mobile
Blocked-by-external: notification channel adapters (#76)

## What to build

The mobile push pipeline: device push-token registration on login, foreground/background push handlers,
and tap-routing into the relevant entity. This is the **mobile client** half of push delivery; the
server-side FCM/APNs adapters are Issue 76. Until #76 + a token-registration endpoint exist, the app
falls back to in-app notifications (Issue 85) + state polling.

## Business rules (authority)

- PRD §725 (Notification Delivery — push → SMS → WhatsApp → email fallback chain; in-app always fires),
  §211 (All Roles — Notifications). ADR-0016 (SE-Acceptance WhatsApp). Specific push triggers already
  specified: day-plan-live (§508), plan-updated-by-ZM (§510/Issue 66), CRITICAL insertion offer (§543/
  Issue 77), install activation result (§564/Issue 71), Common-Kit-zero (§621/Issue 53).

## Acceptance criteria

- [ ] App registers a device push token on login and clears it on logout
- [ ] Foreground + background push handlers route a tapped push to its entity (ticket / day plan / insertion)
- [ ] Quick-action push for the CRITICAL insertion offer (Issue 77) — Accept/Decline from the shade
- [ ] Graceful fallback to in-app list (Issue 85) + polling when push is unavailable

## API contract (authority / dependency)

- **Token registration endpoint is owned by #76** (e.g. `POST /api/notifications/device-token`).
  Reference it; do not invent a separate one here.
- Push payloads carry `entityType`/`entityId` mirroring the in-app `NotificationListItem` shape (Issue 85).

## Permissions

- SERVICE_ENGINEER device tokens; a token is bound to the authenticated SE.

## Navigation

- Tap → entity route (Ticket Detail / Day Plan / Insertion prompt). Insertion quick-actions → Issue 77 endpoints.

## Offline / fallback behaviour

- No connectivity / push disabled → rely on Issue 85 in-app list + per-feature polling (e.g. Issue 71 activation poll).

## Edge cases & failures

- Token refresh re-registers. Revoked permission → fall back to in-app only; never block core flows on push.

## UI surfaces

- **Mobile:** push registration + handlers + shade quick-actions. Owned by this issue.
- **Admin:** n/a.

## Reference

- PRD §725; per-trigger references above.

## Tests (TDD targets — red first)

- Login registers a token; logout clears it (against the #76 endpoint contract).
- A tapped push routes to the correct entity; insertion quick-action calls #77 accept/decline.
- Push-unavailable path falls back to in-app list + polling.

## Blocked by

- #54
- #76 (notification channel adapters + device-token endpoint — HITL/external)
- #77 (insertion quick-actions), #85 (in-app fallback)

## Note on #53

- Issue #53 (push on Common-Kit-zero + Component-Blocked cross-link) is a **specific trigger** of this
  pipeline. It remains its own issue, re-scoped as blocked-by #76 + this issue. See INDEX.
