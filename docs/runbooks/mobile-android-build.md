# Runbook — Android development build, from clone to logged-in handset

Owner issue: [#209](../../.scratch/fsm-platform-v1/issues/209-mobile-build-pipeline-device-install.md) ·
First written 2026-08-04

This is the only path from a checkout to the SE app running on a physical Android handset. It
covers dependency alignment → build → install → backend reachability. Read the whole thing once
before the first build; the Windows path-length section in particular is not optional and not
obvious.

Everything here is Android-only. iOS is out of scope for v1 (D1 settled FCM/Android-only,
`#76:113-116`), and no `apps/mobile/ios/` is generated.

---

## 0. What is pinned, and why

`expo prebuild` regenerates `apps/mobile/android/` from `app.json` plus the installed dependency
versions. That makes the *output* only as reproducible as the *inputs*, so the inputs are pinned:

| Thing | Pinned to | Where it is pinned |
|---|---|---|
| Expo SDK | `expo@~54.0.36` | `apps/mobile/package.json` |
| React Native | `0.81.5` | `apps/mobile/package.json` |
| NetInfo | `@react-native-community/netinfo@11.4.1` (exact, no caret) | `apps/mobile/package.json` |
| Gradle | `8.14.3` | `android/gradle/wrapper/gradle-wrapper.properties` |
| JDK | 21 (Android Studio's bundled JBR) | `JAVA_HOME` on the dev machine |
| Android CMake | **`3.31.6`** (NOT the default 3.22.1 — see §3) | `android/build.gradle`, installed via `sdkmanager` |
| Android NDK | `27.1.12297006` | Android SDK package |
| pnpm | `11.7.0` | dev machine |

`netinfo` is pinned **exactly**, not with a caret. It is a native module backing
`src/api/connectivity.ts` — i.e. the app's entire offline detection, which [#186](../../.scratch/fsm-platform-v1/issues/186-mobile-auth-shell-no-session-persistence.md)
depends on. It had drifted to `12.0.1` against SDK 54's expected `11.4.1`; a caret would let it
drift again.

**`apps/mobile/android/` is tracked in git — deliberately.** The Expo docs recommend gitignoring it
and regenerating (CNG). We do the opposite, because a hand-applied native fix that gets silently
wiped by the next prebuild is a worse failure than a noisy diff, and this project has native fixes
that cannot be expressed as config plugins (see §3). Consequences:

- **Do not run `npx expo prebuild --clean`.** It deletes `android/` and regenerates it, discarding
  the `build.gradle` block in §3. If you ever must, re-apply that block afterwards or the build
  fails exactly as described there.
- A plain `npx expo prebuild --platform android --no-install` is safe: it does not overwrite an
  existing `android/`.
- Build outputs stay untracked via the template's own `android/.gitignore`
  (`build/`, `.gradle`, `.cxx/`, `local.properties`).

---

## 1. One-time machine setup

Required once per dev machine, not per clone. **Steps 3 and 4 are machine state that cannot live in
this repo** — a fresh clone on a machine missing either one fails, and the failure does not mention
paths, permissions, or anything resembling the real cause. Read §1.1 before you start debugging.

1. **Android SDK + `adb` on PATH.** `%LOCALAPPDATA%\Android\Sdk`, installed via Android Studio.
   Verify: `adb version`.
2. **JDK 21.** Android Studio's bundled JBR is fine. Verify: `java -version` → `21.x`.
3. **Enable Windows long paths** — admin PowerShell, one line, then reboot:

   ```powershell
   Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' `
     -Name LongPathsEnabled -Value 1 -Type DWord
   ```

   Verify: `(Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem').LongPathsEnabled`
   → `1`. This is necessary but **not sufficient** on its own — see step 4 and §3.

4. **Install Android CMake 3.31.6** — the default 3.22.1 ships a ninja that cannot use long paths,
   so without this the native build fails no matter what step 3 says:

   ```bash
   sdkmanager "cmake;3.31.6"
   ```

   Verify: `%LOCALAPPDATA%\Android\Sdk\cmake\3.31.6\bin\ninja.exe --version` → `1.12.1`.

5. **Handset**: Developer Options on, USB debugging on, cable connected, and the "Allow USB
   debugging?" prompt accepted on the device. Verify: `adb devices -l` lists a device as `device`
   (not `unauthorized`, not `offline`). An empty list means nothing below will work.

### 1.1 If the build fails, check this FIRST — the errors name the wrong culprit

Every one of these is step 3 or step 4 missing. None of them says "long path" or "install CMake",
which is exactly why they cost a day the first time. If you see **any** of them, stop debugging and
go back to steps 3 and 4:

| What you'll see | What it actually means |
|---|---|
| `ninja: error: manifest 'build.ninja' still dirty after 100 tries` on `:react-native-screens`, `:expo-modules-core`, `:react-native-worklets` | ninja cannot stat a file whose path exceeds 260 chars, so it re-runs CMake forever. **Nothing to do with a corrupt build directory.** |
| `ninja: error: Filename longer than 260 characters` | the honest version of the same thing |
| `ninja: error: mkdir(CMakeFiles/…/AnimationFrameQueue): No such file or directory` | ninja could not *create* a directory over the limit. **The parent directory is fine — this is not a missing-file problem.** |
| ~1000 × `CMAKE_OBJECT_PATH_MAX … cannot be safely placed under this directory. The build may not work correctly.` | CMake's own 250-char check. A warning, not the failure, but a reliable signal you are in this territory. |
| `CXX1429 error when building with cmake … Configuring incomplete, errors occurred!` | usually the same root cause one layer up |

Two failures in this area that are **not** step 3/4, so that you can tell them apart:

- `Cannot run Project.afterEvaluate(Closure) when the project is already evaluated` — the
  `subprojects { }` block in `android/build.gradle` has been moved *below* the `apply plugin:` lines.
  Put it back above them (§3).
- `libworklets.so … missing and no known rule to make it`, or `No matching variant of project
  :react-native-… was found` / `No variants exist` — stale absolute paths from a previous
  configuration. Clear the build state (the script at the end of §3c) and rebuild.

---

## 2. Dependency check (every time, before building)

```bash
cd apps/mobile
npx expo install --check      # must print "Dependencies are up to date."
```

If it reports drift, fix it with `npx expo install --fix` — **never** with `pnpm add`, which
resolves versions the installed SDK does not expect.

> **Gotcha:** if a stray `package-lock.json` exists at the repo root, `expo install` detects it and
> shells out to `npm`, which then dies on `workspace:*` with `EUNSUPPORTEDPROTOCOL`. This is a pnpm
> workspace; there should be no `package-lock.json` anywhere. Delete it, or pass `--pnpm`.

---

## 3. Windows path length — the one thing that will bite a new machine

**Symptom.** Gradle fails with three C++ tasks dead, each identical:

```
:react-native-screens:buildCMakeDebug[arm64-v8a]
:expo-modules-core:buildCMakeDebug[arm64-v8a]
:react-native-worklets:buildCMakeDebug[arm64-v8a][worklets]
  → ninja: error: manifest 'build.ninja' still dirty after 100 tries
```

**Cause.** pnpm stores packages at `node_modules/.pnpm/<pkg>@<version>_<32-hex-hash>/node_modules/<pkg>/`.
That segment alone is ~70 characters, and it lands in native build paths *twice* — once in the
source path and again mirrored inside `CMakeFiles/<target>.dir/C_/...`. Measured on this repo:

| Path | Length | Limit |
|---|---|---|
| A C++ object file | 367 | 260 (`MAX_PATH`) |
| CMake's own object-path check | — | 250 (`CMAKE_OBJECT_PATH_MAX`) |
| Prefab config as ninja resolves it (`<build>/arm64-v8a/../prefab/...`, `..` **not** collapsed) | 268–274 | 260 |

**The fix that matters is #4 below.** The first three shorten paths; they help, but path shortening
alone provably cannot solve this, because React Native's own fixed directory structure accounts for
175 of the 319 characters (see §3c for the segment-by-segment budget). The real problem is that the
default toolchain cannot address long paths at all.

1. **`LongPathsEnabled = 1`** (§1.3) — lifts the OS ceiling, but only for processes whose
   executable manifest declares `longPathAware`. On its own it changes nothing here.
2. **`-DCMAKE_OBJECT_PATH_MAX=1024`** — CMake's own 250-char check is independent of the registry
   and warns ~1000 times without it. Set in `android/build.gradle`.
3. **`buildStagingDirectory` → `C:/x/<module>`** plus **`virtualStoreDir` /
   `virtualStoreDirMaxLength`** (§3b) plus **`reactNativeArchitectures=arm64-v8a`** (§3a) — these
   shorten paths and buy margin. They were each enough to unblock *some* modules, which is what
   made the diagnosis take so long: every fix revealed a deeper one.
4. **Android CMake `3.31.6`, pinned** — the root cause and the actual fix. The default Android
   CMake `3.22.1` bundles **ninja 1.10, whose manifest does NOT declare `longPathAware`**, so it is
   hard-capped at 260 characters regardless of fix 1. CMake 3.31.6 bundles **ninja 1.12.1, which
   does** — so fix 1 finally reaches the tool that was failing. Install once per machine:

   ```bash
   sdkmanager "cmake;3.31.6"
   ```

   Verify: `strings ninja.exe | grep longPathAware` → present in 3.31.6, absent in 3.22.1.

   **Do not "upgrade" to CMake 4.x.** It drops support for the `cmake_minimum_required` values
   React Native still declares, and the build will not configure.

Fixes 2, 3 and 4 live in the `subprojects { }` block in `apps/mobile/android/build.gradle`, which
**must stay above the `apply plugin:` lines** — `expo-root-project` evaluates the autolinked module
subprojects as it is applied, and a block placed after it fails the build outright with
`Cannot run Project.afterEvaluate(Closure) when the project is already evaluated`.

Override the staging root with `-Pfsm.cxxRoot=<path>` if `C:\x` is unavailable. On macOS and Linux
the relocation is skipped entirely — no other platform has this ceiling.

### 3a. Why only `arm64-v8a` is built

`buildStagingDirectory` shortens the *prefix* of an object path. It cannot shorten the pnpm store
segment that CMake **mirrors inside** the object directory
(`CMakeFiles/worklets.dir/C_/fsm-platform-backup/node_modules/.pnpm/...`). For the deepest sources
that mirrored path still lands near 260, and `armeabi-v7a` is 2 characters longer than
`arm64-v8a` — enough to tip it over:

```
ninja: error: mkdir(CMakeFiles/worklets.dir/C_/.../worklets/AnimationFrameQueue):
  No such file or directory
```

So `android/gradle.properties` pins `reactNativeArchitectures=arm64-v8a`. This is independently the
right default — every pilot handset is arm64, `expo run:android` already builds only the connected
device's ABI, and one ABI builds roughly 4x faster. The APK will **not** install on a 32-bit ARM
device or an x86/x86_64 emulator.

### 3b. The relocated pnpm virtual store

`buildStagingDirectory` and the ABI narrowing were still not enough for `react-native-reanimated`,
the deepest module: its object path measured **288 characters**, and it failed one character over
the line —

```
ninja: error: mkdir(CMakeFiles/reanimated.dir/C_/.../reanimated/AnimatedSensor):
  No such file or directory      # that directory is exactly 261 chars
```

`buildStagingDirectory` shortens the prefix; it cannot shorten the pnpm store segment that CMake
mirrors *inside* the object directory. So `pnpm-workspace.yaml` sets:

```yaml
virtualStoreDir: C:/pv
virtualStoreDirMaxLength: 40
```

which takes that same path to **232 characters** — 28 to spare. `virtualStoreDir` moves the store
off the deep repo path; `virtualStoreDirMaxLength` truncates the long `<pkg>@<version>_<32-hex>`
directory names (it keeps the hash and shortens the name, so
`react-native-reanimated@4.1_a25ca2be...` becomes `react-n_a25ca2be...`).

This was chosen over `nodeLinker: hoisted` (which would have given 208) deliberately: it keeps
pnpm's isolated linking, so module resolution is unchanged and phantom dependencies still fail
loudly in backend and admin. Consequences to know:

- **The virtual store lives outside the repo.** Deleting `node_modules` no longer fully cleans;
  the real packages are under `C:\pv`.
- **Changing this setting requires `pnpm install` to purge `node_modules`**, which needs a TTY.
  In a non-interactive shell: `CI=true pnpm install`.
- **After relocating, delete the orphaned old store** (`node_modules/.pnpm`) and the stale
  `android/build` directories of the native modules. Gradle otherwise resolves half-old, half-new
  absolute paths and fails with `libworklets.so ... missing and no known rule to make it`.
- Any running dev server needs restarting after the purge.

`nodeLinker: hoisted` was considered and rejected: it buys less than it looks like (measured: 24
characters, where 60 were needed) and it would let phantom dependencies resolve silently across
backend and admin.

### 3c. Why path shortening alone can never work — and what was tried

The last overflow was React Native's own New Architecture codegen. RN writes generated C++ into
`<module>/android/build/generated/source/codegen/jni/react/renderer/components/<name>/`, and CMake
mirrors that entire absolute path inside the object directory. On
`react-native-safe-area-context` the result was **319 characters**, rejected outright:

```
ninja: error: Stat(safeareacontext_autolinked_build/CMakeFiles/react_codegen_safeareacontext.dir/
  C_/pv/.../generated/source/codegen/jni/react/renderer/components/safeareacontext/
  ComponentDescriptors.cpp.o): Filename longer than 260 characters
```

60 characters had to go, and the budget shows why no amount of shortening gets there:

| Segment | Chars | Can it shrink? |
|---|---|---|
| `C:\x\app\Debug\<hash>\arm64-v8a\` | 34 | already minimal |
| `safeareacontext_autolinked_build\CMakeFiles\react_codegen_safeareacontext.dir\` | 78 | **no** — React Native structure |
| store segment + `<pkg>\android\build\` | 105 | a little |
| `generated\source\codegen\jni\react\renderer\components\safeareacontext\` | 71 | **no** — React Native codegen |
| `ComponentDescriptors.cpp.o` | 26 | no |

175 characters are immovable React Native structure. Even the most aggressive combination
(`nodeLinker: hoisted`, a two-character repo root, minimal `virtualStoreDirMaxLength`) lands around
272 — still over. **That is why the toolchain upgrade in fix 4 is the answer, not more path golf.**

Two dead ends, recorded so nobody burns a day rediscovering them:

- **Relocating each library module's Gradle `buildDir` to a short root.** Arithmetically it worked
  (-69 chars), but React Native's generated `Android-autolinking.cmake` derives the codegen
  directory from the module's *project* directory, not its configured build directory. Configuration
  dies with `add_subdirectory given source ".../react-native-gesture-handler/android/build/generated/
  source/codegen/jni/" which is not an existing directory`. The `build.gradle` carries a comment
  saying so.
- **Raising `CMAKE_OBJECT_PATH_MAX` alone.** It silences CMake's warning but does not shorten
  anything, so ninja still hits the OS limit. It is necessary, not sufficient.

**Whenever you change any of these roots, clear all the stale state together** — otherwise Gradle
mixes old and new absolute paths and fails with `libworklets.so ... missing and no known rule to
make it`:

```powershell
Remove-Item -Recurse -Force C:\x -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force C:\fsm-platform-backup\apps\mobile\android\.gradle -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force C:\fsm-platform-backup\apps\mobile\android\app\build -ErrorAction SilentlyContinue
Get-ChildItem C:\pv -Directory | Where-Object { $_.Name -like "react-n*" -or $_.Name -like "expo*" } |
  ForEach-Object { Get-ChildItem $_.FullName -Recurse -Directory -Filter "build" -Depth 3 |
    Where-Object { $_.FullName -like "*android\build" } |
    ForEach-Object { Remove-Item -Recurse -Force -LiteralPath "\\?\$($_.FullName)" } }
```

---

## 4. Networking — pick a route before you build

`EXPO_PUBLIC_API_URL` is inlined into the JS bundle at **bundle time**, from `apps/mobile/.env`.
Copy `apps/mobile/.env.example` to `apps/mobile/.env` and pick one. Changing it later requires a
Metro restart (`npx expo start --clear`) — **reinstalling the APK alone does nothing**, because the
old value is already baked into the bundle.

Static dot notation only: `process.env.EXPO_PUBLIC_API_URL` is inlined,
`process.env['EXPO_PUBLIC_API_URL']` is not and resolves to `undefined`.

### Route A — USB / `adb reverse` (recommended; start here)

```bash
adb reverse tcp:3000 tcp:3000
# apps/mobile/.env:
# EXPO_PUBLIC_API_URL=http://localhost:3000/api/v1
```

The handset's own `localhost:3000` is tunnelled to the host's `localhost:3000` over the cable. **No
LAN IP, no Wi-Fi, and no Windows Firewall rule** — the traffic never touches the inbound network
path. This is the route that avoids turning a first install into a firewall debugging session.

Must be re-run after every unplug, device reboot, or `adb kill-server`. Verify with
`adb reverse --list`.

### Route B — LAN IP

```bash
# apps/mobile/.env:
# EXPO_PUBLIC_API_URL=http://<HOST-WIFI-IPV4>:3000/api/v1
```

Needs both of:

1. The host's current Wi-Fi IPv4 (`ipconfig` → *Wireless LAN adapter Wi-Fi*). It is DHCP-assigned
   and **will change**. Handset must be on the same Wi-Fi.
2. **An inbound Windows Firewall rule for TCP 3000.** All three firewall profiles on this machine
   default inbound to Block, so without the rule this route fails as a connection timeout that
   looks exactly like a wrong URL. Admin PowerShell:

   ```powershell
   New-NetFirewallRule -DisplayName "FSM backend dev (TCP 3000)" -Direction Inbound `
     -Protocol TCP -LocalPort 3000 -Action Allow -Profile Private
   ```

   Scope it to `Private` — do not open port 3000 on a public network.

The backend itself needs no change: NestJS `app.listen(3000)` already binds `0.0.0.0`, confirmed
via `netstat -ano | findstr :3000`.

### Route C — Android emulator

`http://10.0.2.2:3000/api/v1` — `10.0.2.2` is the emulator's alias for the host loopback. This is
also the hardcoded fallback in `src/api/client.ts` when no `.env` is present, which is why a
physical handset with no `.env` silently routes nowhere.

---

## 5. Build and install

```bash
cd apps/mobile
npx expo install --check                  # gate: must be clean
adb devices -l                            # gate: handset must be listed as `device`
adb reverse tcp:3000 tcp:3000             # Route A
npx expo run:android                      # builds, installs, launches, starts Metro
```

`expo run:android` passes `-PreactNativeArchitectures=<device abi>` for the connected handset, so
it builds one ABI rather than all four — much faster than a bare `./gradlew assembleDebug`.

To build without installing:

```bash
cd apps/mobile/android
./gradlew assembleDebug
# → app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

The first build compiles the C++ for every autolinked module and takes several minutes. Subsequent
builds are incremental.

---

## 6. Verify on the handset

The bar is **not** a green Gradle build. A compile proves nothing about autolinking, native
permissions, or `react-native-keychain` on real hardware. The bar is:

1. App installs and launches on a physical handset.
2. Log in as `se.north@fsm.test`. This is the end-to-end proof — it exercises DNS/URL/firewall, the
   `X-Device-Id` and `X-App-Version` headers, and the keychain write on the login path.
3. **Force-stop the app and reopen it.** The session must survive. This is what proves
   `react-native-keychain` actually works on device, as opposed to in a Jest mock.

Watch the request leave the device:

```bash
adb logcat | grep -i "fsm\|fetch\|network"
```

If login fails, isolate the layer before touching app code:

```bash
adb shell curl -v http://localhost:3000/api/v1/health   # Route A, from the handset itself
```

---

## 7. Release builds — a constraint, not a task

Signed release builds are **out of scope** until the distribution channel is chosen
([#170](../../.scratch/fsm-platform-v1/issues/170-mobile-release-upgrade-mechanism.md) owns that
question). One thing must be known before anyone tries:

**Android blocks cleartext `http://` in release builds by default.** Debug builds are unaffected —
the generated `android/app/src/debug/AndroidManifest.xml` sets `usesCleartextTraffic="true"`, which
is why every route in §4 works today. A signed release APK built against the same `http://` backend
will fail every request with no useful error.

Before a release build can talk to the backend, one of:

- **Serve the backend over HTTPS** (correct answer for anything resembling production), or
- add the `expo-build-properties` config plugin with
  `android.usesCleartextTraffic: true` — acceptable only for an internal pilot on a trusted
  network, and it must be a conscious, recorded decision, not a default.

---

## 8. Known gaps

- **No `android.permission.CAMERA` in the generated manifest**, but `InstallFormScreen.tsx:43` and
  `VoucherFormScreen.tsx:55` both call `ImagePicker.launchCameraAsync`. `expo-image-picker` is not
  in `app.json`'s `plugins` array, so its config plugin never adds the permission. Photo capture
  will fail on device. Out of scope for #209 (does not block install or login) — owned by whoever
  owns photo capture.
- **Two pieces of machine state cannot be committed**: `LongPathsEnabled` (§1.3) and the CMake
  3.31.6 install (§1.4). A fresh clone missing either fails in the ways catalogued in §1.1, none of
  which name the real cause. There is no repo-side guard — the mitigation is that §1.1 exists and is
  the first thing §1 tells you to read.
