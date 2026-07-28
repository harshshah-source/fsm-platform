# Backend Readiness for SE Mobile — Verification, Gap Analysis, Execution Plan

> **SUPERSEDED 2026-07-28 → [`mobile-backend-freeze-plan-2026-07-28.md`](./mobile-backend-freeze-plan-2026-07-28.md).**
> Reconciled into a single plan written against a stricter bar. Corrections applied there: this
> document's **N22 ranking of contract stability as "low / nice-to-have / unfiled" was wrong** — by
> its own cheap-now-breaking-later logic it is foundational, and it has been promoted. Its fraud-path
> mechanism was misdescribed (≥3 pings required, not the first), its "no client capture timestamp"
> premise is false, and `confirm-receipt`'s SLA-resume side effect is dormant (setting default-off).
> Its issue set #161–#167 is revised in place. Historical — do not update.

**Date:** 2026-07-28 · **Branch:** `feat/autoplant-integration` · **HEAD:** `0d3b85d`
**Type:** READ-ONLY re-verification of `backend-mobile-readiness-2026-07-22.md` + filed execution plan.
No code changed. Deliverables: this document, new issues **#161–#167**, extensions appended to
**#91 #101 #106 #82 #76 #110 #147 #111**, INDEX registration.
Method: 8 parallel evidence-gathering passes (endpoints, auth, retry-safety, authz, offline,
connections, observability, July 22–28 delta), each with file:line evidence; live-DB measurements
were SELECT-only aggregates (AutoPlant <100-row cap respected), probes deleted.

---

## E first — the blunt readiness verdict

**If a mobile engineer starts next week, they hit the first wall in under a day, and the core
field loop is unbuildable for weeks.**

- **Hour 0 – day 1:** they can build #54's shell and log in — as `se.north@fsm.test`, the **only SE
  credential in existence** (`auth/user-store.ts:45-49`). No real SE can log in until #91. Every
  screen they build is tested against one synthetic identity.
- **Day 1–3 (what is actually buildable today):** Home tab skeleton, day-plan *list* (IDs + plant
  names only), van stock, notifications (newest-50, no paging), availability toggle, voucher
  *create* (the SE can never see the voucher again), leave *create* (same one-way street). That is
  roughly **2 of ~14 M-series screens completable**.
- **The wall (day 3):** **M3 Ticket Detail has no data source** — `GET /api/tickets/:id` is
  manager-only (`tickets.controller.ts:70-71`), recovery tickets have no GET at all, and issue #57's
  own pinned API contract cites the endpoint the SE cannot call. The central screen of the app, and
  everything downstream of it (troubleshoot form context, VU screen's transporter info, hints),
  is blocked on **#161**.
- **Even the working screens lie:** measured today, **21 of 64 SEs' latest live schedule is entirely
  past-dated** — `/schedules/me` has no date predicate (`day-plan-query.service.ts:41-46`), so a
  third of the fleet would open the app and see an old plan presented as today's (#147). One live
  schedule holds **1,453 tickets** and would be served whole.
- **What must not happen:** 1,000 real credentials (#91) must not ship before the row-level
  authorization floor (#162) — today any authenticated SE can submit a troubleshoot form, or stamp
  soft states, against **any of 13,941 OPEN troubleshoot tickets across all 5 zones / 146 plants**
  (measured; was 9,280 on 07-22, +50% in six days). And no load test before #106's config fix —
  10 DB connections, no acquisition timeout, `statement_timeout=0` means the failure mode is silent
  unbounded queuing, not errors.
- **What improved since 07-22:** #153 (overridden plans stay live — the SE blank-day-plan mode is
  gone), #146 (defer is coherent end-to-end), #148 (verification can no longer expire on stale
  telemetry). The July window introduced **no new SE-surface defects** — but also touched none of
  the ten ranked mobile findings. **Auth: zero commits.**

**Bottom line:** backend-first weeks 1–2 (#91+#110, #161+#162, #147, #106-config — plus the Gate-0
decisions below) buy mobile an unblocked runway. Start mobile UI in parallel only on the 2 screens
that work; do not start the client data layer until #165/#164/#166 contracts are settled, because
every one of them is client-breaking to retrofit.

---

## A. Verification table — every prior-audit finding vs HEAD `0d3b85d`

Verdicts: **ST** still-true · **PA** partially-addressed · **NL** no-longer-real · **WT** worse-than-stated.

### §1 Endpoints / read surface

| # | Prior finding | Verdict | Evidence & what changed |
|---|---|---|---|
| 1.1 | 19 SE-callable capabilities exist (writes in good shape) | **ST** | Re-confirmed per-endpoint; plus `POST /vouchers/:id/resubmit` newer than the audit (`vouchers.controller.ts:161-163`) |
| 1.2 | `GET /tickets/:id`, `GET /tickets`, `GET /tickets/:id/forms` admin-only — SE cannot read a troubleshoot ticket | **ST** | `tickets.controller.ts:70-71`, `:38-39`, `:83-84`. Nothing since 07-22 touched this. → **#161** |
| 1.2 | `GET /vouchers`, `GET /leave-requests` manager-only (one-way streets) | **ST** | `vouchers.controller.ts:100-101` (`REVIEW_ROLES` `:26`); `leave-request.controller.ts:66-67` → **#163** |
| 1.2 | Install-readable / troubleshoot-not asymmetry | **ST** | `install.controller.ts:216-217` + own-ticket scope `install-lifecycle.service.ts:266`; recovery has **no GET at all** (`recovery.controller.ts:52-72` POST-only) — sharper than stated |
| 1.3 | #81/#82/#83/#84 missing entirely | **ST** | No media/search/hints controller in `src/` (grep 07-28) |
| 1.3 | Day-plan acceptance is by design apply-immediately | **ST** | Unchanged; still needs product confirmation before mobile design (HITL-6) |
| — | *(missed by prior audit)* no SE read of own pending intraday offer | **new** | `GET /intraday-insertions` manager-only (`intraday-insertion.controller.ts:37-38`); after app restart the offer is recoverable only via notifications → **#163** |

### §2 Auth (zero auth-touching commits since 07-22 — every claim stands verbatim)

| # | Prior finding | Verdict | Evidence & what changed |
|---|---|---|---|
| 2.1 | One SE account, hardcoded 8-seed store | **ST** | `user-store.ts:22-65` — now 4 ZMs (#133, 07-20) + 1 SE + OH/CSM/WM; still exactly **one SE**, 75 `engineer_master` SEs credential-less → **#91** |
| 2.1 | `scryptSync` blocks the event loop per login | **ST** | `user-store.ts:78`; `auth.service.ts:19`. **#91 as written would carry it forward** — its Scope 2 says keep scrypt "exactly as in `user-store.ts`" (`91-…md:113-114`) → #91 extension |
| 2.1 | Refresh store unbounded; `consume()` never deletes; restart wipes sessions; multi-instance impossible | **ST** | `refresh-token-store.ts:20,35`; no eviction; process-local by doc-comment `:15-16` → #91 (in scope: `:117-119,156-158`) |
| 2.2 | No `jti`/`kid`/`iss`/`aud`; 15-min/30-day TTLs; no `revokeAllForUser` | **ST** | `token.service.ts:22-32`; `refresh-token-store.ts:23-37`. #91 **freezes** claims + TTLs (`:103-105,133-135,148-150`) — reopening either is an explicit decision (HITL-3) |
| 2.3 | No rate limiting; login/refresh `@Public` | **ST** | `@Public()` now controller-wide (`auth.controller.ts:12`); zero throttler code (grep 07-28) → **#110** (unchanged, sufficient as written) |
| 2.3 | User-enumeration timing | **ST** | `user-store.ts:75-76` |
| 2.4 | Zero device identity anywhere in schema | **ST** | grep `device_token\|push_token\|fcm\|apns` in `schema.prisma` → 0 hits → #76 AC exists for the endpoint; schema blocked on HITL-1/-4 |

### §3 Idempotency / retry (one material correction to the prior audit)

| # | Prior finding | Verdict | Evidence & what changed |
|---|---|---|---|
| 3.1 | Only 2 of ~14 SE mutations carry a client key | **ST** | Full 17-endpoint inventory re-done: troubleshoot (`schema.prisma:870`) + vouchers (`:931`) only → **#164** |
| 3.3 | Shadow-Use/409 path never persists `clientSubmissionId`; every retry re-decrements van stock | **ST at service layer — but currently UNREACHABLE via HTTP** | Compounding confirmed in `troubleshoot-submission.service.ts:107→116→276-301`. **Correction:** `consumedComponents` exists only on the service input (`:37`) — `TroubleshootBody` (`troubleshoot.controller.ts:32-44`) has no such field and no caller passes it. **The bug is armed, not firing**; it fires the moment the consumed-components leg is wired (issue 21 / #82 both plan exactly that). Prior audit's "the endpoint an SE hits most double-decrements" overstated *current* exposure. Fix unchanged: #101 AC "persist key on CONFLICT path" — must land **before** #82/#21 |
| 3.3 | `decrementStock` read-then-write lost update | **ST** | `:315-320`; same reachability caveat; #101 AC (atomic `{decrement}` + CHECK) unchanged |
| 3.2 | VU + leave retries file duplicates | **ST** | `vehicle-unavailability.service.ts:70-84`; `leave-request.service.ts:65-74`; availability too (`se-availability.service.ts:67-91`) → **#164** |
| 3.2 | Intraday accept is the reference implementation | **ST** | `intraday-insertion.service.ts:140-175`; **decline is one notch weaker** (retry → opaque `NOT_PENDING`, `:258`) |
| 3.2 | Soft states "same opacity problem" | **NL — prior audit wrong** | Same-target re-tap returns 200 `IDEMPOTENT` with the row (`soft-state.service.ts:263`); 409 carries `{from,to}` (`soft-state.controller.ts:51-53`). Retry-safe and diagnosable |
| 3.2 | Recovery/install "guarded but opaque" | **ST + WT** | Opaque 409 confirmed (`recovery.controller.ts:145` bare `WRONG_STATE`); additionally the transitions are unguarded read-then-writes (`recovery.service.ts:346-348`, #101-class), and **`unable-to-collect` is re-appliable** (state-preserving write, `:178-196`) — re-stamps and re-fires ZM routing on every retry |
| — | *(new)* vouchers concurrent duplicate → unhandled P2002 → 500 not DUPLICATE | **new** | check-then-create `vouchers.service.ts:157-178`, no catch → #101 extension |
| — | *(new)* `confirmReceipt` status-unguarded two-step | **new** | `component-request.service.ts:177-183` — same family as #101's `confirmResubmit` site; extension filed |

### §4 Payload / pagination

| # | Prior finding | Verdict | Evidence & what changed |
|---|---|---|---|
| 4 | `/schedules/me` IDs-only, small | **PA / WT in one respect** | Shape now carries `scheduleId/dateFrom/dateTo` + `removedAt` exclusion (#146) but still `{ticketId, sortOrder}` per ticket. **New: nothing bounds a schedule — one live schedule holds 1,453 tickets** ([INFERRED] via `POST /schedules/assign-plants`, which has no capacity bound) and would be served whole (`day-plan-query.service.ts:49-60`) → **#165** |
| 4 | Shared pool unbounded; worst 1,030 / avg 202 | **ST** | Still no `take` (`shared-pool.service.ts:38-52`; #146 added only `notDeferredOn` `:45`). Re-measured 07-28: **worst 1,015 / avg 216 / 36 covered SEs** (~152 KB worst per poll) → **#165** |
| 4 | Notifications: fixed newest-50, no cursor/`since` | **ST** | `notifications.controller.ts:17-19`; clamp exists but unreachable (`notification.service.ts:91`) → **#165** |
| — | #147: no date filter, schedules never closed | **ST — now measured** | No date predicate (`day-plan-query.service.ts:41-46`); nothing writes terminal statuses (grep). **21/64 SEs' latest live schedule entirely past-dated; 190 live schedules accrete across 64 SEs.** #153 widened liveness to `OVERRIDDEN` — it fixed blanking but *increased* the stale-serveable population → #147 extension (now mobile-blocking) |

### §5–§6 Connections / delivery

| # | Prior finding | Verdict | Evidence & what changed |
|---|---|---|---|
| 5.1 | Pool: pg defaults `max:10`, no acquisition timeout; no params in code or URL | **ST** | `prisma.service.ts:26-40`; `.env:2`; `pg/lib/defaults.js:42` measured in installed package → #106 extension |
| 5.2 | `statement_timeout=0`, `idle_in_transaction_session_timeout=0` | **ST — re-measured live 07-28** | Both 0; `max_connections=100`, 1 connection in use on `fsm` at probe time |
| 5.5 | 10 in-process sweeps | **WT** | **Now 11 business sweeps** (#157 S4 added hourly `business-tier-override-expiry`, `business-sweep-scheduler.service.ts:177`) **+ dispatch + plant-eligibility-refresh = 13 crons**, all on the one pool/event loop. **Six sweeps co-fire on every hour mark** (2-min, 2×5-min, 2×15-min, hourly); seven at 06:00/18:00. `BUSINESS_SWEEPS_ENABLED="true"` (`.env:38`) |
| 5.4 | Advisory locks clean | **ST** | All `pg_try_…`, none on SE paths; no new locks since — still a strength, do not regress |
| 6 | Polling-only; no WS/SSE seam; gateway has no adapter; dispatch notify post-commit in-process no outbox | **ST** | Grep 0 hits; `notification-channel.gateway.ts:35-41` returns `'UNAVAILABLE'`; `batch-assignment.service.ts:55-57,232-234` → #76 extension (outbox) |
| — | 1,000-poller quantification | **new** | Poll cycle = 3 HTTP ≈ 11 SQL. At T=60 s: ~50 req/s ≈ 185 SQL/s — **steady-state fits** [INFERRED: 10 conns sustain ~2–5k indexed SQL/s]. The failure modes are tails: (i) shift-start/mass-reconnect burst ≈ 3,000 near-simultaneous requests ⇒ **9–18 s full-pool saturation** [INFERRED arithmetic] stalling admin + sweeps too; (ii) `connectionTimeoutMillis:0` ⇒ no backpressure signal, retries stack; (iii) no statement timeout ⇒ one stuck query permanently eats 1 of 10 connections |

### §7 Offline (the deepest finding — and worse than stated)

| # | Prior finding | Verdict | Evidence & what changed |
|---|---|---|---|
| 7 | No SE write accepts a client capture timestamp; server-stamped on arrival | **ST** | `troubleshoot-submission.service.ts:104,140`; soft states `soft-state.service.ts:207,281`; recovery `recovery.service.ts:143`; install `install-lifecycle.service.ts:122,168,306`; VU `vehicle-unavailability.service.ts:64`. Grep `capturedAt\|clientTimestamp`: nothing on any SE write path |
| 7 | Verification searches pings after `submittedAt`; late upload excludes its own evidence | **ST + WT** | Ping search unchanged (`verification.service.ts:203` `gt: submission.submittedAt`; run anchor `:283`). **#148 (07-22) changed only expiry** — window now needs 24 h **and** the `data_as_of` watermark advanced (`:174-186`); it narrows one wrongful-failure tail (paused ingestion) but never touches capture-time. **WT: the 10:00-fix/16:00-upload walk now ends in a fraud flag, not just a failed verification** — a repaired vehicle that has *moved* (the common case, it's a working truck) has its first post-upload ping >500 m from the anchor ⇒ `fraud: true` (`verification-criteria.ts:80`) ⇒ immediate `FAILED_VERIFICATION` + `fraudFlag` (`verification.service.ts:221-224`), inventory rollback (`:320-331`), SE in the ZM fraud queue **for a genuine repair** |
| 7 | SLA pause server-stamped (late VU pauses from upload time) | **ST** | `vehicle-unavailability.service.ts:64,94,159-168`; WAITING_COMPONENT same (`troubleshoot-submission.service.ts:164-167`) |
| 7 | No ordering/sequence mechanism; 409s carry no out-of-order signal | **ST** | No sequence column in schema; bare `WRONG_STATE` throughout recovery |
| — | *(new)* **#82 as written bakes the incompatibility into the sync API** | **new** | Its item envelope `{submissionType, clientSubmissionId, payload}` has **no timestamp field** and "no new write semantics" (`82-…md:10-11,25-27,31`); no in-order-application guarantee either. And its DUPLICATE guarantee is unsatisfiable on the CONFLICT path until #101's persist-key AC lands → #82 extension + **#166** |
| — | *(new)* spec-code divergence | **new** | CONTEXT §9 allows Phase-1 first ping "within ±500 m **or inside the Plant geofence**"; code implements only the anchor distance (`verification-criteria.ts:60-81`). The geofence branch would partially soften the moved-vehicle fraud path — noted in #166 |

### §8 Authorization (both findings stand; three the prior audit missed)

| # | Prior finding | Verdict | Evidence & what changed |
|---|---|---|---|
| 8 | `ZoneScopeGuard` no-op for SEs | **ST** | `zone-scope.guard.ts:27-29`, byte-identical → **#162** |
| 8 | Troubleshoot write: no assignment/coverage check | **ST** | Validation = key + exists + workType + `status==='OPEN'` (`troubleshoot-submission.service.ts:107-116`), nothing else. **Blast radius today: 13,941 OPEN troubleshoot tickets / 5 zones / 146 plants** (measured; was 9,280) — and 75 SEs get credentials the day #91 lands → **#162, must land no later than #91's rollout** |
| 8 | Spot-check table "mostly good" | **PA — under-audited** | All "Correct" verdicts re-confirmed (incl. notifications ownership: `notification.service.ts:117-123`). **Missed gaps:** (i) **soft-state writes are fleet-wide unscoped** — `runAdvance` never queries `tickets` (`soft-state.service.ts:250-288`), any SE can stamp VIEWED/ON_SITE/TROUBLESHOOT_STARTED on any ticket incl. CLOSED [INFERRED from absent ticket query], polluting Activity Status + ZM stale-work views; (ii) **`confirm-receipt` has no ownership check** — existence + `status==='SHIPPED'` only (`component-request.service.ts:171-179`), any SE can flip another SE's request `RECEIVED` and **resume the SLA clock** (`:187`) — latent, 0 rows today; (iii) **verification read unscoped** — `forTicket(ticketId)` takes no user (`verification.controller.ts:103-109`), contradicting workflow:68 "own Tickets" → all three in **#162** |
| — | HITL-7 "spec has no de-facto answer" | **PA — prior audit partially wrong** | The spec **does** set the outer boundary: workflow:792 + :2011 — never outside covered plants; and the Business-409/Shadow-Use machinery (workflow:931-935) sanctions two SEs racing the same ticket, so assigned-only is *not* the spec model. **Coverage is the specified floor (AFK-buildable now); only covered-any vs covered-claimed remains HITL** |

### §9 Observability

| # | Prior finding | Verdict | Evidence & what changed |
|---|---|---|---|
| 9 | Correlation ID only in exception filter; success untraceable; never in audit_logs | **ST** | Grep: 2 files only; minted at `all-exceptions.filter.ts:37-40`; no middleware/interceptor anywhere; `AuditEntry` has no correlation field (`audit.service.ts:7-17`). **Nuance the audit missed:** on the plain-HttpException branch the ID goes to header+log but **not the JSON body** (`:42-49`) — a mobile client surfacing only the body has nothing quotable for 4xx |
| 9 | No access log / metrics; pino deliberately dropped (#98) | **ST** | No pino/morgan/winston in package.json; `98-…md:4-5` records the deviation. Re-proposing structured logs **cites new evidence explicitly** (Deferred-section discipline): a 1,000-device field rollout makes per-request lines the only debugging surface — decision embedded in **#167**, not silently relitigated |
| 9 | Support-call reconstruction ≈ impossible | **ST** | Success: zero log lines, DB-only trail (good in-tx audit/ticket_events, but the DUPLICATE short-circuit path writes nothing at all); failure: one stdout line with **no user identity**; never-arrived: nothing. `audit_logs` has **no actorId index** (`schema.prisma:1365-1366`) — per-SE trawl seq-scans → **#167** |

---

## B. New findings (evidence standard as above)

| N# | Finding | Severity for mobile | Routed to |
|---|---|---|---|
| N1 | **Refresh-rotation self-lockout on lossy networks**: `consume()` revokes before the response reaches the client (`refresh-token-store.ts:35`); a dropped response strands the device with a revoked token → forced password re-login mid-shift. Routine on rural 2G; a 1,000-device fleet hits it daily. Needs rotation grace / per-device token families designed into #91's table | **High** | #91 ext |
| N2 | Soft-state writes fleet-wide unscoped (§8 above) | High (security) | #162 |
| N3 | `confirm-receipt` no ownership + SLA-resume side effect (latent, 0 rows) | Medium (arms with component flow) | #162 (+#101 for the status race) |
| N4 | Verification read unscoped vs workflow:68 | Low (info leak) | #162 |
| N5 | **Offline genuine repair → fraud flag** for a moved vehicle (§7 above) | High (wrongly accuses field engineers) | #166 / HITL-5 |
| N6 | #82 envelope lacks `capturedAt` + ordering guarantee; DUPLICATE guarantee depends on #101 | High (contract) | #82 ext |
| N7 | Shadow-Use double-decrement **armed but unreachable via HTTP** today (`consumedComponents` never wired: `troubleshoot.controller.ts:32-44` vs service `:37`) | Correction (downgrades urgency, not the fix) | #101 (unchanged AC) |
| N8 | Unbounded single schedule — 1,453-ticket plan servable whole; `assign-plants` has no capacity bound | Medium | #165 (+ note in #147) |
| N9 | Stale-plan exposure measured 21/64 SEs; #153 enlarged the stale-live population; 190 live schedules accrete | High | #147 ext (mobile-blocking) |
| N10 | No SE read of own pending intraday offer (app-restart recovery) | Medium | #163 |
| N11 | Day-plan read has **no change signal** (no updatedAt/version/ETag) while #127 APPEND mutates plans mid-day; batch `run_id` attribution exists but is not surfaced; APPEND doesn't refresh the `dispatchedAt` the read orders by (currently masked by #147's missing date filter — fixing #147 must account for it) | Medium (contract) | #165 |
| N12 | 11th business sweep + 13 total crons; six co-fire hourly on the shared 10-conn pool | Medium | #106 ext |
| N13 | Deferred/removed tickets vanish with no SE-visible signal; PRD:510 requires a "removed" label for one session | Medium (spec gap) | #161 |
| N14 | Shared-pool `companyTier` is creation-time-stamped, diverges from #157 effective tier — **by decided design** (Q-B); contract note only | Low | note in #161 payload spec |
| N15 | Vouchers concurrent duplicate → P2002 → 500 | Low | #101 ext |
| N16 | `unable-to-collect` re-appliable on retry | Medium | #164 (+#101 family) |
| N17 | 4xx bodies lack `correlationId` on the HttpException branch | Low | #167 |
| N18 | Mobile shell (`apps/mobile/src/api/client.ts`) has **no refresh caller** — sessions hard-die at 15 min; and maps every login error to `INVALID_CREDENTIALS` (the exact defect #109 fixed on admin) | Client-side; #54's scope | noted in #54's runway (no backend issue) |
| N19 | #81 assumes S3 presign ("CLAUDE.md — object storage is S3") but current CLAUDE.md states **no S3 in the stack** — the mechanism decision is unmade | Blocks #81 | HITL-9 |
| N20 | #91 as written preserves `scryptSync` verbatim and freezes the 15-min TTL; async hashing needs an explicit line, TTL reopening is HITL-3 | High | #91 ext |
| N21 | If #91's optional admin httpOnly-cookie cutover lands, the JSON-body refresh contract must **remain** for native (ADR-0025 keychain path) — additive per-client, not a replacement | Medium | #91 ext |
| N22 | #107 CI produces no API-contract artifact a mobile client could pin against (OpenAPI/contract tests) | Low (nice-to-have) | noted, unfiled — raise if mobile team wants a frozen contract |

Delta commits 07-22→07-28 examined for new SE-surface defects: **none found** (new org endpoints
role-gated; tier-override create duplicates on retry are admin-side and benign; #158 zone moves
cannot strand SE work — candidate selection and shared pool are plant-based, `candidate-selection.service.ts:23-53`,
`shared-pool.service.ts:66-75`; the stale JWT `zone_id` becomes real only if an SE surface ever
starts zone-scoping [INFERRED]).

---

## C. The filed, sequenced execution plan

### New issues filed this session

| # | Title | Size | Type | Blocking? |
|---|---|---|---|---|
| **#161** | SE ticket-read surface (M3 data source: troubleshoot/recovery detail, own forms, day-plan expansion) | M/L | AFK | **Hard blocker** — shape determines the client's data model + offline cache schema |
| **#162** | SE row-level authorization floor (coverage on troubleshoot write, soft-state, confirm-receipt, verification read) | M | AFK (floor is spec-backed; inner scope = HITL-7) | **Blocker before #91 rollout** (security) |
| **#163** | SE self-artifact reads (my vouchers, my leave, my pending intraday offer) | S/M | AFK | Non-blocking for start; blocks M7/M8b/M8e completion |
| **#164** | SE mutation retry contract (keys on VU/leave/availability; already-done replay + `alreadyDone` discriminator on recovery/install/decline; `unable-to-collect` once-only guard) | M | AFK | Contract-shaping — settle before client write layer |
| **#165** | SE poll-endpoint bounding + delta signals (shared-pool cursor, notifications `since`, day-plan bound + plan-version/ETag, assign-plants cap) | M | AFK | Contract-shaping — settle before client data layer |
| **#166** | Capture-time authority: dual-stamp `capturedAt`/`receivedAt` (verification anchor, SLA anchor, backdating window W, fraud rules) | L | **HITL** (decision 5 inside) | **Decision blocks** the offline cache design (#54/#17) and #82's contract; build can trail |
| **#167** | Request-scoped observability (correlation-id middleware on success, access log, audit-log correlation + actorId index, quotable ID in bodies) | S/M | AFK (one embedded decision: structured-log format, new evidence cited) | Non-blocking for dev; **blocking for field pilot** |

### Extensions appended to existing owners (no duplicates filed)

| Owner | What was added (this session, dated comment in the issue file) |
|---|---|
| **#91** | (a) async `scrypt` explicitly (as-written ACs preserve the sync call); (b) `revokeAllForUser` AC; (c) reserve `device_id` on `refresh_tokens` **before the table freezes** (HITL-4); (d) rotation-grace/token-family for lossy networks (N1); (e) JSON-body refresh must survive any admin cookie cutover (N21). TTL/claims stay frozen — reopening is HITL-3, not #91 |
| **#101** | Sites added: `confirmReceipt` status-unguarded two-step; vouchers P2002→500. Reachability note on the Shadow-Use finding (N7): armed-not-firing, **must land before #82/#21 wire `consumedComponents`** |
| **#106** | Named the missing values: pool `max` (≈25–50 vs `max_connections=100`), `connectionTimeoutMillis` ≈5 s (the backpressure signal), `statement_timeout` ≈30 s + `idle_in_transaction_session_timeout` ≈60 s via session options; AC: pool-exhausted request fails fast with a distinct error; sizing rationale vs 1,000 devices + 13 crons (N12) |
| **#82** | Envelope must carry `capturedAt` (per #166's decision) + an explicit items-applied-in-order guarantee; hard dependency recorded: DUPLICATE guarantee unsatisfiable until #101's persist-key-on-CONFLICT lands |
| **#76** | Durable outbox requirement (dispatch notify is crash-lossy post-commit, `batch-assignment.service.ts:232-234` — same family as #140); token-table schema (platform, multi-device, last-seen) blocked on HITL-1/HITL-4 |
| **#110** | Mobile reframing: availability control, not just security — deploy→mass-logout→login-storm×`scryptSync` is a self-inflicted outage; sequence immediately after #91 |
| **#147** | Measured numbers (21/64 stale, 190 live schedules, 1,453-ticket plan); promoted to **mobile-blocking**; must define APPEND interaction (N11) and terminal-status writer |
| **#111** | Stdout durability is a prerequisite for #167's value; single-instance capacity/availability ceiling to be documented per HITL-8 |

### Sequence (dependency-ordered; ≡ means parallel)

```
GATE 0 — decisions (HITL, ~this week; nothing below ships a client contract without them)
  D1 push provider · D2 offline strategy confirm · D3 mobile token TTL · D4 device model
  D5 capture-time + window W · D6 day-plan acceptance confirm · D7 write-scope inner choice
  D8 single-instance ceiling · D9 media storage mechanism

GATE 1 — mobile-blocking backend (start now; ~1–2 weeks)
  #106-ext config values (hours — do first, it de-risks everything after)
  #91-ext (needs D3/D4 for the table; credential-column HITL inside) ──▶ #110
  #162 authz floor ≡ #161 ticket reads     (same coverage predicate — build together;
                                            #162 lands no later than #91's rollout)
  #147 day-plan date correctness (small; unblocks trustworthy Home screen)

GATE 2 — client-contract shaping (before the mobile data layer is written; parallel with Gate 1 tail)
  #164 retry contract ≡ #165 bounding/delta
  #166 design (D5) ──▶ #82-ext contract update      #101 remaining (before #82/#21 build)

GATE 3 — parallel enablers (non-blocking for first screens; block specific M-issues)
  #81 (D9) → M4/M7 photo legs     #83 ≡ #84 → M-QR/hints (#20)
  #76-ext + #89 (D1, D4) → push   #167 → before field pilot     #103 indexes

Mobile can start in parallel: #54 shell + login + the 2 buildable screens immediately;
M3/M2 the moment #161+#147 land; write layer after Gate 2; offline layer after D5.
```

**Reasoning for the order:** #106-ext is hours of config with outage-class payoff — first.
#91 first among features because every other mobile test needs real logins, and its
`refresh_tokens` table design must absorb D4 + N1 *before* it freezes (retrofit = fleet re-login).
#162 travels with #161 because shipping a broad new SE read surface without the coverage floor
widens the exposure, and both reuse `SharedPoolService.coveredPlantIds`-style scoping. #164/#165
are cheap now and client-breaking later — that asymmetry, not urgency, is why they gate the client
data layer. #166 is a decision-then-design: the *decision* (D5) blocks the offline cache schema;
the build can trail behind the first online-only screens.

### AFK vs HITL

- **AFK-executable now:** #106-ext, #161, #162 (floor), #163, #164, #165, #167, #103, #83, #84, #147.
- **HITL-gated:** #91 (credential-column placement — pre-existing gate; plus D3/D4 inputs),
  #166 (D5), #81 (D9), #76/#89 (D1/D4), #82 build (D5 via #166), #17/#54-offline-layer (D2/D5).

---

## D. HITL decision set (re-stated + new)

| D# | Decision | What changed since 07-22 | Blocks | Options | Recommendation |
|---|---|---|---|---|---|
| 1 | Push provider (FCM only vs FCM+APNs) | Nothing; #76 already carries the token-endpoint AC | #76 schema, #89, poll-reduction strategy | FCM-only / both / none-for-pilot | FCM-only for pilot **if** the fleet is Android-only [INFERRED — verify handset policy]; the token table gets a `platform` column either way so APNs is additive |
| 2 | Offline strategy (offline-first per PRD §309-310 vs online-with-retry-queue) | #82/#17 contracts confirmed to *require* offline troubleshoot submission while the server makes it fail (§7) — the contradiction is now precise | #17, #54 client seam depth, #166's scope | (a) full offline-first (b) online-first + queue for non-verification writes | Keep the PRD's offline-first (dead-signal plants are where troubleshoots happen) — which **forces D5 option B**. Choosing (b) is a spec change; say so explicitly if taken |
| 3 | Mobile access-token TTL (15 min is frozen by #91) | #91's freeze language identified (`:103-105`) — reopening must be explicit | Refresh volume (~4k/hr at 1k SEs), N1 exposure frequency | keep 15 m / 60 m mobile / long-lived + revocation via jti | 60-min mobile TTL + keep 30-day refresh; revisit jti/claims only if revocation-latency becomes a real requirement (it breaks #91's byte-compat freeze) |
| 4 | One device per SE vs many | None — but now **time-critical**: #91's `refresh_tokens` columns are being decided | #91 table, #76 token table, "log out other device" | one-active (replace-on-login) / N devices | **One active device, server-side replace-on-login** — covers handset replacement, kills the stolen-device tail, simplest table; multi-device is additive later |
| 5 | **Capture-time authority + backdating window W** | **New evidence: the moving-vehicle fraud path (N5)** — genuine repairs get fraud-flagged, not merely failed. #148 didn't touch this axis. Tables still empty ⇒ additive columns are ~free now | #166, #82, #17, offline cache schema, SLA semantics | (a) server-time-only + no offline verification writes (= amend the spec) (b) dual-stamp `capturedAt`+`receivedAt`, bounded W, verification+SLA anchor on `capturedAt` (c) full event-sourcing | **(b)**, W = 24 h aligned to the verification window, `capturedAt > receivedAt` rejected, and an explicit rule that server-observed events (auto-recovery sweep) beat back-dated claims. (c) is all cost, no consumer. **The W value and the auto-recovery precedence rule are yours to make** — they trade fraud surface against field reality |
| 6 | Day-plan acceptance (apply-immediately vs SE accept/reject) | Unchanged; #127 APPEND makes mid-day mutation *more* common | M2/M6 screen design, #165's change-signal semantics | keep apply-immediately + visible "plan updated" cue / add handshake | Keep apply-immediately (matches dispatch model + workflow); give the client a plan-version cue via #165. A handshake is a product change — only on your say-so |
| 7 | SE write scope | **Spec position clarified**: coverage floor is *specified* (workflow:792/:2011) — only covered-any vs covered-claimed is open. Blast radius now 13,941 tickets | #162's inner predicate (floor lands regardless) | covered-any / covered-claimed (invents a "claim" act) | **Covered-any** — it matches the sanctioned 409/Shadow-Use race model; claimed-only invents spec machinery. #162's floor is not blocked on this |
| 8 | Multi-instance target | Cron count grew to 13; everything else unchanged | #111 runbook, deploy story, login-storm exposure | accept single-instance ceiling for pilot / fund multi-instance now | Accept **documented** single-instance for the pilot (with #106-ext + #110 + #165 landed, one instance plausibly carries 1,000 pollers [INFERRED]); revisit before any second-fleet scale-out. Every deploy = mass logout until #91 lands — sequence deploys off-shift |
| 9 | **(new)** Media storage mechanism | #81 assumes S3 presign; CLAUDE.md now says **no S3 in the current stack** (N19) | #81 → M4/M7/M-install photo legs | S3-compatible service (MinIO/real S3) + presign / local-disk multipart behind the same `photoRef` seam | Your infra call. If no object store is planned, local-disk multipart with the presign-shaped seam keeps #81's contract stable either way |

Also embedded (engineering-level, flagged not escalated): structured-log adoption in #167
(relitigates #98's pino drop **with new evidence**: 1,000-device rollout, sessions currently
unreconstructable); rotation-grace design in #91 (N1).

---

## Appendix — what the prior audit got wrong (explicitly)

1. **§3.3 severity**: "the one endpoint an SE hits most double-decrements inventory" — the decrement
   path is unreachable via HTTP today (`consumedComponents` never wired). Armed, not firing. The fix
   and its owner (#101) are unchanged; the *sequencing* claim ("will fire in normal use") was wrong.
2. **§3.2 soft states**: not opaque — same-target re-tap is a 200 `IDEMPOTENT`, and the 409 carries
   `{from,to}`. It is the second-best retry implementation on the surface, after intraday accept.
3. **§8 spot-check**: incomplete rather than wrong — it missed the soft-state fleet-wide write gap,
   the confirm-receipt ownership gap, and the verification-read gap.
4. **HITL-7 framing**: "no de-facto answer to preserve" — the spec does fix the outer boundary
   (coverage floor, workflow:792/:2011); only the inner choice is a business call.
5. **§7 completeness**: it described window-expiry failure; the sharper live behaviour is the
   immediate fraud flag for a moved vehicle. Worse, not better.

*Read-only assessment + filing session. No code changed. Measurements were SELECT-only aggregates
against the dev DB (2026-07-28); all probes deleted. Issues #161–#167 filed; extensions appended to
#91/#101/#106/#82/#76/#110/#147/#111; INDEX updated.*
