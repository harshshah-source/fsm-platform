# 167 — Request-scoped observability (trace a mobile session)

Status: ready-for-agent
Type: AFK · Backend (one embedded decision point, flagged below)

Filed 2026-07-28 (`docs/status/backend-mobile-readiness-plan-2026-07-28.md` §A-§9).
Today "SE says: I submitted at 10:30 and nothing happened" is unanswerable: successful requests
produce **zero log lines** (correlation IDs exist only inside the exception filter,
`all-exceptions.filter.ts:37-40`; no middleware/interceptor anywhere), failures produce one line
with **no user identity**, and never-arrived produces nothing. Non-blocking for mobile *development*;
**blocking for the field pilot** — the first month of rollout is otherwise undebuggable.

## What to build

1. **Correlation-ID middleware on every request**: honour client `x-correlation-id`, mint otherwise,
   echo on the response header, stash in AsyncLocalStorage; the exception filter reuses it instead
   of minting (`all-exceptions.filter.ts:37`). Add `correlationId` to the plain-HttpException JSON
   body too (today only 413/500 bodies carry it, `:42-49,63,74`) so a mobile client can always show
   a quotable ID.
2. **One structured access-log line per request**: correlationId, userId+role (from the verified
   token), method, route, status, latency ms — logged on response finish.
3. **Audit linkage**: optional `correlationId` on `AuditEntry` (`audit.service.ts:7-17`), populated
   from ALS — links the HTTP trace to the business trail. While there: `@@index([actorId, createdAt])`
   on `audit_logs` (per-SE support queries currently seq-scan; `schema.prisma:1365-1366` indexes
   `(entityType, entityId)` only).
4. Trailing (may split): per-endpoint counters/latency histogram (`/metrics`, prom-client) — the
   scrape/retention ops side belongs to #111.

**Embedded decision (Deferred-section discipline — #98 deliberately dropped pino; not silently
relitigated):** item 2 re-proposes structured logging **with new evidence**: a 1,000-device field
rollout where per-request lines are the only session-reconstruction surface, and the current state
(one anonymous line per failure, nothing per success) is measured unreconstructable. Format choice
(pino vs structured Nest logger) is the operator's one-line call; the middleware/ALS work is
format-agnostic.

Prerequisite recorded in #111: stdout must land somewhere durable (process manager / file), or
items 1–2 evaporate on restart.

## Acceptance criteria

- [ ] A client-supplied `x-correlation-id` appears on the response header and in the access log for a **successful** request
- [ ] Every 4xx/5xx JSON body carries `correlationId`
- [ ] Access log line carries userId/role/route/status/latency; verified for an SE-token request
- [ ] `audit_logs` rows written during a request carry its correlationId; `(actorId, createdAt)` indexed
- [ ] The 10:30 support scenario is walkable: given an SE id + time window, reconstruct request → outcome → business writes (documented runbook snippet)
- [ ] No change to #99's error envelope shapes beyond the additive field

## UI surfaces

n/a.

## Reference

n/a.

## Blocked by

- None. Do before field pilot; #111 owns log durability + metrics scrape ops.

## Comments

### 2026-07-28 — confirmed parallel-safe (freeze plan §3)

Unchanged in substance. Reclassified explicitly: this is **not** freeze-list work — it can land
*during* mobile development without disrupting it, because every part of it is additive. The
correlation-ID middleware adds a response *header*; the access log is server-side; the audit
`correlationId` and `(actorId, createdAt)` index are storage-layer. The only client-visible change
is `correlationId` appearing in 4xx bodies, which additive-only discipline permits.

Do it before the field pilot, not before mobile day 1.
