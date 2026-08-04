# 202 — Cross-surface session semantics: stop admin logins from silently killing handset sessions

Status: ready-for-agent — **blocked by [#199](./199-decision-one-active-device-cross-surface.md)**
Type: AFK · Backend + Mobile + Admin
Parent: [#197](./197-mobile-pilot-readiness-remediation-epic.md) · Filed 2026-08-04

## Root cause

One-active-device was ratified as a *handset* policy and implemented as a per-`userId` revoke-all,
with the stored `device_id` never used as a predicate. Combined with the admin client not sending a
device id at all, any dashboard login revokes that user's handset session — a policy nobody agreed
to. Because mobile has no refresh-on-401 (#186), the handset does not report being signed out; it
reports being offline.

## Findings closed

Audit 2 **A4**; audit 1 **C-4**. Implements whatever [#199](./199-decision-one-active-device-cross-surface.md) rules.

## Evidence — verified 2026-08-04

- `prisma-refresh-token-store.ts:47-50` — `issue()` revokes **every** active token for the `userId`
  (`revokedReason: 'REPLACED_BY_NEW_DEVICE'`); `deviceId` is written but never compared.
- `apps/admin/src/api/client.ts:20-24` — admin login sends no `X-Device-Id`, so
  `auth.controller.ts:31` substitutes `randomUUID()` — every admin login is a "new device".
- Backend reads `X-Device-Id` at exactly three sites: `auth.controller.ts:25` (login), `:38`
  (refresh), `notifications.controller.ts:48` (device-token, no mobile caller yet — #89).
- The refresh endpoint returns a bare 401 regardless of `revokedReason`, so no client can tell
  "signed in elsewhere" from "expired" from "network down".
- Adjacent, documented, unowned: no rotation grace window (`schema.prisma:189-192`) and no
  `REUSE_DETECTED` writer despite the reason being defined (`schema.prisma:206`).
- Pinned by existing tests: `refresh-persistence.e2e-spec.ts:68-84`, `:86-95` assert the current
  revoke-all behaviour — **these tests encode the undecided policy and will need updating under
  #199 Option B.**

## Scope

**In:** implement the #199 ruling in `prisma-refresh-token-store.issue()`; if Q2 is answered yes, add
a distinct error code for "revoked because another session started" and render it on mobile as an
explicit signed-out state rather than "Offline"; if Q3 is answered yes, add the rotation grace
window; make the admin client send a stable device id if the ruling requires one.

**Out:** a device-list endpoint, per-device logout, or a Profile → Devices screen — all explicitly
out of v1 (`#91:386-388`). Multi-device support beyond whatever #199 rules.

## Acceptance criteria

- [ ] `issue()`'s revocation scope matches the #199 ruling, and `refresh-persistence.e2e-spec.ts` is
      updated to assert the ruled behaviour (not the incidental current one)
- [ ] Under Option B: an admin login and a handset login for the same user coexist; a *second*
      handset login still revokes the first
- [ ] If #199 Q2 = yes: a revoked-by-another-session refresh returns a distinct code, and mobile
      renders "You signed in on another device" — never the Offline badge
- [ ] If #199 Q3 = yes: a refresh whose response is lost can be retried within the grace window
      without burning the session, proven by a test
- [ ] `auth.controller.ts:27-30`'s comment ("only meaningfully activates once a client sends a real
      stable id") is corrected — it understates today's fully-live behaviour

## Verification

```bash
cd apps/backend && node scripts/run-tests.mjs test/refresh-persistence.e2e-spec.ts
```
Plus manually: log in on the handset, then log into admin as the same user, and confirm the handset's
behaviour matches the ruling — including the message it shows.

## Risk if deferred

Anyone holding both a handset and the dashboard is logged out unpredictably during the pilot, and is
told it is a network problem. That misdirects debugging at the worst possible moment: the report will
read "the app keeps going offline", which points at connectivity, not auth. It is the single most
likely source of false bug reports from your first testers.

## Size estimate

S under #199 Option A (copy + comment only). M under Option B (revocation predicate + admin device
id + test rewrite).
