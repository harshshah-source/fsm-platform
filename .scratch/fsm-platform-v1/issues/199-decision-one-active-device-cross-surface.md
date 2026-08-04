# 199 — DECISION: does one-active-device span surfaces, or bind only handsets?

Status: needs-triage — **decision required before [#202](./202-cross-surface-session-semantics.md) can be built**
Type: HITL · Decision · Backend + Mobile + Admin
Parent: [#197](./197-mobile-pilot-readiness-remediation-epic.md) · Filed 2026-08-04

**Nothing is decided in this issue. It exists to put the options in front of a human.**

## Root cause

D-2 ("one active device") was ratified with handset reasoning — replacement phones, stolen-device
tail, one SE one phone — but implemented as *revoke every active refresh token for this `userId`*,
with no device comparison at all. The admin web client does not send a device id, so every manager
login looks like a new device. The result is a policy nobody ratified: **logging into the admin
dashboard silently kills that user's mobile session, and vice versa.**

## Findings closed

Audit 2 **A4**; audit 1 **C-4**.

## Evidence — verified 2026-08-04

- `apps/backend/src/auth/prisma-refresh-token-store.ts:47-50` — `issue()` runs
  `updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now, revokedReason:
  'REPLACED_BY_NEW_DEVICE' } })`. **`deviceId` is stored but never used as a predicate anywhere in
  the store.** The invariant is achieved by revoke-all-on-issue, not by device identity.
- `apps/admin/src/api/client.ts:20-24` — admin login sends only `Content-Type`; no `X-Device-Id`. So
  `auth.controller.ts:31` takes the `randomUUID()` fallback on every admin login.
- `auth.controller.ts:27-30` claims enforcement "only meaningfully activates once a client sends a
  real stable id" — **understated**: the revoke-all write is fully live today regardless.
- Ratification is handset-framed throughout: `mobile-backend-freeze-plan-2026-07-28.md:423` ("One
  active device… covers handset replacement, kills the stolen-device tail"); `#91:371-384` ("an SE
  uses one phone with the app at a time… a stolen or lost handset is deauthorised the moment the SE
  logs in on a replacement"); `#54:46-48` ("Logging in on a **handset** revokes the previous
  **handset's** session"). **No document extends this to the admin dashboard.**
- Compounding UX: because mobile has no refresh-on-401 (audit 2 A1 → #186), the revoked handset does
  not show "signed out" — it shows the **"Offline"** badge. The user is told the network failed.
- Known adjacent holes, unowned: no rotation grace window (`schema.prisma:189-192` documents the
  risk — a dropped refresh *response* on a lossy field network burns the session permanently), and
  `REUSE_DETECTED` is a documented reason (`schema.prisma:206`) with no writer, so token-reuse does
  not revoke the lineage.

## The decision

### Q1 — What is the scope of "one active session"?

**Option A — per-user across all surfaces (today's behaviour, ratified retroactively).** Simplest
table, strongest stolen-credential story. *Cost:* a ZM who supervises from the dashboard and carries
a handset cannot use both; every admin login logs their phone out. For a pilot where operators are
likely to hold both, this generates constant spurious "the app logged me out" reports.

**Option B — one active session per client class** (one handset + one browser). Matches what the
handset reasoning actually intended. *Cost:* `issue()` must scope its revocation by a client class
carried on the token row (`device_id` already exists; admin must start sending a stable id, or the
class is derived from its absence). Small, contained change.

**Option C — one active session per device id, N devices.** Explicitly rejected at ratification as
out of v1 scope (`#91:386-388` — "no device-list endpoint, no per-device logout route, no Profile →
Devices screen"). Listed only so the rejection stays visible.

### Q2 — Should a revoked session be *told* it was revoked?

Independent of Q1 and worth deciding now: the backend knows `revokedReason`
(`REPLACED_BY_NEW_DEVICE` vs `LOGOUT` vs expiry) but the refresh endpoint returns a bare 401. A
distinct code would let the client say "You signed in on another device" instead of "Offline".
Recommended regardless of Q1's answer; the failure copy is what turns a policy into a support ticket.

### Q3 — Is a rotation grace window wanted for field networks?

`schema.prisma:189-192` already records the exposure. A few seconds of overlap on the rotated token
would stop a dropped response from permanently burning an SE's session mid-shift.

## Acceptance criteria

- [ ] Q1 answered and recorded in `#91` (the policy's owner) and `CONTEXT.md`
- [ ] Q2 answered — if yes, the distinct error code is named so #186/#202 can render it
- [ ] Q3 answered — grace window in or out, with the field-network risk acknowledged either way

## Verification

Ruling recorded on #91; #202 unblocked with concrete ACs.

## Risk if deferred

During the pilot, anyone holding both a handset and the dashboard is logged out unpredictably and —
until #186 lands — is told it is a network problem. That is the single most likely source of false
bug reports from your first testers, and it will be reported as "the app keeps going offline",
which points investigation at exactly the wrong subsystem.

## Size estimate

Decision: S. Implementation (#202): S under Option A (copy changes only), M under Option B.
