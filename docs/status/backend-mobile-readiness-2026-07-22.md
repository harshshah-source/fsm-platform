# Backend + Web-App Readiness for the SE Mobile Client (1,000+ concurrent devices)

> **SUPERSEDED 2026-07-28 → [`mobile-backend-freeze-plan-2026-07-28.md`](./mobile-backend-freeze-plan-2026-07-28.md).**
> This assessment was reconciled with two later ones into a single execution plan written against a
> stricter bar (backend contract frozen *before* mobile starts). Its core framing held up — an SE
> cannot read a ticket, cannot log in, and the process cannot hold the connections. Four of its
> claims were corrected: the Shadow-Use double-decrement is armed-but-unreachable (`consumedComponents`
> is never wired from the controller); soft-states are retry-safe, not opaque; the offline fraud path
> needs ≥3 pings, not the first; and "no SE write accepts a client-supplied capture timestamp" is
> false (`vouchers` accepts `expenseDatetime`). Historical — do not update.

**Date:** 2026-07-22 · **Branch:** `feat/autoplant-integration` · **HEAD:** `ad03769`
**Type:** READ-ONLY assessment. No code changed, no issues filed, no design proposed.
**Scope:** backend + admin web app only. The mobile app is **not** being built; this asks what the
server side would need if it were.

Known findings are cited by ID, not re-derived: **#54** mobile foundation · **#76** notification
adapters · **#81** media upload · **#82** offline sync API · **#83** ticket search/QR · **#84**
technical hints · **#91** Postgres auth store · **#101** guarded transitions · **#103** hot-FK
indexes · **#104** append-only growth · **#105** module wiring · **#106** perf cliffs · **#107** CI ·
**#110** rate limiting · **#111** deployment/DR. Prior audits: `pipeline-risk-audit-2026-07-16`,
`ticket-and-assignment-review-2026-07-21`, `pattern-tracing-audit-2026-07-21`,
`2026-07-22-full-project-audit`.

**Headline:** the *field-loop write* surface is in good shape — better than expected. The
**read** surface, the **auth** surface, and the **connection/concurrency** surface are not. Three
things are hard blockers that no amount of mobile-side engineering can work around: an SE cannot
read a ticket, an SE cannot log in, and the process cannot hold the connections.

---

## 1. Endpoints — what an SE mobile client needs

15 of 52 controllers expose anything to `SERVICE_ENGINEER`. Status per capability:

### 1.1 Exists and is SE-callable

| Capability | Endpoint | Evidence |
|---|---|---|
| View day plan | `GET /api/schedules/me` | `scheduling/schedules.controller.ts:64-68` |
| View shared pool (secondary work) | `GET /api/me/shared-pool` | `shared-pool/shared-pool.controller.ts:19-20` |
| Soft states (VIEWED / ON_SITE / TROUBLESHOOT_STARTED) | `POST /api/tickets/:id/soft-state` | `soft-state/soft-state.controller.ts:34-35` |
| Activity ping | `POST /api/me/activity-ping` | `soft-state/soft-state.controller.ts:57-58` |
| Submit troubleshoot form | `POST /api/tickets/:id/troubleshoot` | `ticketing/troubleshoot.controller.ts:71-72` |
| Read own verification status | `GET /api/tickets/:id/verification` | `verification/verification.controller.ts:103-104` |
| Accept / decline intraday CRITICAL offer | `POST /api/intraday-insertions/:id/accept` · `/decline` | `intraday/intraday-insertion.controller.ts:64-77` |
| Read van stock | `GET /api/me/van-stock` | `inventory/inventory.controller.ts:42-43` |
| Confirm component receipt | `POST /api/component-requests/:id/confirm-receipt` | `component-request/component-request.controller.ts:42-43` |
| Recovery: on-site / collected / unable-to-collect | `POST /api/recovery/:id/…` | `ticketing/recovery.controller.ts:50-72` |
| Install: on-site / fitted | `POST /api/install/:ticketId/…` | `ticketing/install.controller.ts:190-200` |
| Install: **read ticket detail** | `GET /api/install/:ticketId` | `ticketing/install.controller.ts:216-217` (`INSTALL_READER_ROLES` includes `SERVICE_ENGINEER`, `:40-46`) |
| File vehicle unavailability | `POST /api/vehicle-unavailability` | `ticketing/vehicle-unavailability.controller.ts:57-58` |
| Create expense voucher | `POST /api/vouchers` | `vouchers/vouchers.controller.ts:62-64` |
| File leave request | `POST /api/leave-requests` | `engineers/leave-request.controller.ts:47-48` |
| Set own availability | `POST /api/engineers/:seId/availability` | `engineers/engineers.controller.ts:202-203` |
| Notifications list / mark read | `GET /api/notifications`, `POST …/read`, `POST …/read-all` | `notifications/notifications.controller.ts:16-33` (no `@Roles` ⇒ any authenticated user) |
| Identity | `GET /api/me` | `me/me.controller.ts:12` |

### 1.2 Exists but is **admin-only** — the SE cannot call it

| What the SE needs | Endpoint | Why it's blocked |
|---|---|---|
| **Read a troubleshoot ticket** | `GET /api/tickets/:id` | `ticketing/tickets.controller.ts:70-71` — `@Roles('ZONAL_MANAGER','CENTRAL_SERVICE_MANAGER','OPERATIONS_HEAD')`. **No SE.** |
| **List own tickets** | `GET /api/tickets` | `ticketing/tickets.controller.ts:38-39` — same three roles. |
| **Read own submitted form** | `GET /api/tickets/:id/forms` | `ticketing/tickets.controller.ts:83-84` — same three roles. |
| List own expense vouchers | `GET /api/vouchers` | `vouchers/vouchers.controller.ts:100-101` — `REVIEW_ROLES` = ZM/CSM/OH (`:26`). An SE can create a voucher and then never see it. |
| List own leave requests | `GET /api/leave-requests` | `engineers/leave-request.controller.ts:66-67` — manager roles only. Same one-way street. |

**This is the single largest functional gap.** `GET /api/schedules/me` returns only
`{ batchId, stopSequence, plantId, plantName, deviceCount, tickets: [{ticketId, sortOrder}] }`
(`scheduling/day-plan-query.service.ts:59-66`) — **ticket IDs and nothing else**. There is no
SE-callable endpoint that expands a ticket ID into device, vehicle, SLA bucket, tier, symptom,
history, or address. `GET /api/me/shared-pool` carries slightly more
(`shared-pool/shared-pool.service.ts:5-13`: workType, plant, tier, slaBucket, deviceId) but only for
*unassigned* pool work — never for the SE's own assigned tickets.

So today a mobile Ticket Detail screen (PRD M3) has **no data source**. Note the asymmetry: install
tickets *are* SE-readable (`install.controller.ts:216`), troubleshoot tickets are not.

### 1.3 Missing entirely

| Capability | Owner |
|---|---|
| Photo / media upload (`photoRefs` are accepted as opaque strings — `troubleshoot-submission.service.ts:139` — with no endpoint that produces them) | **#81** |
| Offline batch-sync / queued-write API | **#82** |
| Ticket search + QR lookup | **#83** |
| Technical hints derivation | **#84** |
| Direct "raise a component request" — today it is a side effect of `componentUnavailable: true` on the troubleshoot form (`troubleshoot.controller.ts` body → `troubleshoot-submission.service.ts`); there is no standalone SE endpoint | unowned |
| Accept / reject a **day-plan** ticket | *by design* — day plans apply immediately with no SE acceptance (SYSTEM-STATE §3h). Only intraday CRITICAL insertions have an accept/decline handshake. Worth confirming this is still the intended product behaviour before mobile design starts. |

---

## 2. Auth for mobile clients at scale

### 2.1 Would 1,000 concurrent SE logins work today? No — and not for the reason the docs emphasise.

**There is exactly one SE account in existence.** `auth/user-store.ts:25-65` is a hardcoded array of
**8 seed users**, of which one is an SE (`se.north@fsm.test`, `:44-48`). The 75 SEs in
`engineer_master` have no credentials and cannot authenticate at all. Onboarding SE #2 today means
editing source and redeploying. #91 is usually described as a durability problem; for mobile it is
first an **existence** problem.

**What breaks first, in order:**

1. **Login throughput — the event loop.** `validateCredentials` uses **`scryptSync`**
   (`auth/user-store.ts:78`) — the *synchronous* KDF. Node is single-threaded, so every login
   blocks the entire process for the duration of the hash (Node's default scrypt cost is
   ~50–100 ms). That caps login at roughly 10–20/sec **process-wide**, and while it runs, *every
   other request* — day plans, form submissions, admin dashboards — is stalled. A 1,000-device
   morning login burst is a self-inflicted outage. This is a sharper statement of **#110** than
   "CPU-DoS vector": no attacker is needed, the normal shift-start pattern does it.
2. **Restart wipes every session.** `InMemoryUserStore` and `InMemoryRefreshTokenStore` are
   process-local (`auth/refresh-token-store.ts:16` says so explicitly). Any deploy, crash, or
   OOM logs out all 1,000 devices simultaneously — which then produces the login burst in (1).
3. **Refresh-token memory leak.** `InMemoryRefreshTokenStore` holds a
   `Map<string, RefreshRecord>` (`:20`) and `consume()` marks `revoked: true` (`:35`) but
   **never deletes**, and nothing sweeps expired records. Every login and every refresh adds a
   permanent entry. At 1,000 SEs on 15-minute access tokens (~32 refreshes per 8-hour shift) that
   is ~32,000 new entries per day, never reclaimed, for a 30-day TTL that is never enforced by
   eviction. Unbounded growth in the same process that serves requests.
4. **Multi-instance impossible.** Both stores are per-process, so you cannot run two replicas —
   a refresh token minted on instance A is unknown to instance B. Combined with the in-process cron
   (§5.5) this means **the mobile backend is single-instance by construction**, which is also its
   scaling ceiling.

### 2.2 Token model — suitability for mobile

| Property | Current | Mobile fit |
|---|---|---|
| Access token | HS256 JWT `{user_id, role, zone_id}`, **15 min** (`auth/token.service.ts:22`) | Short for a field client on 2G/no signal. Every 15 min the app must reach the server or lose access mid-job. |
| Refresh token | Opaque 32-byte random, **30 days**, single-use rotating with reuse detection (`refresh-token-store.ts:21-37`) | Rotation model is correct and mobile-appropriate. Storage is not (§2.1). |
| Claims | No `iss`, `aud`, `jti`, or `kid` (`token.service.ts:26-32`) | No `jti` ⇒ **no access-token revocation**: a revoked/stolen token stays valid for up to 15 min. No `kid` ⇒ **secret rotation is a hard cutover** that invalidates every session at once. |
| Revocation granularity | Per-token only — `consume(token)` (`:30`). There is **no `revokeAllForUser`** | **Device loss cannot be handled.** There is no way to invalidate one lost handset, or all of a user's sessions, without restarting the process (which logs out everyone). |
| Verification | Signature + `exp` only (`token.service.ts:42-52`) | Correct as far as it goes. |

### 2.3 Rate limiting — 1,000 retry-storming clients

**None exists** (#110 — confirmed: no throttler, guard, or middleware anywhere in
`apps/backend/src`). `POST /api/auth/login` and `/refresh` are `@Public()`
(`auth/auth.controller.ts:11-22`), so they bypass the global guard chain entirely.

Combined with §2.1(1): 1,000 clients retrying a failed login each trigger a blocking 50–100 ms
`scryptSync`. There is no queue limit, no per-IP or per-account backoff, and no circuit breaker.
The failure mode is not "slow login" — it is **total server stall**, including the admin dashboard.
A mass-logout event (§2.1(2)) is exactly the trigger that produces the storm.

One incidental hardening gap: `validateCredentials` returns `null` immediately when the email is
unknown (`user-store.ts:75`) without hashing a dummy, so response timing distinguishes "no such
user" from "wrong password" — user enumeration.

### 2.4 Device identity

**Does not exist, at any layer.** No `device_token`, `push_token`, `fcm`, or `apns` column anywhere
in `prisma/schema.prisma` (grep: zero hits). `notifications` is keyed only on `recipient_user_id`
(`schema.prisma:1350`). Refresh records store `{ userId, expiresAt, revoked }`
(`refresh-token-store.ts:4-8`) — no device, no platform, no last-seen.

Consequences: push cannot be addressed even after #76 lands the adapters; "log out my other device"
is unimplementable; multi-device (SE with a phone and a tablet) is undefined behaviour; and there is
no way to attribute a bad session to a handset.

---

## 3. Idempotency and retry-safety

A mobile client on intermittent connectivity retries. Coverage today is **two endpoints**.

### 3.1 Endpoints with a client-supplied idempotency key

| Endpoint | Key | Evidence |
|---|---|---|
| `POST /api/tickets/:id/troubleshoot` | `clientSubmissionId`, unique `(se_id, client_submission_id)` | `troubleshoot-submission.service.ts:107-110`; `schema.prisma:821`. Required — 400 without it (`troubleshoot.controller.ts:74-76`). |
| `POST /api/vouchers` | `clientSubmissionId`, same unique scope | `vouchers.service.ts:158`; `schema.prisma:882`. Required (`vouchers.controller.ts:66`). |

### 3.2 Endpoints with **no** idempotency key

`POST /tickets/:id/soft-state` · `POST /me/activity-ping` · `POST /intraday-insertions/:id/accept`
and `/decline` · `POST /recovery/:id/on-site` · `/collected` · `/unable-to-collect` ·
`POST /install/:ticketId/on-site` · `/fitted` · `POST /vehicle-unavailability` ·
`POST /component-requests/:id/confirm-receipt` · `POST /leave-requests` ·
`POST /engineers/:seId/availability`.

Most are protected by something else, and the distinction matters for mobile:

- **Genuinely idempotent — safe:** intraday accept/decline. `intraday-insertion.service.ts:139-148`
  returns the same successful payload on a retried accept, and the atomic claim at `:156-160`
  (`transitionOrConflict`) plus the one-live-offer partial unique settle the accept-vs-timeout race.
  **This is the reference implementation** the other SE endpoints should be measured against.
- **State-machine guarded — safe but opaque:** recovery and install transitions reject from the
  wrong state (`recovery.service.ts:141` `WRONG_STATE`; ownership at `:107,123,179`). A retry after
  a successful-but-unacknowledged call returns a **409 that is indistinguishable from a genuine
  conflict**, so the client cannot tell "already done" from "someone else did it".
- **Soft states** are backed by partial unique `ux_ss_active (ticket_id, se_id, type) WHERE
  resolved_at IS NULL`, so a duplicate is rejected rather than duplicated — same opacity problem.
- **`POST /vehicle-unavailability`** has no key and no uniqueness constraint — a retry files a
  **second VU report**, each pausing the SLA clock. (Impersonation is *not* possible: although the
  controller takes `body.seId` (`:60`), the service enforces `actor.userId === input.seId` for
  non-managers — `vehicle-unavailability.service.ts:68`.)
- **`POST /leave-requests`** — same shape; a retry files a duplicate leave request.

### 3.3 Van stock, submission, verification — reconciled against #101

Both #101 sub-findings **confirmed still open**, at line level:

1. **Lost-update on van-stock decrement.** `decrementStock` is read-then-write:
   `findUnique` at `troubleshoot-submission.service.ts:315`, then
   `update({ data: { qty: Math.max(0, row.qty - qty) } })` at `:317-320`. Not an atomic
   `{ decrement: qty }`. Two concurrent transactions both read `qty=5` and both write `4` — one
   consumption vanishes. Mobile makes this materially more likely (retries + two SEs racing the
   same shared-pool ticket).

2. **The 409/Shadow-Use path is not idempotent and re-decrements on every retry.** This is the
   one that actually double-decrements from a mobile retry. Sequence:
   `submit()` checks the idempotency key first (`:107`); if the ticket is already closed it calls
   `handleConflict` (`:116`), which decrements van stock and writes `SHADOW_USE` rows
   (`:275-290`) **without ever creating a `troubleshooting_submissions` row** — so
   `clientSubmissionId` is never persisted on this path. A client that retries after the 409
   re-enters `submit()`, finds no existing submission at `:107`, hits `handleConflict` again, and
   **decrements the same components again**, appending another SHADOW_USE ledger row each time.
   Every retry compounds.

3. **Verification** — no SE-driven write path (sweeps own it), so no mobile retry exposure. The
   `verification.finalize` #101-class instance noted in `pattern-tracing-audit-2026-07-21` is
   sweep-side and unchanged.

**Net: the one endpoint an SE hits most, under the exact conditions mobile creates, double-decrements
inventory.**

---

## 4. Data shape and payload size

Measured against the live dev DB, 2026-07-22.

| Endpoint | Bound | Measured |
|---|---|---|
| `GET /api/schedules/me` | Bounded by `daily_capacity` | **worst 25 tickets, avg 21** per SE today. Payload is IDs + plant names — a few KB. **Fine.** |
| `GET /api/me/shared-pool` | **Unbounded — no `take`, no pagination, no filter** (`shared-pool/shared-pool.service.ts:31-38`) | **worst 1,030 tickets for a single SE**, avg 202, 9,100 rows total across 67 covered SEs. At ~150 B/ticket that is **~155 KB for the worst SE**, ~30 KB average — **per poll**. |
| `GET /api/notifications` | Bounded: `limit` clamped 1–200, default 50 (`notification.service.ts:91`) | Well-indexed (`schema.prisma:1363-1364`). **But the controller never passes `limit`** (`notifications.controller.ts:17-18`) and there is no cursor or `since` parameter — a client is stuck with the newest 50 and cannot page back or delta-sync. |

**Admin-scale data reachable with SE credentials:** none of the wide admin reads
(`/api/tickets`, `/api/devices`, `/api/dashboard/*`, `/api/exports/*`) are SE-callable — they are
manager-gated. The leak is not role-level; it is that **the one unbounded SE read is unbounded by
design** and grows with the ticket backlog rather than with the SE's workload.

Pagination posture generally: the SE surface has **no paginated endpoint at all**. Day plan, shared
pool, van stock, and notifications are all "return everything" (or a fixed 50). Adding cursors later
is a breaking client change, which is why it belongs before mobile starts, not after.

---

## 5. Backend scalability — the 1,000-concurrent-SE surface

### 5.1 Connection pool — the hard ceiling

`PrismaService` constructs `PrismaPg` with **only** `connectionString` and the UTC `options`
(`prisma/prisma.service.ts:28-37`). No `max`, no `connectionTimeoutMillis`, no `idleTimeoutMillis`.
`DATABASE_URL` carries no `connection_limit` or `pool_timeout` either
(`postgresql://fsm:***@localhost:5433/fsm?schema=public`).

`@prisma/adapter-pg` wraps node-postgres `Pool`, whose defaults are **`max: 10`** and
**`connectionTimeoutMillis: 0` (wait forever)**. So:

- One backend process serves all traffic from **10 database connections**.
- Acquisition has **no timeout** — a request that cannot get a connection queues indefinitely
  rather than failing fast. There is no backpressure signal a mobile client could react to.
- Postgres itself allows far more headroom: `max_connections = 100`, currently 6 in use. The
  bottleneck is entirely the un-configured client pool.

At 1,000 devices polling, request concurrency is bounded at 10 and everything else queues. Latency
degrades without any error — the worst diagnostic shape.

### 5.2 Statement timeouts — none

Measured on the live database:

- `statement_timeout = 0`
- `idle_in_transaction_session_timeout = 0`

Neither is set at the server, and neither is set per-session by the adapter (`prisma.service.ts:36`
passes only `-c timezone=UTC`). A single slow or stuck query holds one of the ten connections
indefinitely; a transaction that stalls mid-flight holds its locks indefinitely. Ten such requests
take the whole service down. This is **#106**, quantified.

### 5.3 Query patterns and hot paths

- **`GET /api/me/shared-pool` runs two queries then an unbounded `findMany` with two nested
  includes** (`shared-pool.service.ts:31-38`, `:52-57`) — not an N+1, but the result set is the
  problem (§4).
- **`tickets.vehicle_id` is still unindexed** (#103; `model Ticket` declares `@@index` on
  `(status, plantId)`, `(workType, status)`, `(companyId)`, `(deviceId, createdAt desc)`,
  `(nonOpMarkingId)` — none on `vehicleId`). The `(device_id, created_at desc)` leg landed
  2026-07-14 and is committed.
- **`audit_logs` index/query mismatch** (reported in `2026-07-22-full-project-audit` §3.2) — the
  monthly ZM aggregation seq-scans. Not on an SE path, but it competes for the same ten connections.
- **Long transactions on SE paths:** none found. The troubleshoot submission transaction
  (`troubleshoot-submission.service.ts:120-…`) is short and does no external I/O.

### 5.4 Advisory locks — clean

Every advisory lock in the codebase is `pg_try_advisory_xact_lock` (non-blocking, fail-fast) and
none sits on an SE request path: `dispatch_zone_<id>` (`batch-assignment.service.ts:68`),
`snapshot_run` (`snapshot-run.service.ts:48`), `master_sync_run` (`master-sync-run.service.ts:64`).
The one blocking `pg_advisory_xact_lock` is the #130 runtime lock (`build-info/runtime-lock.ts:155`),
taken once at boot. **No SE-vs-SE or SE-vs-sweep lock contention exists.** This is a genuine
strength and should not be regressed.

### 5.5 Scheduler overlap

Cron is in-process `@nestjs/schedule` and shares the same ten-connection pool and the same event
loop as mobile requests. `BUSINESS_SWEEPS_ENABLED=true` is currently set, so 10 sweeps run at
fixed cadences (2-min intraday timeout, 5-min verification ×2, 15-min ×2, plus dailies) —
several fire on the same minute boundary (`pipeline-risk-audit-2026-07-16` NEW-6). During the
05:00 dispatch run, a zone-wide dispatch transaction holds a connection for the duration of the run;
run 4 (2026-07-22 09:31) produced 52 schedules / 80 batches / 1,114 tickets in one pass.

With 10 connections, a heavy sweep and a mobile login burst are competing for the same scarce
resource with no timeout on either side. And because the in-memory sweep lock is process-local
(`pipeline-risk-audit-2026-07-16` NEW-5), the obvious mitigation — run a second replica for mobile
traffic — would double-run every sweep.

---

## 6. Real-time and delivery

**How would a mobile client learn about a new ticket today? Polling only.** There is no WebSocket,
no SSE, no long-poll, and no seam for one anywhere in the backend.

The notification spine is real but stops at the process boundary:

- `NotificationService` writes `notifications` + `notification_deliveries`, always fires the in-app
  channel, and walks a push→SMS→WhatsApp→email fallback chain
  (`notifications/notification.service.ts:68-72, 146-174`).
- `NotificationChannelGateway` (`notifications/notification-channel.gateway.ts:18`) is a **seam with
  no adapter behind it** — nothing is actually sent (#76).
- Day-plan dispatch fires its notifier **post-commit, in-process, with no outbox**
  (`batch-assignment.service.ts:223-225`) — a crash between commit and notify loses the event
  silently. Same shape as #140.

**What a mobile client would need, none of which exists:** a device-token registry (§2.4), a real
FCM/APNs adapter (#76), a durable outbox so a notification survives a crash, and either a delta/
`since`-cursor on `GET /api/notifications` (§4) or a push-triggered refetch. Until then the only
workable pattern is polling `GET /api/schedules/me` + `GET /api/notifications` on a timer — which is
precisely the load pattern §5.1 cannot absorb.

---

## 7. Offline / intermittent connectivity

**No write on the SE surface accepts a client capture timestamp.** Every SE write is stamped with
the server clock at arrival: `submittedAt: now` (`troubleshoot-submission.service.ts:140`, where
`now = input.now ?? new Date()` and no controller passes `input.now` — `troubleshoot.controller.ts:80-96`).
The same pattern holds for soft states, recovery, and install transitions.

**This is not cosmetic — it breaks verification.** GPS verification searches for pings *after* the
submission time: `gpsDatetime: { gt: submission.submittedAt }` (`verification/verification.service.ts:159`),
and Phase 1 must pass within 24 h of run start or the ticket is failed (`:182-187`). An SE who fixes
a device at 10:00 in a dead-signal zone and uploads at 16:00 has their submission stamped 16:00, so
**the very pings that prove the fix — 10:00 to 16:00 — are excluded from the search**. The genuine
repair is recorded as `FAILED_VERIFICATION`, and the inventory `PRE_VERIFICATION` reservation is
rolled back with it. Offline submission and GPS verification are, as currently built, mutually
incompatible.

The SLA clock has the same exposure: `failure_cycles` pause/resume bookkeeping is server-stamped, so
a late-arriving VU report pauses the clock from upload time, not from when the vehicle actually
became unavailable.

**Ordering:** nothing enforces or records client-side ordering. Two writes captured offline in order
A→B can arrive B→A with no sequence number and no vector clock; the state machines will accept
whichever transition is legal from the current state and reject the other with a 409 that carries no
"you're out of order" signal.

**Conflict resolution:** partial. Optimistic `version` columns exist on `failure_cycles`, `tickets`,
`component_request`, `non_operational_markings`, but enforcement is per-service and incomplete
(#101). The one well-built case is intraday accept-vs-timeout (`transitionOrConflict`,
`intraday-insertion.service.ts:156-160`). The two-SEs-on-one-ticket case is handled by the business
409 + Shadow Use path — which is itself the non-idempotent one (§3.3).

---

## 8. Multi-tenancy / zone scoping under SE identity

**`ZoneScopeGuard` is a no-op for service engineers.** `common/guards/zone-scope.guard.ts:27-29`:

```ts
if (!user || user.role !== 'ZONAL_MANAGER') {
  return true;
}
```

Only `ZONAL_MANAGER` is clamped. For an SE the guard passes unconditionally, so **there is no
structural scoping backstop on the SE surface** — every SE-facing endpoint must enforce ownership by
hand, and the correctness of the whole mobile authorization story is per-endpoint discipline.

Spot-checked, that discipline is mostly good:

| Endpoint | Ownership enforcement | Verdict |
|---|---|---|
| `GET /schedules/me`, `GET /me/shared-pool`, `GET /me/van-stock` | Keyed on `user.user_id`; shared pool additionally scoped to `se_coverage` ∪ floating-territory MV (`shared-pool.service.ts:52-59`) | Correct |
| `POST /intraday-insertions/:id/accept` | `ins.offeredSeId !== seId → NOT_OFFERED` (`intraday-insertion.service.ts:150`) | Correct |
| `POST /recovery/:id/*` | `isAssignedSe(ticket, actor)` (`recovery.service.ts:107,123,179`) | Correct |
| `POST /vehicle-unavailability` | `actor.userId === input.seId` for non-managers (`vehicle-unavailability.service.ts:68`) | Correct — the client-supplied `seId` is *not* trusted |
| `POST /tickets/:id/troubleshoot` | **None.** `seId` is taken from the token (`troubleshoot.controller.ts:82`, so no impersonation), but the service validates only existence, `workType`, and `status === 'OPEN'` (`troubleshoot-submission.service.ts:112-116`). There is **no check that the SE is assigned to, or even covers, this ticket.** | **Gap** |

**The gap in detail:** any authenticated SE can submit a troubleshoot form against **any** OPEN
troubleshoot ticket in the entire fleet — 9,280 of them today, across all five zones — simply by
knowing or guessing a ticket UUID. The read path is coverage-scoped
(`SharedPoolService.coveredPlantIds`) but the write path is not, so the API is scoped on the way in
and open on the way out. This closes tickets in other zones, writes root-cause analytics attributed
to the wrong SE, decrements the wrong van stock, and triggers verification on a device the SE never
visited. Ticket IDs are UUIDs, so this is not trivially enumerable — but it is not an authorization
control either.

---

## 9. Observability

**Could we tell that a specific mobile SE had a bad session? Largely no.**

- **Correlation IDs exist but only on failures.** `common/filters/all-exceptions.filter.ts:37` reads
  `x-correlation-id` or mints one, echoes it on the response (`:40`), logs it (`:47,62,70`), and
  returns it in the error body (`:63,74`). A mobile client *can* send its own and have it honoured —
  genuinely useful. But it is minted **inside the exception filter**, so successful requests get
  no correlation ID, nothing is logged for them, and the ID is never written to `audit_logs`. You
  can trace one error, not a session.
- **No request logging.** No access log, no per-request latency, no per-user or per-endpoint
  counters. The Nest default logger was deliberately retained over pino (#98, documented decision).
- **No metrics endpoint.** No Prometheus, OpenTelemetry, or health-beyond-liveness surface. The
  `/api/integration/health` route reports pipeline freshness and #130 build state, not request-path
  health.
- **SE-granular audit exists but only for business actions.** `audit_logs` records actor + role and
  `ticket_events` records lifecycle transitions, both durable and queryable per SE. That answers
  "what did this SE do", never "was this SE's app working".
- **`engineer_master.lastActivityAt`** (fed by `POST /me/activity-ping`,
  `soft-state.service.ts:194`) is the closest thing to a device-liveness signal — but it is
  deliberately excluded from scoring (ADR-0023/24) and is not surfaced as an ops metric.

Net: a support call saying "my app has been failing all morning" is currently answerable only by
grepping stdout for the correlation IDs the engineer happened to screenshot.

---

## 10. What must land before mobile development can meaningfully start

Ranked by blast radius at scale × likelihood a mobile client hits it × how much harder it is to add
later than now.

**1. SE-readable ticket endpoints (§1.2).** Hard blocker, not a scaling issue. The day plan returns
ticket IDs and there is no SE-callable way to expand them, so the central screen of the app (M3
Ticket Detail) has no data source — and neither do the vouchers or leave-request history screens.
This must be settled before mobile design starts because the *shape* of that payload determines the
client's entire data model, its offline cache schema, and its sync granularity. Retrofitting a
different ticket shape after the app ships is a migration on every installed device.

**2. Postgres-backed auth with per-user revocation and async hashing (#91, §2).** Hard blocker:
one SE account exists in a hardcoded array. Beyond existence, three properties are cheap now and
expensive later — async hashing (the `scryptSync` event-loop stall, `user-store.ts:78`), a `jti` or
equivalent so a lost handset can be revoked without restarting the process, and persistent refresh
tokens so a deploy doesn't log out 1,000 devices. Token *format* changes are client-breaking, so the
claim set should be settled before the first client ships.

**3. Connection pool sizing + statement timeouts (#106, §5.1–5.2).** Highest blast radius of
anything here: 10 connections, no acquisition timeout, `statement_timeout = 0`,
`idle_in_transaction_session_timeout = 0`. At 1,000 polling devices the service degrades into
unbounded queuing with no error and no backpressure. This is server-side only and could be fixed
later — but it is also a handful of configuration values, and leaving it means every mobile load
test measures the wrong thing.

**4. Rate limiting on `/auth/login` and `/auth/refresh` (#110, §2.3).** The dangerous interaction is
with (2): a restart wipes sessions → 1,000 devices retry → each retry blocks the event loop on a
synchronous KDF → the server stalls → clients retry harder. Mobile turns #110 from a security
control into an availability control. Cheap now; a production incident later.

**5. Pagination and bounding on `GET /me/shared-pool` (§4).** Measured worst case is 1,030 tickets
(~155 KB) for one SE on every poll, and it scales with the backlog rather than the workload. Adding
a cursor after clients exist is a breaking change to the client's list-loading logic, so it is
materially cheaper now. Same argument for a `since`/cursor on `GET /notifications`, which currently
cannot page at all (`notifications.controller.ts:17`).

**6. Idempotency keys on the remaining SE mutations, and fixing the Shadow-Use retry path
(§3.2–3.3).** Two endpoints have keys; a dozen do not. The concrete bug — the 409/Shadow-Use path
never persists `clientSubmissionId` (`troubleshoot-submission.service.ts:265-303`) so every mobile
retry re-decrements van stock — will fire in normal use, not just under adversarial conditions. The
lost-update in `decrementStock` (`:315-320`) compounds it. Idempotency semantics are part of the
client contract; adding them later means the client must handle both shapes.

**7. Client capture timestamps on SE writes (§7).** Today a submission is stamped on arrival, and
verification searches for pings *after* that stamp (`verification.service.ts:159`), so an offline
submission uploaded hours later has the evidence of its own success excluded and is failed. Any
offline story is unbuildable until writes carry a client capture time and the verification window
keys off it. This is a data-model decision that touches `troubleshooting_submissions`,
`verification_runs`, and SLA pause bookkeeping — far cheaper before rows exist.

**8. Device-token registry + a real push adapter (#76, §2.4, §6).** Nothing addresses a handset:
no token table, no adapter, no outbox. Without it the only delivery mechanism is polling, which is
the load pattern (3) cannot absorb — so (8) and (3) are the same problem approached from two sides.
The registry is a small additive table; the decision it waits on is a provider choice.

**9. Ownership enforcement on `POST /tickets/:id/troubleshoot` (§8).** Any SE can submit against any
OPEN troubleshoot ticket fleet-wide, because `ZoneScopeGuard` is a no-op for SEs
(`zone-scope.guard.ts:27-29`) and the service checks only existence/type/status. Ranked ninth
because ticket IDs are UUIDs and today there is one SE account — but it is a genuine authorization
gap that becomes real the moment 1,000 SEs hold credentials, and the fix (a coverage/assignment
check mirroring `SharedPoolService.coveredPlantIds`) is much easier before other SE write paths
copy the current pattern.

**10. Request-scoped observability (§9).** Correlation IDs exist only inside the exception filter,
so successful requests are untraceable and nothing correlates to `audit_logs`. Without this, the
first month of mobile rollout is undebuggable — every field report becomes a guess. It is also the
one item on this list that is genuinely *easier* to add later, which is why it ranks last; it is
here because "we'll add logging when we need it" is how the first mobile incident becomes a week.

**Deliberately not ranked:** #107 CI, #111 deployment/DR, #104 retention, #105 module wiring.
All real, all cited elsewhere, none specific to the mobile surface.

### HITL decisions required (listed, not recommended)

1. **Push provider** — FCM only, or FCM + APNs? Determines the token-registry shape.
2. **Offline strategy** — full offline-first (PRD §309-310 names WatermelonDB/SQLite) vs
   online-with-retry-queue. Determines whether #82 is a sync API or just idempotency keys.
3. **Access-token lifetime for mobile** — keep 15 min, or a longer mobile-specific TTL? Affects
   refresh volume, which drives §2.1(1) and (3).
4. **One device per SE, or many?** Determines whether refresh tokens are per-device and whether
   "log out other devices" exists.
5. **Client capture timestamp as authority** — does an SE-supplied capture time become the SLA and
   verification anchor, and if so what is the maximum accepted backdating window?
6. **Day-plan acceptance** — do SEs accept/reject assigned day-plan tickets (they do not today —
   only intraday CRITICAL offers have a handshake), or does the plan remain apply-immediately?
7. **Shared-pool scope on write** — should an SE be able to submit against any covered-plant ticket,
   only assigned tickets, or covered-plant tickets they have explicitly claimed? (§8 has no
   enforcement today, so there is no de-facto answer to preserve.)
8. **Multi-instance target** — if the mobile backend must scale horizontally, the in-process
   scheduler and in-memory auth stores both have to move; if single-instance is accepted, that
   becomes a documented capacity ceiling in #111.

---

*Read-only assessment. No code changed, no issue files created, no design proposed. Measurements
taken with `SELECT`-only queries against the dev database on 2026-07-22; the probe script was
deleted.*
