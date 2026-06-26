# 34 — Install lifecycle + verification + serial visibility

Status: done
Type: AFK

## What to build

The SE Install workflow and its verification. Install Tickets appear in the Day Plan with lifecycle SCHEDULED → ON_SITE → FITTED → ACTIVATED → CLOSED. SE marks ON_SITE, then FITTED via the Install Form: GPS device serial (mandatory), SIM serial (mandatory), installation photo (optional) → Ticket → ACTIVATED and GPS auto-verification begins (waits for the first valid ping post-fitment, tracking the new `device_id`). First valid ping → push "Installation verified — Ticket CLOSED". If no ping within the expected window → FAILED_ACTIVATION push so the SE can return or escalate. Warehouse Manager sees GPS + SIM serial numbers on Install Tickets to verify component usage. (Per LLD open item #5, no geofence is applied to the first post-fitment ping in v1 — no prior location known.)

## Acceptance criteria

- [x] Install lifecycle SCHEDULED → ON_SITE → FITTED → ACTIVATED → CLOSED enforced
- [x] FITTED captures mandatory GPS device serial + SIM serial (optional photo)
- [x] ACTIVATED triggers install verification tracking the new `device_id`
- [x] First valid ping closes the Ticket with a verified push; timeout sets FAILED_ACTIVATION with push
- [x] Warehouse Manager can see GPS + SIM serials on Install Tickets
- [x] No geofence applied to the first post-fitment ping (v1)

## Blocked by

- #33
- #18

## Disposition (done — backend slice, 2026-06-26)

Backend vertical slice complete and verified green (full backend suite **560/560**, `tsc` clean). Built
in an **isolated worktree** on branch `feat/issue-34-install-lifecycle` (base `78db5a5` + cherry-picked
#33), to keep the concurrent FE-enterprise-UI worktree untouched.

- **Migration** `20260626140000_add_install_lifecycle` (additive on `tickets`): `fitted_gps_serial`,
  `fitted_sim_serial`, `fitted_photo_ref`, `fitted_at`, `activated_at` (warranty anchor + verification
  anchor; `+ activated_at` index). No enum migration — all lifecycle states pre-existed in `ticket_status`.
- **`InstallLifecycleService`** (mirrors `RecoveryService`): `scheduleInstall` (REQUESTED→SCHEDULED,
  manager), `markOnSite` (SCHEDULED→ON_SITE, assigned SE), `markFitted` (ON_SITE→FITTED→ACTIVATED in one
  audited tx; GPS serial validated == `String(deviceId)`, SIM serial mandatory, photo optional;
  `fitted_at`/`activated_at` stamped), and `runInstallVerification` — a re-entrant sweep of ACTIVATED
  installs: first valid post-`activated_at` ping for the device → CLOSED + verified push (**no geofence**,
  LLD open item #5); no ping past the 24 h window → FAILED_ACTIVATION + push. A late ping still verifies.
  SYSTEM-audited, mirrors `VerificationService`'s ping-from-`raw_device_snapshots` posture.
- **`install-notifier.ts`** seam (Logging default + DI binding) for the verified / failed-activation
  pushes — swappable when the #03 notification spine lands (same pattern as `recovery-notifier`).
- **`InstallController`** additions: `POST /api/install/:id/schedule|on-site|fitted` (role-gated; SE
  assignment enforced in the service) + `GET /api/install/:id` exposing the GPS+SIM serials to the
  **Warehouse Manager** (AC#5). Outcome→HTTP: 404 / 409 / 403 / 400.

Tests: `install-lifecycle` (11), `install-verification` (5), `install-lifecycle-controller` e2e (4).

**Parity gate:** ACs are backend + SE-mobile-form-shaped. The SE mobile Install screens (on-site /
Install Form / activation-result) ride the existing mobile backlog — follow-up **#71** filed and linked
in INDEX (blocked by Mobile Foundation #54, same posture as the #68 Recovery mobile follow-up). No admin
UI is in scope (Install creation admin UI is #69; lifecycle is SE-field + WM-read).
