# 210 — A dev dataset: one SE who can log in AND has work to see

Status: ready-for-agent
Type: AFK · Backend · Dev environment
Parent: [#197](./197-mobile-pilot-readiness-remediation-epic.md) · Filed 2026-08-04
Blocked by: [#194](./194-no-dev-login-seed-path.md) (credentials must exist before work data is reachable)

## Root cause

Credentials and work data live on disjoint sets of users. The #91 fixture seed mints exactly one
Service Engineer with a password — `se.north@fsm.test` — and that user has never been given
coverage, a schedule, or a ticket. The 75 mock SEs that *do* hold dispatched work
(`se-z*@mock.fsm`) have no `user_credentials` row and cannot log in. So the app authenticates
perfectly and then renders empty on every screen, which is indistinguishable from a broken client.

## Findings closed

Audit 1: **A-4** (data half — the credential half is #194), **B-1**, **B-2**, **B-3**.

## Evidence — verified 2026-08-04 against the dev DB (`fsm` @ localhost:5433)

- `user_credentials`: **8 rows**, all #91 fixtures; exactly one is a `SERVICE_ENGINEER`
  (`se.north@fsm.test`, `auth-fixture-seed.ts:63-69`).
- `users`: 76 `SERVICE_ENGINEER` rows. The other 75 (`se-z*@mock.fsm`) have **no credential row**.
- For `se.north` (uuid `2222…2222`): `se_coverage` = **0**, `work_schedules` = **0**, tickets with
  `assigned_se_id` = **0**, `se_van_stock` = 0, `expense_vouchers` = 0, notifications = 0.
- Live probe with a real token — every SE endpoint returns **HTTP 200 and an empty payload**:
  `/me/tickets` `{"items":[],"cursor":null}` · `/schedules/me` `{"dispatched":false,…,"stops":[]}` ·
  `/me/van-stock` · `/me/component-requests` · `/notifications` · `/me/vouchers` ·
  `/me/leave-requests` · `/me/availability` · `/me/intraday-insertions`.
- Why it is empty by construction: `me-tickets-query.service.ts:39` scopes the pool branch to
  `coveredPlantIds`, and with zero `se_coverage` rows the branch matches nothing regardless of how
  many OPEN tickets exist (there are 16,552).
- Work data exists in bulk, just not for this user: `work_schedules` carries 40-63 ACTIVE rows/day
  through 2026-08-02 — all for credential-less mock SEs. **No schedule exists for 2026-08-03 or
  2026-08-04 at all.**
- **[#194](./194-no-dev-login-seed-path.md) explicitly excludes this:** *"Not seeding devices,
  tickets or telemetry — a dev dataset is a separate concern."* Confirmed no other issue owns it.

## Scope

**In:** a committed, idempotent, guarded entrypoint that leaves the dev database with **at least one
SE who can log in and immediately see a populated Home, Tickets, Stock and Ticket Detail** — coverage
rows, a live work schedule for the current day, a batch with assigned tickets across at least two
work types, and enough van stock to render the Stock tab.

**Out:** production seeding of any kind (must be impossible — same guard posture as #194). Telemetry
/ device-state fabrication (the dev DB already has 25,754 `device_states`; reuse them). Anything that
mutates the existing mock-SE data — the fixture SE gets its own coverage rather than stealing another
SE's schedule.

**Open choice for the implementer, record which was taken:** either (a) give `se.north@fsm.test`
coverage + a dispatched schedule, or (b) mint credentials for one mock SE that already holds a
schedule. (b) is less code but pins the dataset to whatever that SE happened to be dispatched; (a) is
deterministic and survives a re-dispatch. **(a) is recommended** for exactly that reason.

## Acceptance criteria

- [ ] One documented command seeds the dataset; running it twice is a no-op (idempotent)
- [ ] It refuses to run against production (`NODE_ENV=production` or an explicit `ALLOW_DEV_SEED`
      guard, matching #194's posture)
- [ ] After seeding, a login as the seeded SE returns non-empty payloads from `/me/tickets`,
      `/schedules/me` and `/me/van-stock` — asserted, not eyeballed
- [ ] The seeded plan contains at least one TROUBLESHOOT and one RECOVERY or INSTALL ticket, so the
      work-type-specific cards on Ticket Detail are all reachable
- [ ] The schedule is seeded relative to the current day, not a hardcoded date, so the dataset does
      not silently expire (note: this interacts with [#198](./198-decision-day-boundary-and-dispatch-clock.md) — use `utcDayStart` and record the dependency)
- [ ] The command is referenced from the #209 runbook

## Verification

```bash
cd apps/backend && pnpm seed:dev          # exact name to be chosen; idempotent
TOKEN=$(curl -s localhost:3000/api/v1/auth/login -X POST -H 'Content-Type: application/json' \
  -H 'X-Device-Id: probe' -d '{"email":"<seeded SE>","password":"<pw>"}' | jq -r .accessToken)
curl -s localhost:3000/api/v1/me/tickets -H "Authorization: Bearer $TOKEN" | jq '.items | length'
# must be > 0 — this is the assertion that fails today
```

## Risk if deferred

The app cannot be evaluated by anyone. A tester installs the build, logs in, sees an empty Home with
"Your plan is being prepared", empty Tickets, empty Stock — and has no way to tell a working app from
a broken one. Worse, this is the failure mode most likely to be misread as "the mobile app doesn't
work", sending investigation into the client when the client is fine. It also blocks every
acceptance criterion in this epic that says "an SE can complete X end-to-end".

## Size estimate

S-M. The seeding itself is small; picking a dataset that stays valid as dispatch runs re-write
schedules is the part that needs thought.
