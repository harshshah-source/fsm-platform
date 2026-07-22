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
- [~] Audit-trail viewer renders the full transition chain for any Ticket with actor, role, timestamp *(**API only** — corrected 2026-07-22, see "Correction" below. The viewer UI is owned by follow-up [#145](./145-audit-trail-viewer-admin-surface.md).)*
- [~] `acted_as_role` is visible in the trail where applicable *(same — the API returns it; no UI renders it. → [#145](./145-audit-trail-viewer-admin-surface.md))*

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

---

## Correction 2026-07-22 — AC#5/#6 were checked on the strength of the API alone

*Appended, not rewritten. The disposition above stands: this issue remains **accepted**, and it is
**not** reopened — `docs/agents/issue-tracker.md` "accepted-with-follow-up" applies, since the core
objective (the notification spine + the audit-trail read model) was genuinely met.*

**Source:** `docs/audits/2026-07-22-adversarial-review-admin-backend.md` §4.4 (N2, `needs-changes`).

The two audit-trail acceptance criteria were marked `[x]` when only the backend existed:

- **What was built:** `GET /api/audit-trail/tickets/:ticketId` + `AuditTrailService` (merging
  `ticket_events` with `audit_logs`, carrying `acted_as_role`, ZM zone-scoped, out-of-zone → 404),
  covered by 5 e2e. That half is real and remains accepted.
- **What was never built:** any UI. `grep -ri "audit-trail|auditTrail|AuditTrail" apps/admin/src` →
  **zero hits** (verified 2026-07-22). This issue's own scope line (`:8`) promised *"a reusable
  audit-trail viewer"*, and the PRD grounds it as user story **73**.
- **And the last affordance was removed:** INDEX:92 records the footer's dead **"Audit Trail"** label
  being repointed to **Exports** — correct at the time, since it led nowhere, but nothing replaced it.

**Why this needed correcting rather than leaving.** CLAUDE.md's parity gate permits an unbuilt in-scope
UI AC only if **(a)** a follow-up is filed and linked in INDEX **and** **(b)** the deferral reason is an
external-integration blocker. (a) was absent; (b) does not apply — the endpoint is in this repo, and
CLAUDE.md states that "build the seam" covers external integrations, *not* admin pages over existing
endpoints. The legitimately deferred part of this issue was always the FCM/APNs/WhatsApp/SMS/SMTP
adapters (→ #76), and the viewer was swept along with that deferral in error.

**Now owned by [#145](./145-audit-trail-viewer-admin-surface.md)** (filed 2026-07-22, linked in
INDEX's Follow-ups section). AC#5 and AC#6 above are re-marked `[~]` — partial, API-complete,
UI-outstanding — which is the same convention already used for AC#4 (the FCM/APNs push seam).
