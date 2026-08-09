# Mobile device readiness audit — running the SE app on a physical Android phone

Date: 2026-08-04 · Point-in-time assessment (source-verified, not derived from issue files).
Every claim is labelled **OBSERVED** (cited `file:line` or a live command/query run today) or
**INFERRED** (reasoned from known platform behavior, untested here).

**Headline:** the app is real, it builds, the backend is up, and a login works end-to-end today —
but there is no native Android project yet (no installable APK has ever been produced), the API URL
defaults to an emulator-only address, the dev database is one migration behind the code, and the
only SE who can log in has zero data. Every hard blocker is a setup/environment task; **none of
them are filed as issues.**

---

## PART 1 — What actually exists in apps/mobile

The "auth shell only" description in CLAUDE.md is badly stale.

### Navigation

OBSERVED: expo-router is only a one-route shell (`app/index.tsx:1-5` renders `AppEntry`). Real
flow: `src/auth/AppEntry.tsx:15-28` gates on session — no session → `LoginScreen`;
`SERVICE_ENGINEER` → `SeTabShell`; any other role → a debug `SessionScreen`.
`src/navigation/SeTabShell.tsx:99-113` is a bottom-tab navigator with 5 tabs: **Home, Tickets,
Stock, Vouchers, Profile**. Everything deeper (ticket detail, forms, notifications, leave,
availability) is local-component-state screen swaps, not a stack — no deep links, back is
per-screen buttons.

### Screens (21 `*Screen.tsx` files, all wired to real endpoints — no stubbed screens)

OBSERVED via grep of every `api*` call site:

| Screen | Endpoints / role |
|---|---|
| `HomeScreen` | `apiGetDayPlan` + `apiGetMyTickets` + `apiGetNotifications` (HomeScreen.tsx:48-52); KPI tiles, Notifications entry, offline badge |
| `TicketsScreen` | merged day-plan/pool list, urgency sections, #66 added/removed badges, #77 CRITICAL INSERTION badge |
| `TicketDetailScreen` | TROUBLESHOOT soft-state chain, RECOVERY card (#68), INSTALL card (#71) |
| Forms | Troubleshoot (+ full-screen 409 `ConflictScreen`), Collection, Unable-to-Collect, Install, Vehicle Unavailability, Voucher, Leave Request |
| `IntradayOfferScreen` | full-screen Accept/Decline gate, checked once at shell mount (SeTabShell.tsx:38-61) + ghost-assignment toast |
| `StockScreen` | van stock + component-request confirm receipt |
| `VouchersScreen`, `NotificationsScreen`, `LeaveRequestScreen`, `AvailabilityScreen`, `ProfileScreen` | all live; Profile links to Leave + Availability |

### Client scaffolding — now exists

- Data layer: typed fetch client (`src/api/client.ts`) with `@fsm/shared` contracts; `X-Device-Id`
  + `X-App-Version` on every request (client.ts:100-107).
- Auth storage: device keychain via `react-native-keychain` (tokenStore.ts:1-28); rehydrate on
  mount; refresh flow in `AuthProvider`.
- Location: `expo-location` best-effort ON_SITE capture, silent fallback (captureLocation.ts:8-19).
- Camera: `expo-image-picker` `launchCameraAsync` in Voucher form (VoucherFormScreen.tsx:49-55) and
  Install form (InstallFormScreen.tsx:38-43); real multipart upload to `POST /media/upload`
  (client.ts:273-295).
- Network state: NetInfo-backed connectivity source (connectivity.ts).
- Offline: `WriteQueue` exists but is **in-memory only** — durable persistence + batched sync flush
  are Issue #17, not built (writeQueue.ts:14-18). Kill the app with a pending write and it's gone.

### Still absent

- **No push client whatsoever** — no `expo-notifications`, no firebase dep, no device-token
  registration call anywhere in mobile source (OBSERVED: grep empty). The backend
  `POST /api/notifications/device-token` endpoint (built 2026-08-04) has no consumer — that's #89,
  blocked.
- **Troubleshoot photo capture not wired** — the form's own comment admits #81's upload API landed
  but the form was never connected (TroubleshootFormScreen.tsx:25-26). Voucher and Install photos
  work; Troubleshoot's 4 named slots don't exist on the screen. **No follow-up issue found.**

---

## PART 2 — Can it build and run

### It builds

OBSERVED: `npx expo export --platform android` completed exit 0 — 1,036 modules into a 2.77 MB
Hermes bundle, zero errors. Jest suite (45 files / 307 tests) and `tsc --noEmit` green same day.

### app.json is already fixed

OBSERVED: name "FSM Field Service", `android.package: "in.autoplant.fsm"` (app.json:3,16),
adaptive icons + splash configured. The "no android.package, named mobile" premise is stale.

### But no installable build has ever been produced

OBSERVED: no `android/` directory (never prebuilt), no `eas.json` (EAS never configured), no
`apps/mobile/.env`.

### Expo Go will NOT work

`react-native-keychain` is a native module not in Expo Go's binary — the first keychain call
(login) would crash. INFERRED from the dependency (tokenStore.ts:1) + Expo Go's known module set.
A **development build or standalone APK** is required. Two routes:

- **Local:** `npx expo run:android` with the phone on USB (prebuild + Gradle + install). Toolchain
  present on this machine — OBSERVED: Android SDK at `C:\Users\User\AppData\Local\Android\Sdk`,
  `adb` on PATH, JDK 21 via Android Studio. The Gradle build itself is **UNTESTED** (it generates
  `android/` in the repo).
- **Cloud:** `eas build -p android` — needs an Expo account and an `eas.json` that doesn't exist.

### Networking — the default URL cannot work on a phone

OBSERVED: `BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://10.0.2.2:3000/api/v1'`
(client.ts:92). `10.0.2.2` is the Android *emulator's* host alias; on a physical handset it routes
nowhere. Options:

1. **Wi-Fi:** build with `EXPO_PUBLIC_API_URL=http://<PC LAN IP>:3000/api/v1` (inlined at bundle
   time — env var on the build command or `apps/mobile/.env`). Backend listens on all interfaces
   (main.ts:29 `app.listen(PORT)`, no host — Node default, INFERRED), but **Windows Firewall will
   likely block inbound 3000** until an allow rule for node.exe is added (INFERRED, untested).
2. **USB, no firewall:** `adb reverse tcp:3000 tcp:3000` + build with
   `EXPO_PUBLIC_API_URL=http://localhost:3000/api/v1`. Only works while cabled.
3. **Cleartext trap:** Android blocks cleartext `http://` in **release** builds by default;
   debug/dev builds allow it. A signed release APK needs `expo-build-properties`
   (`usesCleartextTraffic`) or HTTPS. INFERRED from Android/Expo defaults.

### Credentials — one login works, verified live

OBSERVED: logged in against the running backend as `se.north@fsm.test` / `correct-password` →
HTTP 200 with real tokens. The dev DB has exactly **8** credential rows — the #91 fixture users —
and **exactly one is an SE**: se.north (auth-fixture-seed.ts:18,63-69 + live DB query). The other
**75** SERVICE_ENGINEER users (`se-z*@mock.fsm`, real names) have **no credentials** — they cannot
log in.

### The dev DB is one migration behind the code

OBSERVED: latest applied migration `20260804130000_transporter_contact_vu_fields`;
`20260804140000_device_tokens` (2026-08-04) **not applied** — `device_tokens` does not exist in
the dev DB. The currently running backend process is also stale code (live probe:
`POST /api/v1/notifications/device-token` → 404). Consequence, INFERRED from the wiring: restarting
the backend on current code **without** `prisma migrate deploy` makes device-token registration
500 and — worse — **logout 500** (`AuthService.logout` → `DeviceTokenService.clear` → missing
table). **Run `pnpm prisma migrate deploy` in apps/backend before the next backend restart.**
Filed nowhere.

### Seed data — the fatal mismatch

OBSERVED from live queries: se.north has **0** assigned tickets, **0** schedules, **0**
`se_coverage` rows, 0 van stock, 0 vouchers, 0 notifications. The `/me/tickets` pool branch is
scoped to covered plants (me-tickets-query.service.ts:39,74-79) — zero coverage → nothing. Every SE
endpoint probed live with se.north's token: **all 200, all empty**
(`me/tickets`, `schedules/me`, `me/van-stock`, `me/component-requests`, `notifications`,
`me/vouchers`, `me/leave-requests`, `me/availability`, `me/intraday-insertions`). Meanwhile the SEs
holding data (40–63 dispatched schedules/day through 2026-08-02) are the credential-less mock SEs.
No schedules exist for 08-03/08-04 at all.

---

## PART 3 — What you'd actually see

Install a dev build (with a correct API URL), open it:

1. **Login** — plain email/password. `se.north@fsm.test` / `correct-password` succeeds
   (live-verified). Any mock-SE email fails — no credential.
2. **Intraday gate** — brief blank "checking" frame, then straight through (no offers).
3. **Home** — "SE North / North" header, Notifications button with no badge, "Synced". Day plan:
   **"Your plan is being prepared — check back shortly."** (live response `dispatched:false`).
   KPI tiles all zero. Not an error — just nothing.
4. **Tickets** — empty sections with their empty-state texts. Nothing to tap.
5. **Stock** — empty stock list, "No component requests." Artifact: common-kit check returns
   `complete: true` on zero stock, so it may read "kit complete" while showing nothing.
6. **Vouchers** — empty list. **The one screen you can exercise for real today**: New Voucher →
   camera capture → real upload (`media_objects` exists in dev DB) → submit creates a real row.
7. **Profile** — Leave Requests (empty; submitting works, shows PENDING) and Availability (no rows
   → derives AVAILABLE; "Go Unavailable" performs a real write).
8. **Logout** — works against the currently running stale backend; **500s after a backend restart
   until the migration is deployed.**

Nothing should crash or 500 on the read path — every endpoint the app calls exists and returned
200 live. The app is honestly, uniformly empty.

---

## PART 4 — The gap list, ordered

### A. Blocks running it at all — all setup/environment tasks, none filed as issues

1. **No native build config** — never prebuilt, no eas.json. Fix: `npx expo run:android`
   (toolchain verified present; Gradle run untested) or set up EAS. *Setup task.*
2. **API URL** — build with `EXPO_PUBLIC_API_URL` = LAN IP (+ Windows Firewall inbound rule for
   3000), or `adb reverse` over USB. *Setup task.*
3. **Dev-DB migration lag** — `prisma migrate deploy` before the next backend restart, or
   logout/device-token 500. *Setup task, created by the 2026-08-04 #76 slice.*
4. **Credential/data mismatch** — either give se.north data (`se_coverage` rows + assigned
   tickets/schedule via admin UI or SQL) or mint a credential for a data-holding mock SE
   (`ensureCredential` in `credential-seed.ts` does exactly this; the fixture seed is deliberately
   not in `pnpm seed` — auth-fixture-seed.ts:15-16). *Setup task — the one that bites last, after
   everything else "works".*

### B. Runs but the screen is useless (data, not code)

- **Home/Tickets** — empty until a dispatch run produces a schedule for the SE you log in as
  (runs exist, but for mock SEs; none after 2026-08-02). No issue filed; ops/seeding gap.
- **Stock** — `se_van_stock` has zero rows fleet-wide; needs WM-side stock entry (#73 admin UI
  exists) or SQL seeding. No mobile issue.
- **Notifications** — 166 rows, none for se.north; will start populating for real once the
  restarted backend fires the newly-adopted spine notifiers (#76 slice, 2026-08-04).

### C. Works but degraded

- **No push** — #89 (blocked on FCM account, external) + no client code; everything is
  fetch-on-mount, no polling — data refreshes only on screen entry.
- **Troubleshoot photos not wired** (TroubleshootFormScreen.tsx:25) — **no follow-up issue found.**
  Voucher/Install photos work.
- **No durable offline** — in-memory WriteQueue only; persistence + batch sync = Issue #17 (open).
- **One-active-device (D-2/#91)** — logging in on the phone revokes any other session (e.g., a
  concurrently used emulator) and vice versa. By design; looks like random logouts if you run both.
- **Release APK + `http://` won't talk** (cleartext block) — dev builds only, until HTTPS or a
  build-properties override.

### D. Genuinely blocked on external accounts

- FCM/APNs provisioning (#76/#89), WhatsApp Business + template approval, SMS/SMTP (#76) — all
  HITL, unchanged.

---

## Shortest real path

```
cd apps/backend && pnpm prisma migrate deploy     # close the migration lag first
# restart the backend (picks up current code + device_tokens table)
# add Windows Firewall inbound allow rule for node.exe / port 3000 (Wi-Fi route)
cd apps/mobile
EXPO_PUBLIC_API_URL=http://<PC LAN IP>:3000/api/v1 npx expo run:android   # phone on USB, dev build
# log in: se.north@fsm.test / correct-password
```

…then fix the data problem (A4/B above) — the only step with no one-line answer: either seed
coverage + assignments for se.north, or mint a credential for a mock SE that already holds a
dispatched schedule.
