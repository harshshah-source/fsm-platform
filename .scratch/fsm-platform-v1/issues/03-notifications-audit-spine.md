# 03 — Notifications & audit-trail spine

Status: accepted
Type: HITL

## What to build

The cross-cutting notification delivery system and the user-facing audit trail viewer. Two delivery models: **general notifications** follow a fallback chain (mobile push → SMS → WhatsApp → email) with the in-app notification always firing; **SE Acceptance confirmation** delivers WhatsApp Confirmation as a first-class channel (displayed as "sent", not "attempted") in addition to in-app push. Per-role in-app notification lists (new assignments, SLA warnings, verification failures, component approvals, batch status changes, recovery decisions, leave decisions). A reusable audit-trail viewer that renders the full chain for any Ticket (Recommendation → BatchApproved → SEAccepted → OnSite → Closed, intra-day retry chains, `closure_type` + reason).

HITL because FCM/APNs, the WhatsApp Business API account, and SMS/SMTP gateways require external account setup and (for WhatsApp) message-template approval.

## Acceptance criteria

- [x] In-app notification always fires for every notifiable event, per role
- [x] General notifications follow push → SMS → WhatsApp → email fallback chain
- [x] WhatsApp Confirmation is a first-class (non-fallback) channel for SE Acceptance events, shown as "sent"
- [~] Push delivered via FCM (Android) / APNs (iOS), including quick-action Accept/Decline payloads *(chain + payload `metadata` built; actual FCM/APNs send is the deferred external seam — needs accounts)*
- [x] Audit-trail viewer renders the full transition chain for any Ticket with actor, role, timestamp
- [x] `acted_as_role` is visible in the trail where applicable

## Blocked by

- #01

## Disposition

**Accepted — internal spine + audit viewer built; external delivery is the deferred HITL seam (2026-06-27).**
13 e2e (4 spine + 4 in-app + 5 audit-trail), full suite **186 files / 650 passed**, `tsc` clean. Scope
confirmed with the user (Option 1): build the complete spine; **do not** retrofit existing per-feature
notifiers (→ follow-up). The HITL blocker (FCM/APNs/WhatsApp/SMS/SMTP accounts + WhatsApp template approval)
is isolated behind one seam.

- **Migration** `20260627140000_add_notifications` (additive; +`NotificationChannel`/`NotificationDeliveryStatus`
  enums + `notifications` + `notification_deliveries`).
- **`NotificationService.notify`** (`src/notifications/`): one Notification per recipient — the **in-app
  channel always fires** (AC#1). GENERAL → push→SMS→WhatsApp→email **fallback chain**, stop at first SENT,
  rest ATTEMPTED (AC#2). SE_ACCEPTANCE → in-app + **first-class WhatsApp** recorded SENT, shown as "sent"
  (AC#3). The actual external send is the `NotificationChannelGateway` **seam** (default `LoggingChannelGateway`
  = external UNAVAILABLE until accounts land); FCM/APNs push payload travels in `metadata` (AC#4 chain +
  payload built; real send deferred).
- **In-app list/read** (`/api/notifications`): the signed-in user's own notifications (newest-first, unread
  filter + unread count) + mark-one-read / mark-all-read (own only; another user's → 404).
- **Audit-trail viewer** (`/api/audit-trail/tickets/:id`, `AuditTrailService`): merges `ticket_events`
  (state transitions + `closure_type`/reason) with the ticket's `audit_logs` actions into one time-ordered
  chain with actor / role / **`acted_as_role`** (AC#5/#6). Manager roles; ZM zone-scoped (out-of-zone → 404).

**Deferred → follow-up #76:** rewire the existing per-feature notifier seams (day-plan, recovery, install,
customer-confirmation, component-request, escalation) to route through `NotificationService`, and add the
real external channel adapters (FCM/APNs/WhatsApp/SMS/SMTP) once accounts + templates exist.
