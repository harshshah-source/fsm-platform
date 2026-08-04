# 209 — Mobile build pipeline: produce an installable build and get it onto a handset

Status: ready-for-agent (build config) · ready-for-human remainder: distribution channel (owned by [#170](./170-mobile-release-upgrade-mechanism.md))
Type: AFK · Mobile · Build/environment
Parent: [#197](./197-mobile-pilot-readiness-remediation-epic.md) · Filed 2026-08-04
Blocked by: nothing

## Root cause

The mobile app has never been built as a native artifact. Every mobile issue to date shipped against
Jest and `tsc`, which validate JavaScript but never exercise autolinking, Gradle, or a real device —
so the app is simultaneously feature-complete and un-runnable. The JS bundle itself is fine (proven
below); what is missing is the native project, a way to reach the backend from a handset, and one
dependency at a version the installed SDK does not expect.

## Findings closed

Audit 1: **A-1** (no native build config), **A-2** (API URL/networking), **C-5** (release cleartext).
New: **N2** (netinfo SDK mismatch), **N3** (no error boundary).

## Evidence — verified 2026-08-04

- **The JS bundle builds clean.** `npx expo export --platform android` → exit 0, 1,036 modules,
  2.77 MB Hermes bundle, zero errors. So this issue is about the native shell, not the code.
- No `apps/mobile/android/`, no `apps/mobile/ios/`, no `eas.json`, no `apps/mobile/.env` (all
  verified absent). No native build has ever been produced.
- **Expo Go cannot run this app**: `react-native-keychain@10.0.0` ships `android/` and `ios/` native
  directories and is not in Expo Go's binary; `tokenStore.ts:1` calls it on the login path. A
  development build or standalone APK is mandatory.
- Toolchain is present on the dev machine: Android SDK at `%LOCALAPPDATA%\Android\Sdk`, `adb` on
  PATH, JDK 21 via Android Studio. **The Gradle build itself is UNTESTED** — running it generates
  `apps/mobile/android/`, which was out of scope for a report-only audit.
- `apps/mobile/src/api/client.ts:92` — `BASE_URL` defaults to `http://10.0.2.2:3000/api/v1`, the
  Android **emulator's** host alias. On a physical handset it routes nowhere.
- **`@react-native-community/netinfo@12.0.1` — SDK 54 expects `11.4.1`** (`npx expo install --check`,
  run 2026-08-04). A major-version mismatch on a native module, and it is the module backing
  `connectivity.ts:1` — i.e. the app's entire offline detection. Also `expo@54.0.35` vs `~54.0.36`
  (trivial). See [[feedback_expo_dependency_versions]]: `pnpm add expo-*` resolves versions the SDK
  does not expect; `npx expo install --check` is the gate.
- No `expo-build-properties` and no `usesCleartextTraffic` anywhere — Android blocks cleartext
  `http://` in **release** builds by default, so a signed release APK cannot talk to an http backend.
  Debug/dev builds are unaffected.
- No error boundary exists in `apps/mobile` (zero `ErrorBoundary`/`componentDidCatch` hits; admin has
  none either). An unhandled render throw white-screens the app with no in-app recovery.

## Scope

**In:** align dependency versions to the SDK; produce a working Android development build installed
on a physical handset; make the backend reachable from that handset in a documented, repeatable way;
add a root error boundary; write the whole thing down as a runbook.

**Out:** iOS (D1 settled FCM/Android-only for v1, `#76:113-116`). OTA updates (excluded by D-10).
The distribution channel — sideload vs MDM vs store internal track — is **[#170](./170-mobile-release-upgrade-mechanism.md)'s
open question with an owner still needed**; this issue produces a build, not a distribution story.
Signed release builds: out until the channel is chosen (and note the cleartext constraint bites there,
not on dev builds).

## Acceptance criteria

- [ ] `npx expo install --check` reports no outdated dependencies
- [ ] A development build installs and launches on a physical Android handset
- [ ] From that handset, the login screen reaches the backend and `se.north@fsm.test` authenticates
      successfully — proving DNS/firewall/URL end-to-end, not just that the app starts
- [ ] The API base URL is configurable without a code edit (`EXPO_PUBLIC_API_URL`, documented for both
      the LAN and `adb reverse` routes)
- [ ] A root error boundary renders a recoverable screen instead of a white screen on a render throw
- [ ] A runbook exists (`docs/runbooks/` or the issue itself) covering: dependency check → build →
      install → backend reachability, including the Windows Firewall inbound rule for port 3000
- [ ] The runbook states the release-build cleartext constraint and what will have to change (HTTPS
      or `expo-build-properties`) before a signed build can talk to a non-TLS backend

## Verification

```bash
cd apps/mobile
npx expo install --check                 # must report no outdated dependencies
EXPO_PUBLIC_API_URL=http://<LAN-IP>:3000/api/v1 npx expo run:android   # handset on USB
# then, on the handset: log in as se.north@fsm.test / correct-password
adb logcat | grep -i "fsm\|fetch\|network"   # confirms the request left the device
```

## Risk if deferred

Nothing about this app can be validated. Every mobile issue closed to date has been verified only
against Jest and `tsc` — neither of which exercises autolinking, native permissions (camera,
location), the keychain, or a real network. The longer this waits, the more mobile work is marked
done on evidence that cannot detect a whole class of native failure. The netinfo mismatch is the
concrete example already sitting in the tree.

## Size estimate

M — mostly mechanical, but the first Gradle run on a new project is the usual source of surprises,
and the netinfo downgrade needs a regression check on `connectivity.test.ts` + `writeQueue.test.ts`.
