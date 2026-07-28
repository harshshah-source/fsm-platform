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
  verified-CLOSED and FAILED_ACTIVATION outcomes.

## Business rules (authority)

- PRD §558 Flow 6 (SCHEDULED → ON_SITE → FITTED → ACTIVATED → CLOSED; first valid post-fitment ping
  verifies → CLOSED; no ping → FAILED_ACTIVATION). Issue 34.

## Acceptance criteria

- [ ] On-site action posts to `/install/:id/on-site` from the Day Plan
- [ ] Install Form captures GPS + SIM serial (mandatory) + optional photo, posts to `/install/:id/fitted`, renders serial-validation errors
- [ ] Activation result surfaces verified-CLOSED and FAILED_ACTIVATION outcomes
- [ ] No backend change — consumes the Issue 34 endpoints as-is

## API contract (authority: backend on `main`, `@Roles('SERVICE_ENGINEER')`)

- `POST /api/install/:id/on-site` — no body (SCHEDULED → ON_SITE).
- `POST /api/install/:id/fitted` — body `{ gpsDeviceSerial, simSerial, photoRef? }`
  (`ticketing/install.controller.ts`, `FittedBody`) → FITTED → ACTIVATED.
- Activation outcome read: `GET /api/install/:id` (lifecycle state → CLOSED / FAILED_ACTIVATION).

## Validation & error codes

- `SERIAL_REQUIRED`, `INVALID_SERIAL` (400); `WRONG_STATE` (409); `NOT_FOUND` (404); `FORBIDDEN` (403) — surface inline.

## Activation result (no push dependency on the core path)

- Surface CLOSED / FAILED_ACTIVATION by **polling `GET /api/install/:id`** after fitment. The push
  notifications ("Installation verified — CLOSED" / "GPS ping not received") are an enhancement →
  depend on the notification spine (#03/#76); do NOT block this issue on them.

## Photo handling ⚠

- `photoRef` is an optional STRING reference, not a blob/multipart. The capture→ref step needs the
  media-upload endpoint (**#81 — Media Upload API**); block only the optional-photo AC on it.

## Permissions

- SE actions only. WM may read fitment serials (Issue 34 AC#5) — not part of this mobile screen.

## Offline behaviour

- on-site / fitted writes queue via Issue 17 when offline; activation-result polling resumes on reconnect.

## Edge cases & failures

- Missing serial → `SERIAL_REQUIRED`; bad serial → `INVALID_SERIAL`; acting out of state → `WRONG_STATE` (409).

## UI surfaces

- **Mobile:** Install Day-Plan card + on-site / Install Form / activation result. Owned by this issue.
- **Admin:** n/a (Install create UI is #69; lifecycle backend is Issue 34).

## Reference

- No mobile screenshot exists — build to PRD §558 Flow 6 (PRD-flow-driven; satisfies the parity gate).

## Tests (TDD targets — red first)

- fitted without serials → `SERIAL_REQUIRED`; with serials → ACTIVATED.
- Polling `GET /api/install/:id` surfaces CLOSED and FAILED_ACTIVATION outcomes.
- on-site out of state → `WRONG_STATE` handled.

## Blocked by

- #54 (Mobile Foundation)
- #34 (done)
- (optional-photo AC) #81 — Media Upload API

## Comments

### 2026-07-28 — data-needs spec (#172 D-9 closed; no mockup)

Full spec: `docs/status/se-screen-data-needs-2026-07-28.md` §2. **Best-served of the six** — the
expected GPS serial is genuinely readable (`InstallView.deviceId`, `install-lifecycle.service.ts:41`,
via the SE-callable `GET /api/install/:ticketId`, `install.controller.ts:216-229`).

Missing from `InstallView` (`install-lifecycle.service.ts:38-49`), all category (b): `vehicleNo` ·
`plantName` — **already joined and then discarded** at `:260-262` · `installSimId`
(`schema.prisma:2067`, the SIM the SE is meant to fit, with nothing to check `simSerial` against) ·
`deviceType` · `installNotes` + `installTargetDate` (`:2068-2069`) · transporter name/phone.

**The activation window needs two fields, and the client must not derive it.**
`INSTALL_ACTIVATION_WINDOW_MS` is a server constant (`install-lifecycle.service.ts:30`), *and*
expiry additionally requires the telemetry watermark to have advanced past `activatedAt` (`:236-239`).
A client computing `activatedAt + 24h` will show "overdue" while the server correctly holds the
ticket in `ACTIVATED`. Ship a server-computed **`activationDeadline`** plus a
**`verificationBlockedByStaleTelemetry`** flag — otherwise a ticket sits in `ACTIVATED` indefinitely
with nothing on screen explaining why.

**Error codes:** `SERIAL_REQUIRED` fires only for a blank **SIM** serial (`:127`); a blank GPS serial
falls through to `INVALID_SERIAL` (`:128`). This issue lists both without the mapping — pin it (#169).

**(d) gap:** no failure discriminator on `FAILED_ACTIVATION` — `failActivation` writes status only
(`:245-251`), so "no ping ever" and "window expired on stale telemetry" are indistinguishable, and
the SE has no next-step guidance (PRD:565 does not say what they should do either).

Photo leg still blocked on **#81** (no upload endpoint), now with slot semantics per #172 decision 6.
