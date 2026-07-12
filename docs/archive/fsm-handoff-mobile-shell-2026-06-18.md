# Handoff — FSM Issue 01, Mobile Shell (slices 1–7 complete)

> **ARCHIVED 2026-07-12 — consumed session handoff.** Current state lives in `docs/SYSTEM-STATE-2026-07.md`; work tracking in `.scratch/fsm-platform-v1/INDEX.md`. Historical record only.
Date: 2026-06-18 · Workspace: `D:\fms_adminDashbooard\fsm-platform-greenfield`
Predecessor handoff: `docs/progress/fsm-handoff-2026-06-17.md` · Canonical status: `docs/progress/01-foundation-skeleton-infra.md`
Issue: `.scratch/fsm-platform-v1/issues/01-foundation-skeleton-infra.md` · Decisions: `docs/adr/0025-foundation-skeleton-infra.md`

## What this session did

Built the **mobile shell** (`apps/mobile`, Expo SDK 54) end-to-end via strict TDD (RED→GREEN→REFACTOR),
mirroring the admin `AuthProvider`/`api-client` pattern and consuming `@fsm/shared`. This closes
**AC#1-mobile** (scaffold + shared DTOs) and **AC#3-keychain** for Issue 01.

Slices (all GREEN, mirror admin contracts — see `apps/admin/src` for the originals):
1. `src/api/client.ts` `apiLogin`
2. `apiMe`
3. `src/auth/tokenStore.ts` — keychain wrapper (stores access+refresh JSON; `setTokens`/`getAccessToken`/`clearTokens`)
4. `src/auth/AuthProvider.tsx` — login→keychain→`apiMe`→session; `logout` is async
5. `src/auth/LoginScreen.tsx`
6. `src/auth/SessionScreen.tsx` — role/zone + `acted_as_role` banner
7. `src/auth/AppEntry.tsx` + `app/_layout.tsx` (AuthProvider+Slot) + `app/index.tsx` — session-gated; demo template stripped

**Verification (current):** mobile jest **20/20**, mobile `pnpm typecheck` clean, Metro `expo export` bundles,
admin **4/4**, backend **25/25**. All green.

## Key facts a fresh agent will not derive from the diff


- **DEVIATIONS from admin are intentional & platform-required** (RN primitives; `process.env.EXPO_PUBLIC_API_URL`
  default `http://10.0.2.2:3000/api` = Android-emulator host alias; keychain instead of sessionStorage; both
  tokens stored mobile-side, no cookie path; `logout`/screens declarative off `session` instead of react-router).
- **pnpm layout is ISOLATED.** A `nodeLinker: hoisted` experiment was tried and **reverted** — it duplicated React
  and broke admin tests. Do **not** reintroduce hoisted. If Metro ever fails to resolve a workspace pkg, fix it
  **mobile-locally** (metro.config `extraNodeModules`), never workspace-wide.
- **`@jest/globals@29.7.0`** is a direct mobile devDep, linked **offline** from the store (FortiGate blocks registry).
  Tests import jest globals from it (jest's ambient types aren't available; no `@types/jest`).
- **RESOLVED infra-debt — duplicate `@types/react`:** admin pins `^18.3.5` (→`18.3.31`, hoisted into pnpm's shared
  `.pnpm/node_modules/@types/react`), mobile pins `~19.1.0` (→`19.1.17`). After the slice-7 demo strip, tsc bound
  `react-native`'s `.d.ts` to admin's 18.x → `TS2786` JSX errors. **Fix:** `apps/mobile/tsconfig.typecheck.json`
  (react→mobile `@types/react`) used only by the `typecheck` script. **Critical gotcha:** Expo's `babel-preset-expo`
  applies `tsconfig.json` `paths` as **runtime** aliases (Metro+jest), so the react redirect MUST stay out of
  `tsconfig.json` — putting it there broke 4 jest suites. Canonical `pnpm typecheck` is green; a *bare* `tsc --noEmit`
  (no `-p`) still shows 16 dup errors — expected, not a regression.
- The SDK-54 `default` template shipped one broken demo file (`parallax-scroll-view.tsx`, reanimated typing); it was
  deleted with the rest of the demo in slice 7, so its `@ts-nocheck` is gone.

## Environment (already configured this session)

- `JAVA_HOME` = Android Studio JBR (OpenJDK 21); `ANDROID_HOME`/`ANDROID_SDK_ROOT` = `%LOCALAPPDATA%\Android\Sdk`;
  `platform-tools`+`emulator`+`jbr\bin` on User PATH. **Persisted at User scope** — new shells inherit; each
  PowerShell tool call is a fresh process, so re-apply into `$env:` if a command needs them mid-session.
- An Android **AVD exists** (user created it in Android Studio; non-Play `google_apis` image).
- `react-native-keychain@^10.0.0` installed (New-Arch compatible; `app.json` has `newArchEnabled: true`).
- **react-native-keychain is a native module → needs a custom dev client / `expo run:android` (NOT Expo Go).**
- FortiGate blocks registry fetches in the agent sandbox: **ask the USER to run `pnpm add` / installs**, then verify.
  `pnpm install --offline` works for store-cached pkgs + workspace linking.

## Immediate next step (unfinished)

1. **TODO I promised but did not do yet:** add a one-line infra-debt entry to
   `docs/progress/01-foundation-skeleton-infra.md` for the `tsconfig.typecheck.json` dup-`@types/react` fix (the
   config comment references it). Do this first.
2. **Awaiting user choice of next tracer bullet** (I recommended emulator-verify first):
   - **/verify** the mobile shell live: boot AVD → `pnpm --filter @fsm/mobile run android` (dev client) → log in
     `zm.north@fsm.test` / correct-password against `pnpm --filter @fsm/backend start` → confirm role/zone renders.
     Remember `10.0.2.2:3000` for the emulator→host backend.
   - **P — PostGIS**: install bundle on local PG18 + `CREATE EXTENSION postgis` migration + `pg_extension` test
     (closes AC#2's last clause). Needs Stack Builder; PostGIS not yet installed.
   - **S — shadcn/ui** in admin (Tailwind already present) — closes AC#1 admin stack literal.
   - **C — CI** (AC#7) — still **BLOCKED**: repo is not git-initialised, no GitHub remote.

## How the user works (match this)

Tightly-scoped tracer bullets; "strict TDD, show RED/impl-diff/GREEN/deviations, then wait"; frequently gates with
`/triage` before acting and says "Wait" / "Start slice N". **Do not batch slices or skip the wait.** Surface blockers
honestly rather than thrashing (this session burned several attempts on the `@types/react` dup before tracing it
properly with `tsc --traceResolution` — lead with the trace next time).

## Suggested skills

- **`/triage`** — the user drives Issue-01 planning/scope through it; use for any state/scope review.
- **`/tdd`** — all mobile/backend code here is strict RED→GREEN→REFACTOR.
- **`/verify`** or **`/run`** — to launch the dev client / confirm the mobile login flow against the live backend.
