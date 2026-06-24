# 03 — Notifications & audit-trail spine

Status: ready-for-human
Type: HITL

## What to build

The cross-cutting notification delivery system and the user-facing audit trail viewer. Two delivery models: **general notifications** follow a fallback chain (mobile push → SMS → WhatsApp → email) with the in-app notification always firing; **SE Acceptance confirmation** delivers WhatsApp Confirmation as a first-class channel (displayed as "sent", not "attempted") in addition to in-app push. Per-role in-app notification lists (new assignments, SLA warnings, verification failures, component approvals, batch status changes, recovery decisions, leave decisions). A reusable audit-trail viewer that renders the full chain for any Ticket (Recommendation → BatchApproved → SEAccepted → OnSite → Closed, intra-day retry chains, `closure_type` + reason).

HITL because FCM/APNs, the WhatsApp Business API account, and SMS/SMTP gateways require external account setup and (for WhatsApp) message-template approval.

## Acceptance criteria

- [ ] In-app notification always fires for every notifiable event, per role
- [ ] General notifications follow push → SMS → WhatsApp → email fallback chain
- [ ] WhatsApp Confirmation is a first-class (non-fallback) channel for SE Acceptance events, shown as "sent"
- [ ] Push delivered via FCM (Android) / APNs (iOS), including quick-action Accept/Decline payloads
- [ ] Audit-trail viewer renders the full transition chain for any Ticket with actor, role, timestamp
- [ ] `acted_as_role` is visible in the trail where applicable

## Blocked by

- #01
