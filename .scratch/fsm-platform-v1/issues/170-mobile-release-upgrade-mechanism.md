# 170 — Mobile release & upgrade mechanism (OTA + server min-version gate)

Status: ready-for-human
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
