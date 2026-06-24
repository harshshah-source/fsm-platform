# 29 — Intra-day CRITICAL insertion + SE Accept/Decline + WhatsApp

Status: ready-for-agent
Type: AFK

## What to build

The system-triggered intra-day insertion and SE Acceptance flow. When a new Ticket enters the CRITICAL or HIGH_CRITICAL bucket, a Qualifying Event fires an Intra-day Re-plan: the Ticket is offered to the best candidate SE and an in-app push (with notification-shade quick-action Accept/Decline) is sent. The Intra-day Queue (`/intraday`) shows the row (type `SYSTEM_CRITICAL`): Ticket, company, bucket, SE offered, offered_at, status (`PENDING_ACCEPTANCE` / `ACCEPTED` / `TIMED_OUT` / `DECLINED`). **Accept** (one tap) → assignment committed, Ticket appears at top of Day Plan badged `CRITICAL INSERTION`, and a first-class **WhatsApp Confirmation** is sent carrying ticket number, vehicle, plant, expected component, and a deeplink ("WhatsApp Sent" chip on the queue row). **Decline** → mandatory reason code (AT_CAPACITY / TRAVEL_TOO_FAR / VEHICLE_TROUBLE / OTHER); system reroutes (retry chain handled in #30). SE Acceptance is required **only** for these urgent same-day insertions, not for normal batch work.

## Acceptance criteria

- [ ] CRITICAL/HIGH_CRITICAL entry fires a Qualifying Event and offers the Ticket to the best candidate
- [ ] In-app push with notification-shade Accept/Decline quick actions delivered
- [ ] Accept commits the assignment and inserts the Ticket at top of Day Plan badged `CRITICAL INSERTION`
- [ ] WhatsApp Confirmation sent on Accept with ticket/vehicle/plant/component + deeplink; shown as "sent"
- [ ] Decline requires a reason code and triggers reroute
- [ ] Intra-day Queue reflects PENDING_ACCEPTANCE / ACCEPTED / DECLINED status in real time

## Blocked by

- #25
- #03
