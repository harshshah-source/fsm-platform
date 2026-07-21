# 133 — Per-zone Zonal-Manager logins (North / South / East / West)

Status: done
Type: AFK

> **Done 2026-07-20** — `InMemoryUserStore` now seeds `zm.south`/`zm.east`/`zm.west` (zones 2/3/4)
> alongside `zm.north`; `test/per-zone-zm-logins.e2e-spec.ts` (5/5) asserts each ZM's `zone_id` and the
> South-ZM cross-zone 403. No FE change (login is email/password). Uncommitted.

> Operator ask (2026-07-20): a separate login for the ZM of each operational zone. Today the dev
> auth seed carries a single `zm.north@fsm.test` (zone 1) — there is no South/East/West ZM account,
> so those zones cannot be signed into as their own manager.

## Problem (one paragraph)

The role + zone-scoping machinery is already end-to-end complete: JWT carries `{user_id, role,
zone_id}`, the global guard chain (`AuthGuard → RoleGuard → ZoneScopeGuard`, #99) clamps a ZM to
their `zone_id`, and the dashboard/report services filter by it. The only gap is *accounts*: the
in-memory dev store (`apps/backend/src/auth/user-store.ts`, still the live login path until #91's
Postgres-backed store lands) seeds exactly one ZM. Adding the three missing zone managers is a
data-seed change, not an architecture change.

## Zone → id mapping (from `org-seed.ts` SEED_ZONES order)

North=1, South=2, East=3, West=4, UNZONED=5.

## Acceptance criteria

- [ ] `InMemoryUserStore` seeds four ZM accounts, one per operational zone, each with the matching
      `zoneId`: `zm.north@fsm.test` (1), `zm.south@fsm.test` (2), `zm.east@fsm.test` (3),
      `zm.west@fsm.test` (4). Same seed password as the other dev users; scrypt-hashed (no plaintext).
      Distinct stable `userId` UUIDs.
- [ ] Each ZM logging in receives a token whose `zone_id` is their zone; a cross-zone request is
      rejected by the existing `ZoneScopeGuard` (403 ZONE_SCOPE_VIOLATION) — no new guard code.
- [ ] Existing OH / CSM / WM / SE seed accounts unchanged.
- [ ] Tests: an auth spec asserting each ZM authenticates and carries the correct `zone_id`, and that
      a South ZM cannot read a North-scoped resource (reuses the existing zone-scope e2e pattern).

## Dependencies / notes

- Blocked-by: none. Superseded by #91 when the Postgres credential store lands (the four accounts move
  from the seed array into the DB seed) — call that out in #91 so they carry over.
- Out of scope: any real-identity ZM names/emails (dev seed only); the Postgres credential store (#91).
