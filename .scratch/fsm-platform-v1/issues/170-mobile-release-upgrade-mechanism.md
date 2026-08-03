# 170 — Mobile release & upgrade mechanism (OTA + server min-version gate)

Status: ready-for-agent (scoped by D-10, 2026-08-03: bundle identifiers/app naming + `X-App-Version`
header + configurable server min-version floor + blocking update-required screen; **no OTA for the
pilot**) · ready-for-human remainder: distribution channel (sideload / MDM / store internal track)
— owner needed before pilot
Type: HITL · Mobile + Backend

Filed 2026-07-28 (`docs/status/mobile-backend-freeze-plan-2026-07-28.md` §8, D-10).

## The problem

Once v1 is on 1,000 handsets, **nothing can change it and nothing can stop it**. Verified absent:
`expo-updates`, `eas.json`, `runtimeVersion`/`updates` in `app.json`, any `X-App-Version` header or
minimum-version check, `enableVersioning`, and any OpenAPI/contract artifact. The `appVersion` hits
in `build-info/*` are the **backend's own** version (`runtime-lock.ts:54-67`) — nothing reads a
*client* version, so the server cannot tell a v1 handset from a v3 handset and cannot refuse one.

Concretely: a backend change breaks the field, and there is no channel to push a fix, no gate to
serve the old shape, and no signal except engineers phoning in. **This is the mechanism that decides
whether every other mistake in the programme is recoverable or permanent** — which is why the freeze
plan recommends the contract-*compatibility* bar over contract-*immutability*.

## Decisions required (operator)

1. **OTA channel** — adopt `expo-updates` + EAS channels for JS-only fixes, or store-only releases?
   Cost is real (EAS plan, release process, staged rollout discipline).
2. **Minimum-client-version gate** — does the server refuse builds it can no longer serve?
   Recommendation: yes, `X-App-Version` + a configurable floor returning a distinct error code the
   client renders as "update required".
3. **Store presence** — `app.json` has no `ios.bundleIdentifier` and no `android.package`, and
   `name`/`slug` are both `"mobile"`. Nothing here is submittable. Decide the distribution channel
   (Play Store / enterprise MDM / sideload) — it changes the answer to (1).

**Recommendation: both OTA and a version gate.** They are cheap relative to the risk they retire,
and they are the difference between "we added a field mid-build" being a non-event and being an
incident.

## Acceptance criteria (once decided)

- [ ] A JS-only fix can reach a field handset without a store release
- [ ] The server can identify a client build and refuse one below a configured floor, with a distinct error code
- [ ] The client renders a blocking "update required" state on that code
- [ ] Bundle identifiers and app naming are set for the chosen distribution channel
- [ ] The rollout path (staged %, rollback) is documented in the #111 runbook

## UI surfaces

- **Mobile:** blocking update-required screen. **Admin:** n/a.

## Reference

n/a.

## Blocked by

- Operator decisions above. Gates nothing technically, but the longer it waits the more of the
  programme is un-recoverable.

## Comments

### 2026-08-03 — D-10 DECIDED: no OTA for the pilot (deferred, not rejected)

**Operator decision, recorded so it does not reopen.**

**No OTA channel for the pilot.** Deferred, not rejected — **revisit before fleet scale-up.**
Decision (1) in the body resolves to "neither, for now"; nothing about `expo-updates`/EAS is
provisioned for the pilot.

**Proceed now with the zero-cost parts, which are independent of the OTA decision:**
- Real bundle identifiers and app name in `app.json` (today `name`/`slug` are literally `"mobile"`
  and there is no `android.package`/`ios.bundleIdentifier` — nothing is submittable anywhere).
- `X-App-Version` on every request from the client.
- A configurable server-side minimum-version floor returning a **distinct error code**, and the
  client's blocking "update required" state on that code (body decision (2): **yes**).

**Consequence, recorded explicitly: deferring OTA raises the bar on #169's contract freeze.** The
freeze plan's own assessment is ~85% achievable; without a client update path, the remaining ~15%
(field-level completeness, client-discovered error cases, offline sync semantics, real-device
performance) means **manual reinstall across the fleet** rather than a routine fix. Noted on #169
(2026-08-03 comment): its scope is now load-bearing in a way it was not when OTA was assumed.

**Knock-on to #54 — confirmed, sequencing unchanged, first-build AC set grows.** #54 already marks
`X-Device-Id` non-retrofittable for exactly this reason; with no OTA, `X-App-Version` + the blocking
update-required screen join it as first-build, cannot-add-later items. Recorded on #54 (2026-08-03
comment). #54's position in the build order does not change.

**Open question — recorded, not answered: how do builds reach handsets?** Sideloaded APK, MDM, or a
store internal track. Sideload means **no update path at all**; MDM or an internal track gives a
slow one. This decides how severe no-OTA actually is, and it must be answered **before pilot**.
**Owner needed** — flagged in the Status line until one is named.
