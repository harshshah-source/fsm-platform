# 209 — Mobile build pipeline: produce an installable build and get it onto a handset

Status: ready-for-human — build config done and the APK builds; **blocked on a physical handset**
for the two ACs that matter (install + login + session-survives-restart). Distribution channel
remains owned by [#170](./170-mobile-release-upgrade-mechanism.md).
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

- [x] `npx expo install --check` reports no outdated dependencies
- [ ] **BLOCKED — no handset available.** A development build installs and launches on a physical
      Android handset
- [ ] **BLOCKED — no handset available.** From that handset, the login screen reaches the backend and
      `se.north@fsm.test` authenticates successfully — proving DNS/firewall/URL end-to-end, not just
      that the app starts
- [x] The API base URL is configurable without a code edit (`EXPO_PUBLIC_API_URL`, documented for both
      the LAN and `adb reverse` routes)
- [x] A root error boundary renders a recoverable screen instead of a white screen on a render throw
- [x] A runbook exists (`docs/runbooks/` or the issue itself) covering: dependency check → build →
      install → backend reachability, including the Windows Firewall inbound rule for port 3000
- [x] The runbook states the release-build cleartext constraint and what will have to change (HTTPS
      or `expo-build-properties`) before a signed build can talk to a non-TLS backend

## Implementation notes — 2026-08-04/05 (NOT YET COMMITTED)

**Status: the APK exists and is well-formed; nothing has been verified on hardware.** `adb devices`
has been empty throughout, so the two ACs that carry the actual value of this issue are untouched.
Treat everything below as "compiles and packages", not "works".

### Build result

`./gradlew assembleDebug` → **BUILD SUCCESSFUL in 9m 45s**, 415 tasks.
`app/build/outputs/apk/debug/app-debug.apk`, 58.4 MB, `arm64-v8a` only, 22 native libraries.
Autolinking resolved every module — **`react-native-keychain` and `react-native-community_netinfo`
both compile and link**, which was the single biggest unknown. Whether the keychain *works* is still
unproven; that needs the handset.

### Dependencies

- `@react-native-community/netinfo` `12.0.1` → **`11.4.1`, pinned exactly (no caret)** — it backs
  `connectivity.ts`, which [#186](./186-mobile-auth-shell-no-session-persistence.md) depends on.
- `expo` `54.0.35` → `54.0.36`. `npx expo install --check` → "Dependencies are up to date."
- Regression: mobile suite **47 suites / 319 tests, all green** (was 46/313 before the error boundary).
  Note a first run immediately after the netinfo swap showed 5 failures from a cold Jest transform
  cache, and a run concurrent with a Gradle build showed 13 from 5s timeouts — both artefacts, both
  green on a clean re-run.

### The Windows path-length fight (the real cost of this issue)

Five separate failures, each hiding the next. **The root cause is that Android CMake 3.22.1 bundles
ninja 1.10, whose manifest does not declare `longPathAware`** — so it is hard-capped at 260
characters no matter what the registry says. The fix is `cmake;3.31.6` (ninja 1.12.1, which *is*
long-path aware), pinned in `android/build.gradle`.

Everything else is margin, and is kept because each was independently justified:

| Change | Where | Why |
|---|---|---|
| `LongPathsEnabled = 1` | machine registry (admin) | lifts the OS ceiling for aware processes |
| `-DCMAKE_OBJECT_PATH_MAX=1024` | `android/build.gradle` | CMake's own 250 check, ~1000 warnings without it |
| `buildStagingDirectory → C:/x/<module>` | `android/build.gradle` | moves `.cxx` off the deep pnpm path |
| `virtualStoreDir: C:/pv`, `virtualStoreDirMaxLength: 40` | `pnpm-workspace.yaml` | -31 chars on every native path |
| `reactNativeArchitectures=arm64-v8a` | `android/gradle.properties` | armeabi-v7a is 2 chars longer and overflowed; also ~4x faster |
| `cmakeVersion 3.31.6` | `android/build.gradle` | **the actual fix** |

Proven not to work, recorded in-file so nobody retries: relocating library modules' Gradle
`buildDir` (RN's `Android-autolinking.cmake` reads the *project* dir, not the build dir);
`nodeLinker: hoisted` (buys 24 chars where 60 were needed, and weakens dependency isolation
repo-wide). 175 of the 319 characters are immovable React Native structure — path shortening alone
provably cannot solve this.

### Decisions taken

- **`apps/mobile/android/` is tracked**, against the Expo CNG recommendation: a hand-applied native
  fix silently wiped by the next prebuild is worse than a noisy diff, and the `build.gradle` block
  above cannot be expressed as a config plugin. `expo prebuild --clean` is therefore banned in the
  runbook. Reproducibility comes from pinned versions (runbook §0), not regeneration.
- Reproducibility has a hole that cannot be closed in-repo: `LongPathsEnabled` and the CMake 3.31.6
  install are machine state. A fresh clone on a machine without them fails identically.

### Networking — both routes documented, neither verified on device

`apps/mobile/.env.example` carries all three, runbook §4 explains them:
- **`adb reverse tcp:3000 tcp:3000`** + `http://localhost:3000/api/v1` — recommended. No LAN IP, no
  Wi-Fi, **no firewall rule** (traffic never touches the inbound path).
- **LAN IP** — needs the host's DHCP Wi-Fi address *and* an inbound rule for TCP 3000. Verified that
  all three firewall profiles default inbound to Block and **no rule for 3000 exists**, so this route
  would fail as a timeout that looks exactly like a wrong URL. The rule command is in the runbook;
  it was not created (admin, and route A avoids needing it).
- Backend binding confirmed fine: `app.listen(3000)` is on `0.0.0.0` (`netstat` verified).

### Out of scope, raised not folded in

- **`android.permission.CAMERA` is missing from the generated manifest**, but
  `InstallFormScreen.tsx:43` and `VoucherFormScreen.tsx:55` both call
  `ImagePicker.launchCameraAsync`. `expo-image-picker` is absent from `app.json`'s `plugins`, so its
  config plugin never runs. Photo capture fails at the first tap on device, with no in-app recovery.
  Does not block install or login → **filed as [#216](./216-mobile-camera-permission-missing-from-manifest.md)**,
  not fixed here. #216 also carries the correction to the device-readiness audit, which records the
  Voucher flow as "the one screen you can exercise for real today".
- A stray `package-lock.json` at the repo root was making `expo install` shell out to `npm`, which
  dies on `workspace:*`. Moved aside, not deleted.
- The orphaned `node_modules/.pnpm` store was removed after the relocation (verified zero live links
  into it first); it was causing Gradle to mix old and new absolute paths.
- **Backend restarted.** It refused to boot on migration skew —
  `20260804140000_device_tokens` and `20260804150000_dispatch_run_reason` were never applied to the
  dev DB (exactly as #213's session log warned, and as the readiness audit predicted: *"500s after a
  backend restart until the migration is deployed"*). The old process had been running a stale build
  against a stale schema. `prisma migrate deploy` applied both — purely additive (one `CREATE TABLE`,
  one nullable `ADD COLUMN`, zero destructive statements) — and `/api/v1/health` now returns
  `200 {"status":"ok"}`.

### Lockfile — separated from the other session's work, but not perfectly clean

The tinypool patch **was** cleanly separated: `pnpm-workspace.yaml`'s `patchedDependencies` block was
removed and `pnpm install --lockfile-only` stripped the three corresponding lockfile references
(`patchedDependencies` settings block, the `tinypool@1.1.1(patch_hash=…)` snapshot key, and its
dependent reference). The committed `pnpm-workspace.yaml` diff is now *only* `virtualStoreDir` /
`virtualStoreDirMaxLength`; the other session's patch remains uncommitted in the working tree.

**What could not be excluded, and is not the other session's:** regenerating the lockfile also
repairs **pre-existing drift between committed files**. `apps/backend/package.json` at HEAD declares
`"multer": "^2.2.0"` and `"@types/multer": "^2.2.0"`, but HEAD's committed `pnpm-lock.yaml` has no
`multer` entry in the `apps/backend` importer at all — so **HEAD would fail
`pnpm install --frozen-lockfile` today**, independently of anything in this issue. The repair is
strictly additive: 11 package entries (`multer@2.2.0` plus 10 Express/`@types` packages), nothing
removed, no version regressed (`multer@2.0.2` remains for its transitive consumer). There is no
lockfile that contains the netinfo pin *without* it, short of hand-authoring an invalid one.

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
