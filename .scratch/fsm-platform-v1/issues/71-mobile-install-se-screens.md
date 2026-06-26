# 71 — SE mobile Install screens (on-site / Install Form / activation result)

Status: ready-for-agent
Type: AFK · Mobile
Origin: Issue 34 parity follow-up (2026-06-26).

## What to build

The SE-facing mobile screens for the Install lifecycle whose backend + HTTP surface is built and green
in Issue 34 (`POST /api/install/:id/on-site`, `/fitted`, lifecycle REQUESTED→SCHEDULED→ON_SITE→FITTED→
ACTIVATED→CLOSED/FAILED_ACTIVATION). Blocked by **Mobile Foundation #54** (RN/Expo shell), same posture
as the #68 Recovery mobile follow-up — never silently deferred.

- **On-site** action on a SCHEDULED Install ticket in the Day Plan → `POST /:id/on-site`.
- **Install Form** (FITTED): mandatory GPS device serial + SIM serial inputs, optional photo capture →
  `POST /:id/fitted`. Surface the service's `INVALID_SERIAL` / `SERIAL_REQUIRED` validation inline.
- **Activation result**: after fitment the ticket is ACTIVATED and auto-verification runs; render the
  "Installation verified — Ticket CLOSED" success push and the `FAILED_ACTIVATION` "return or escalate"
  push when they arrive (consumes the #03 notification spine once live; until then the in-app state poll).

## Acceptance criteria

- [ ] On-site action posts to `/install/:id/on-site` from the Day Plan
- [ ] Install Form captures GPS + SIM serial (mandatory) + optional photo, posts to `/install/:id/fitted`, renders serial-validation errors
- [ ] Activation result surfaces verified-CLOSED and FAILED_ACTIVATION outcomes
- [ ] No backend change — consumes the Issue 34 endpoints as-is

## Blocked by

- #54 (Mobile Foundation)
- #34 (done)
