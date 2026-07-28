# SE Mobile — Backend Contract Freeze Plan

**Date:** 2026-07-28 · **Branch:** `feat/autoplant-integration` · **HEAD:** `0d3b85d`
**Supersedes:** `backend-mobile-readiness-2026-07-22.md`, `backend-mobile-readiness-plan-2026-07-28.md`,
`mobile-backend-independent-assessment-2026-07-28.md` (all three carry banners pointing here).

**The bar this is written against (stricter than any of the three sources):** the backend must be
finished, and its SE-facing contract stable, *before* mobile development begins — such that once
mobile starts, **no backend change is required to unblock it**.

**Evidence base:** the three source assessments, plus three fresh passes run for this document —
a complete SE contract inventory (34 routes), a field-level screen derivation against the 10 mobile
reference images, and an independent re-verification of 16 load-bearing single-look claims.
Live measurements are SELECT-only aggregates taken 2026-07-28; probes deleted.

---

## 8. The honest answer to the bar (first, because everything else depends on it)

**The literal bar is not achievable. ~85% of it is. The residual 15% is structurally unknowable
before a client exists.** Four categories cannot be frozen in advance:

| Category | Why it can't be frozen | Mitigation |
|---|---|---|
| **Field-level payload completeness** | You can freeze that an endpoint exists and its shape is stable; you cannot know it carries every field a screen needs until someone builds the screen. **This document shrinks the category more than anything else available** — §4 derives the field list from the reference images themselves — but it does not eliminate it. Six screens have **no reference image** (Recovery, Install, Intraday, Leave, Availability, 409) and were derived from prose; those are exactly where a field gets discovered late. | Ratify mockups for the six imageless screens (D-9) before freeze. Additive-only field policy after. |
| **Error cases a real client exercises** | A phone on 2G with a real user walks paths the e2e suite never did. New error codes *will* be needed. | Make new codes additive and non-breaking: client must have a default branch. Enforced by §5's `@fsm/shared` codes + a documented "unknown code ⇒ generic handling" rule. |
| **Offline sync semantics (#82)** | The batch envelope is genuinely co-designed with the client's queue. It can be specified up front; it is unlikely to be *right* up front. | Decide capture-time authority (D-5) before freeze so the *data model* is fixed even if the transport iterates. |
| **Real-device performance** | Latency and payload behaviour on real networks surfaces problems no local measurement predicts. | §2 pre-bounds every list. Residual risk is tuning constants, not shapes. |

### The bar you should actually buy

Not *contract immutability* — **contract compatibility**: backend changes during mobile development
become **safe** rather than **forbidden**. Four mechanisms, three of them cheap:

1. `/api/v1` prefix (costs a string today; unobtainable later — adding `/v1` after v1 ships is
   itself the breaking change).
2. Additive-only discipline on frozen routes, with the SE response types and **all 54 error codes**
   in `@fsm/shared` so drift is a compile error rather than a field incident.
3. An OTA channel so a client-side fix does not need a store release.
4. A server-side minimum-client-version gate, so the server can refuse a build it can no longer serve.

With those, "we added a field mid-build" is a non-event. Without them, **every** mistake is permanent
across 1,000 handsets — there is currently no OTA, no versioning, no forced upgrade, and no shared
type coupling of any kind.

### What the strict bar costs

Your bar promotes nearly the entire "parallel" list of the two earlier plans into the pre-start list,
because "mobile runs start to finish" means every screen, and every screen needs its endpoints. That
pulls in media upload, offline sync, ticket search, technical hints, push, and all the self-reads.

**Estimate: 96–142 engineer-days of backend work (§6).** One engineer ≈ **5–7 months**;
two engineers with the parallelism in §6 ≈ **11–16 weeks**. The compatibility bar reaches a safe
start in **6–8 weeks** and lets the peripheral endpoints land additively while mobile builds.

**Recommendation: take the compatibility bar.** The strict bar's last 15% is unpurchasable at any
price, and paying 5–7 months for 85% of a guarantee you can get 100% of the *value* of — via
versioning plus additive discipline — is a bad trade. §2 marks which items belong to which bar.

---

## 1. Reconciled finding set

Provenance: **[V-n]** = independently verified in *n* separate passes · **[S]** = single look,
carried forward · **[R]** = a prior claim this reconciliation **refutes or corrects**.
Severity is stated against the freeze bar, which promotes and demotes several findings.

### 1.1 Missing surfaces — capabilities that do not exist

| Finding | Prov. | Severity under the freeze bar |
|---|---|---|
| **No SE-callable endpoint returns a ticket.** `GET /api/tickets/:id`, `/api/tickets`, `/api/tickets/:id/forms` are manager-only (`ticketing/tickets.controller.ts:71,39,84`); `/schedules/me` returns bare `{ticketId, sortOrder}` (`day-plan-query.service.ts:68`). Four screens (Ticket Detail, Troubleshoot header, Tickets list rows, Daily Status rows) have no data source. | **[V-4]** | **Blocking.** Ranked #1 by every pass. Shape determines the client's data model and offline cache schema. |
| **Technical Hints and the entire telemetry read are unimplemented.** `raw_device_snapshots` (`schema.prisma:1320-1348`) is written by ingestion and read by nothing; `grep technicalHint` → **0 hits** across backend and admin. The Ticket Detail "Technical Health" block is **13 fields**, and hint chips appear on **4 screens**. Workflow:259 requires server-side derivation. | **[S]** ⚠ | **Blocking.** Largest single block of missing payload. Single-look — the field list should be re-derived before build. |
| **Transporter phone / WhatsApp does not exist as a column.** `transporters` has `transporterId, sourceTransporterId, name, companyId, status, createdAt, updatedAt` (`schema.prisma:1742-1754`) — **no contact fields**. PRD §484/§513.1/§549.1 require tap-to-call on three screens. | **[S]** ⚠ | **Blocking + expensive.** Needs a migration **and** an ingestion-source decision (is it in the AutoPlant master?). The most costly thing on this list to discover late. Single-look. |
| **No human-readable ticket number.** Every reference image renders `TCK-#####`; `Ticket.ticketId` is `@default(uuid())` (`schema.prisma:2027`). No column exists, no doc says where the number comes from. | **[S]** ⚠ | **Blocking.** Schema + backfill + product decision. Appears on 5 screens. |
| **Five one-way streets** — the SE can write and never read back: vouchers (`vouchers.controller.ts:101` review-roles), leave requests (`leave-request.controller.ts:67`), availability (only manager `GET /engineers/:seId`), VU reports (`:86`), component requests (`:27,:37`). Plus **no SE-readable recovery ticket at all** (`recovery.controller.ts` has no SE GET) and **no SE read of their own pending intraday offer** (`:38`). | **[V-3]** | **Blocking.** Vouchers and Inventory screens are ~80% list-and-status. |
| **No media upload endpoint (#81).** `photoRefs`/`photoRef` are opaque strings with no minting route. Additionally the images show **named slots** — Troubleshoot has 4 (`Before/After/Part/Plate`), Vouchers has 3 (`Receipt/Photo/Bill`) — which a flat `string[]` cannot express. | **[V-2]** | **Blocking.** Slot semantics is a contract fact, not an implementation detail. |
| **No ticket search (#83), no SE component-request create, no SE-callable enum/reference reads.** The Inventory screen's `Request` buttons and `2 Active` list have no route; every server enum (root cause, voucher category, VU reason, decline reason, leave type) must be hardcoded by the client. | **[V-2]** | **Blocking** under the freeze bar; hardcoded enums are exactly what breaks silently later. |
| **No logout endpoint and no revocation.** `auth.controller.ts:16-26` has only `login` and `refresh`; the store exposes only `issue`/`consume` (`refresh-token-store.ts:19-38`). A lost handset cannot be revoked; its refresh token stays valid 30 days. | **[V-3]** | **Blocking.** Security, and trivially cheap. |
| **No API versioning, no OpenAPI, no contract tests, no OTA, no client-version gate.** Flat `setGlobalPrefix('api')`; zero hits for `enableVersioning`, `@nestjs/swagger`, `expo-updates`, `eas.json`. `@fsm/shared` is **76 lines** and shares no domain type and none of the 54 error codes. | **[V-2]** | **Blocking, and promoted.** See §1.5. |
| **No device identity anywhere in the schema.** Zero hits for `device_token\|push_token\|fcm\|apns`. Push (#76/#89) cannot address a handset. | **[V-2]** | Blocking under the strict bar (Push screen); parallel under the compatibility bar. |

### 1.2 Broken — exists and is wrong

| Finding | Prov. | Severity |
|---|---|---|
| **Request bodies are unvalidated on every SE write route.** `class-validator` appears in exactly **one** file (`cross-zone/cross-zone.dtos.ts`), which is manager-only. Every other `@Body()` is a TS interface, erased at runtime, so the global `ValidationPipe` (`app.module.ts:187-190`) validates nothing and `whitelist` strips nothing. Concrete crash: `BigInt(body.componentUnavailableItem)` (`troubleshoot.controller.ts:92`) throws `SyntaxError` on any non-numeric string → not an `HttpException`, no numeric `status` → generic **500** (`all-exceptions.filter.ts:71-77`). Same shape at `vouchers.controller.ts:83` (`new Date(expenseDatetime)` unvalidated) and `geography.service.ts:46` (`BigInt(NaN)` → RangeError). | **[V-3]** | **Blocking.** A *client* bug returns the one status a retry policy must treat as transient, against a server with no rate limiting. This is a worse retry problem than a missing idempotency key, and no source assessment before the independent pass mentioned validation at all. |
| **The error contract is not machine-parseable.** Controller errors are `{code}` with **no `statusCode` and no `message`**; guard/pipe/filter errors are `{message, statusCode}` with **no code**. `SE_NOT_FOUND` is 404 on one route (`engineers.controller.ts:225`) and **400** on another (`vouchers.controller.ts:96`). Install emits bare `NOT_FOUND`/`WRONG_STATE`/`FORBIDDEN` while recovery namespaces the identical conditions. Install/recovery 409s carry no `status` field; troubleshoot's carries five fields. | **[V-2]** | **Blocking.** A client cannot write one `parseError()`; it must read `body.code ?? body.message` and cannot rely on `statusCode` existing. |
| **`GET /api/me` returns 4 primitives against a Profile screen rendering 21 data points** and a Home header needing 4 more. Widest per-endpoint gap in the app. | **[S]** | **Blocking.** |
| **Row-level authorization gaps.** `ZoneScopeGuard` returns `true` for every non-ZM (`zone-scope.guard.ts:27-29`). `POST /tickets/:id/troubleshoot` validates existence + workType + `status==='OPEN'` only. `POST /tickets/:id/soft-state` never queries `tickets` at all (`soft-state.service.ts:250-288`) — any SE can stamp soft states on any real ticket, including CLOSED. `POST /component-requests/:id/confirm-receipt` has no owner check (`component-request.service.ts:177-179`). `GET /tickets/:id/verification` is unscoped **for every role including ZM** (`verification.controller.ts:103-109`). Measured exposure: **14,019 OPEN troubleshoot tickets / 152 plants / 5 zones**. | **[V-3]** | **Blocking, and must land no later than #91's credential rollout** — 75 real logins against an unscoped write surface is when it becomes real. |
| **Day plan serves stale plans and is unbounded.** No date predicate (`day-plan-query.service.ts:41-46`); nothing writes a terminal schedule status. Measured: **21 of 64** SEs' latest live schedule is entirely past-dated; one live schedule holds **1,453 tickets in a single stop**, dated 2026-07-21, and would be served whole today. | **[V-3]** | **Blocking.** Two angles on one defect. |
| **No pagination anywhere on the SE surface, and lists are bare arrays.** `/me/shared-pool` (worst measured **1,021** tickets) and `/org/geo/*` return top-level JSON arrays with **no envelope**, so pagination cannot be added without a breaking change. `/notifications` is silently capped at 50 — the controller never passes `limit` (`notifications.controller.ts:17-19`). | **[V-3]** | **Blocking under any bar.** Envelope shape is unfixable later. |
| **Eight routes are SE-reachable by omission.** `RoleGuard` returns `true` when `@Roles` is absent (`role.guard.ts:25-27`): `/api/me`, four notification routes, `/api/org/geo/{states,regions,districts}`, `/api/zones/:zoneId`. Two geo routes are **unbounded**; `/api/zones/:zoneId` is a stub returning HTTP 200 `{"zoneId":null}` for garbage input. | **[S]** | **High.** Not in any prior inventory. Deliberate-or-not must be decided before freeze. |
| **Serialization is inconsistent.** BigInt ids are decimal **strings** everywhere except `/org/geo/*`, which render them as JSON **numbers** (lossy >2^53). `String(null)` yields the literal `"null"` for `scheduleId`/`batchId` (`intraday-insertion.service.ts:148-149`). `dateFrom`/`dateTo` are `"YYYY-MM-DD"` while every other date is a full ISO instant. No `BigInt.prototype.toJSON` patch exists, so one un-stringified BigInt anywhere becomes an opaque 500. | **[S]** | **High.** A frozen client hard-codes all of these. |
| **Success status codes are arbitrary.** Install transitions return 200; soft-state transitions return 201 — same shape of operation. `POST /vouchers` sets an explicit 201 while `POST /notifications/read-all` sets 200. | **[S]** | Medium-high. Trivial to fix now, permanent later. |
| **Three spellings of one datum across three SE writes:** `location.lng` (soft-state), `seGps.lon` (troubleshoot), `gpsLat`/`gpsLng` (VU). | **[S]** | **High.** Freezing this triple guarantees a client bug. |
| **`deviceCount` means three different things.** `DayPlanStop.deviceCount` is literally `b.tickets.length` (`day-plan-query.service.ts:67`), i.e. a *ticket* count, while Home renders it as "4 inactive" (device count) and "2/4" (workload ratio). | **[S]** | **High.** Freeze it and mobile renders wrong numbers forever. |
| **Retry safety is five different strategies**, and four routes have none: leave-requests, availability, vehicle-unavailability all create duplicate rows; **`recovery/:id/unable-to-collect` is state-preserving so a retry silently succeeds twice**, re-stamping and re-firing the ZM notification (`recovery.service.ts:178-201`). | **[V-3]** | **Blocking.** |
| **Sessions cannot survive a fleet's life.** In-memory refresh store, process-local, dies on restart (`refresh-token-store.ts:16,19-21`) ⇒ every deploy is a fleet-wide logout within 15 minutes. Single-use rotation with no grace window ⇒ a dropped *response* permanently burns the session, routine on 2G. `scryptSync` (`user-store.ts:78`) blocks the event loop per login. **Exactly one SE account exists** (`user-store.ts:45-49`), which is also a day-one dev-loop blocker — two engineers testing share one identity and one soft-state machine. | **[V-3]** | **Blocking.** |
| **Offline breaks GPS verification.** Writes are server-stamped (`troubleshoot-submission.service.ts:104,140`); Phase 1 searches pings strictly **after** `submittedAt` (`verification.service.ts:203`) and anchors the run there (`:283`). A repair done offline and uploaded later has its own evidence excluded. | **[V-3]** | **Blocking (decision), buildable in parallel.** See §1.5 for the corrected mechanism. |
| **Connection posture.** pg defaults `max:10`, `connectionTimeoutMillis:0`; live `statement_timeout=0`, `idle_in_transaction_session_timeout=0`; **13 in-process crons** on the same pool, six co-firing hourly. | **[V-2]** | High — but **parallel**, not freeze (config, no contract). |
| **Observability.** Correlation IDs exist only in the exception filter; successful requests produce no log line; `audit_logs` has no `actorId` index. | **[V-2]** | Medium — **parallel**. |

### 1.3 The specification itself is unsettled

The screen audit compared the 10 reference images against the PRD and found **12 disagreements**.
Under the parity gate the images are authority, but several change *what an endpoint must return*,
so they must be resolved before freeze, not during build. **[S]** throughout — single pass, and
load-bearing.

The material ones: **Home** — PRD §479/§503 describe an ordered day-plan ticket list; the image
shows 4 KPI tiles, a Next-Visit card, a 7-day bar chart and a Plant Workload grid, with the list
behind an `Open Ticket Pool` button (issue #55 follows the PRD). **Inventory** — PRD §617 scopes it
to read-only van stock; the image shows a Zone Warehouse row, per-row `Request` buttons, `Scan
Serial`, `Use Part` and an active-requests list (issue #60 follows the PRD). **Verification** — PRD
§531/CONTEXT §9 describe three phases; the image lists five named checks plus a Device Guard card;
the code has a single aggregate `phase`. **Tickets list** — PRD §497 wants Assigned and Pool visually
separate; the image groups by urgency with no such distinction.

Also: every mobile issue's `## Reference` line cites `.png.png` but the files on disk are `.png` —
**22 dead paths**. And **#88's `needs-info` is answerable from its image** (the Daily Status screen
specifies its own metric set precisely); it can be closed on evidence rather than escalated.

### 1.4 Severity disagreements between the three sources — resolved

| Conflict | Resolution | Evidence |
|---|---|---|
| **Contract stability**: 07-28 ranked it **N22 / low / unfiled**; the independent pass called it high and self-corrected. | **Independent pass is right; the 07-28 ranking was wrong by its own logic.** That document argued pagination and idempotency must land pre-client because they are "cheap now, breaking later" — then failed to apply the identical argument to response shapes and error codes, which are *more* exposed (no recall mechanism at all) and *cheaper* to protect. **Promoted to foundational.** Under the freeze bar it is the mechanism that makes the freeze survivable. | User has accepted this correction. |
| **Shadow-Use double-decrement**: 07-22 said it "will fire in normal use"; 07-28 said armed-but-unreachable. | **07-28 is right.** `consumedComponents` exists only on the service input (`troubleshoot-submission.service.ts:37`); `TroubleshootBody` has no such field and no caller passes it. **But** it arms the moment #82 or issue 21 wires the consumed-components leg — so #101's persist-key AC must land **before** either. | Re-read at HEAD. |
| **Soft-state retry semantics**: 07-22 called them opaque; 07-28 called them retry-safe. | **07-28 is right.** Same-target re-tap returns `result:'IDEMPOTENT'` with the existing row (`soft-state.service.ts:262-264`) and the 409 carries `{from,to}`. Note the client must branch on `result`, not status — both are 201. | Contract inventory. |
| **The offline fraud path**: 07-28 said the first out-of-radius ping fraud-flags immediately. | **Corrected. [R]** `verification-criteria.ts:67-73` early-returns `fraud:false` below `PHASE1_MIN_PINGS = 3` (`:12`). **≥3 pings** must arrive; then fraud fires immediately regardless of other evidence (`:80`, independent of `evidenceOk` at `:78`), before `windowExpired` is even computed (`verification.service.ts:222-226`). The 500 m threshold is a hard-coded module constant (`:11`) whose `thresholds.radiusM` override is plumbed but never passed. **Finding survives** — a moved vehicle produces ≥3 pings trivially — but the mechanism was misdescribed. | Re-verification pass. |
| **"No SE write accepts a client-supplied capture timestamp"** — asserted by all three sources. | **REFUTED as stated. [R]** `POST /api/vouchers` accepts `items[].expenseDatetime`, converts it unvalidated (`vouchers.controller.ts:83`), persists it verbatim (`vouchers.service.ts:194`) and **exports it to the Finance CSV** (`:401`). `POST /api/vehicle-unavailability` accepts `expectedFrom`/`expectedTo`. The narrow claim — nothing client-stamped feeds the GPS/verification anchor — holds. The blanket phrasing does not, and an unvalidated client timestamp feeding a finance export is its own finding. | Re-verification pass. |
| **"The mobile test suite is red"** — independent pass. | **REFUTED. [R]** Executed twice: `npx jest --ci` and `npm test`, both **exit 0, 6 suites / 20 tests passing**. The earlier report was a 5-second-timeout artefact under load. **The real finding is narrower and cheaper:** CI never invokes the suite (`ci.yml` hardcodes `apps/backend` and `apps/admin`), so it can rot silently. Re-scope any plan step to "wire the existing suite into CI," not "fix the broken suite." | Executed in re-verification. |
| **`confirm-receipt` SLA-resume side effect** — 07-28 stated it as live. | **Partially corrected.** Resume is gated on `sla_resume_on_receipt`, **default OFF and absent from the live `system_settings` table**. Dormant today. The unauthorised write is still real: it burns the one-way `SHIPPED→RECEIVED` transition the genuine owner needs. | Re-verification pass. |
| **Verification-read scoping** — 07-28 framed it as an SE ownership gap. | **Understated.** The handler is unscoped for **every** role including ZM, while sibling verification reads *do* zone-scope. The fix needs a scope argument on `forTicket`, not an SE ownership check. | Re-verification pass. |
| Measurements | Drifted: **14,019** OPEN troubleshoot (was 13,941), **152** plants (was 146), worst pool **1,021** (was 1,015). 1,453-ticket schedule and 21/64 stale plans confirmed **exactly**. | Re-measured 2026-07-28. |

### 1.5 What rests on a single look — read this before committing

These are load-bearing for the plan and have been seen **once**. Re-derive before building:

1. **Transporter contact fields** (schema + ingestion decision) — drives a migration and a HITL.
2. **Ticket display number** — drives a migration, a backfill, and a product decision.
3. **The 13-field telemetry block and hint derivation** — the largest payload gap.
4. **The 12 image-vs-PRD contradictions** — several change endpoint contracts.
5. **The eight by-omission routes and the serialization inconsistencies** — from the contract
   inventory only.
6. **`expenseDatetime` → Finance CSV** — from the re-verification pass only.

---

## 2. The freeze list

Everything that must be **done and stable** before mobile day 1. Ruthlessly scoped: an item earns
its place only if starting without it forces either a **mid-build backend change (MBC)** or a
**client rewrite (CR)**. `[strict]` = required only under the literal bar; `[both]` = required under
either bar.

### Tier F0 — Preconditions (nothing else is trustworthy without these)

| # | Item | Breaks if skipped | MBC/CR | Bar |
|---|---|---|---|---|
| F0.1 | Wire `apps/mobile` into CI's test step (`ci.yml`, one step) | The mobile suite rots invisibly — the exact failure the workflow was written to prevent, third instance | neither, but it hides everything else | both |
| F0.2 | Real SE credentials — #91's Postgres store, **plus a seeding path for several engineers** | Two engineers testing share one identity and one soft-state machine; every scoping test is meaningless | MBC | both |
| F0.3 | `/api/v1` prefix | Adding `/v1` after v1 ships *is* the breaking change | CR | both |

### Tier F1 — Contract shape (unfixable later by construction)

| # | Item | Breaks if skipped | MBC/CR | Bar |
|---|---|---|---|---|
| F1.1 | **DTO validation on every SE write route** | Client bugs return 500, which retry logic treats as transient ⇒ infinite retry against an unthrottled server | MBC | both |
| F1.2 | **Error-shape normalisation** — always `body.code`, guards included; consistent status per code; 409s carry discriminating state | Client cannot write one `parseError()`; retry/conflict/messaging logic is guesswork | CR | both |
| F1.3 | **All 54 error codes + SE response types into `@fsm/shared`** | A rename typechecks green across the monorepo and breaks the field silently | CR | both |
| F1.4 | **List envelopes + cursors** on shared-pool, notifications, day-plan (bare arrays → `{items, cursor}`) | Pagination cannot be added later without breaking every list screen | CR | both |
| F1.5 | **Serialization conventions** — BigInt→string everywhere (fix `/org/geo/*`), no `String(null)`, one date format, documented | Client hard-codes each inconsistency; `/org/geo/*` ids are lossy >2^53 | CR | both |
| F1.6 | **Naming unification** — one geo shape (`{lat,lng}`), rename `deviceCount` to what it means, name the derived `workState` | Three spellings of one datum guarantee a client bug; `deviceCount` renders wrong numbers forever | CR | both |
| F1.7 | **Success-status consistency** (200 vs 201 per operation class) | Client hard-codes per-route status | CR | both |
| F1.8 | **Enum vocabularies served or shared** (root cause, action taken — currently an unvalidated string, voucher category, VU reason, decline reason, leave type, unable-to-collect) | Client hardcodes 6 enums against a server that silently accepts anything | CR | both |
| F1.9 | **Decide the eight by-omission routes** — intentional or role-gate them; bound `/org/geo/*`; fix or remove the `/api/zones/:zoneId` stub | Undecided surface freezes by accident | MBC | both |

### Tier F2 — Missing surfaces the screens require

| # | Item | Breaks if skipped | MBC/CR | Bar |
|---|---|---|---|---|
| F2.1 | **SE ticket read** (troubleshoot + recovery detail, own forms, day-plan expansion with per-ticket context) | 4 screens have no data source. **Wall 2.** | MBC | both |
| F2.2 | **`GET /api/me` enrichment** (~14 fields: name, phone, email, zone name, home plant, coverage, reportsTo, availability, dataAsOf) | Profile renders 2 of 21 fields; Home header renders none | MBC | both |
| F2.3 | **SE self-reads** — vouchers, leave, availability, VU, component requests, pending intraday offer, recovery ticket | Five one-way streets; Vouchers and Inventory are ~80% unreadable | MBC | both |
| F2.4 | **Telemetry read + Technical Hints** (#84) — 13 fields + server-derived hints + "unavailable" empty state | The Technical Health block and 4 screens' hint chips | MBC | both |
| F2.5 | **Transporter contact** — migration + ingestion source | Tap-to-call on 3 screens; needs a migration, so it cannot be additive-cheap later | MBC | both |
| F2.6 | **Ticket display number** — schema + backfill | Rendered on 5 screens | MBC | both |
| F2.7 | **Media upload (#81) with slot semantics** | Photo legs on Troubleshoot (4 slots), Vouchers (3), Install | MBC | both |
| F2.8 | **Ticket search (#83)** | QR Scanner screen + both list search boxes | MBC | strict |
| F2.9 | **SE component-request create** + van-stock enrichment (min/target qty, location, status) | Inventory screen's Request buttons and status pills | MBC | strict |
| F2.10 | **Day-plan date correctness (#147)** + plan-version/change signal | A third of engineers see a stale plan presented as today's | MBC | both |
| F2.11 | **Verification payload** — `partialDeadline`, `startedAt`, `deviceId`, per-check results; reconsider exposing `fraudFlag`/`firstPingDistanceMeters` to the suspect | Verification screen renders 3 of 12 fields; #59's pinned contract does not match the code | MBC | both |
| F2.12 | **Offline sync (#82) + capture-time model (#166)** | The whole offline story; and the data model is the part that must not move | MBC | strict |
| F2.13 | **Push: device registry + adapters (#76/#89)** | Push screen; and polling is the load pattern the pool can't absorb | MBC | strict |

### Tier F3 — Safety that must be true before real credentials exist

| # | Item | Breaks if skipped | MBC/CR | Bar |
|---|---|---|---|---|
| F3.1 | **Row-level authorization floor (#162)** — troubleshoot, soft-state, confirm-receipt, verification read | 75 SEs × 14,019 tickets. **Must land no later than F0.2.** | MBC | both |
| F3.2 | **Retry contract (#164)** — keys on VU/leave/availability, `unable-to-collect` once-only guard, already-done replay + `alreadyDone` discriminator | Duplicate field records blamed on engineers; retry logic unbuildable | CR | both |
| F3.3 | **#101 remaining write-safety**, before #82/issue-21 wire consumed components | Arms the compounding van-stock decrement | MBC | both |
| F3.4 | **Logout + revocation + rotation grace + async hashing** (#91 extension) | Lost handset unrevokable; deploy = fleet logout; dropped refresh response = forced password re-login on 2G | MBC | both |
| F3.5 | **Rate limiting (#110)** | Deploy → mass logout → login storm × blocking KDF = self-inflicted outage | MBC | both |

### Tier F4 — Specification ratification (cheap, and it gates F2's field lists)

| # | Item | Breaks if skipped | Bar |
|---|---|---|---|
| F4.1 | Resolve the 12 image-vs-PRD conflicts; fix 22 `.png.png` reference paths; close #88 on image evidence | F2.1/F2.2's field lists are derived from contested sources; Home and Inventory endpoints could be built to the wrong spec | both |
| F4.2 | Ratify mockups for the 6 imageless screens (Recovery, Install, Intraday, Leave, Availability, 409) | These are precisely where a field gets discovered mid-build — the residual-15% mitigation | strict |

---

## 3. The parallel list

Safe to land *during* mobile development because none of it changes a contract mobile depends on.
Justification is the point of this section.

| Item | Why it is safe to move while a client is being built |
|---|---|
| **#106 pool sizing, acquisition timeout, statement timeouts** | Pure configuration in `prisma.service.ts` + env. Zero API-shape impact; changes only latency and failure *mode*. Do it early anyway — no load test means anything before it. |
| **#167 observability** (correlation-ID middleware, access log, audit `actorId` index) | Purely additive: a new response *header* and server-side logging. The one client-visible piece (`correlationId` in 4xx bodies) is an added field, which additive discipline permits. |
| **#103 hot-FK indexes** | Storage-layer only. |
| **#146 slices 4–5, #154, #155, #147's capacity accounting internals** | Scheduling engine internals. Note the exception: #147's *read* semantics are F2.10 and must be frozen; its capacity/closure internals are not client-visible. |
| **#156 test-DB hygiene, #107 CI extensions beyond F0.1** | Developer-loop only. |
| **All admin-side work** (#159, #160, admin UI issues, #145) | Different client entirely; no shared route. |
| **Sweep internals, #148 staleness guards, #157/#158 follow-ons** | Server-side behaviour behind already-frozen reads. Changes *what the data says*, not what shape it arrives in — which is the correct thing to keep improving. |
| **#111 deployment/runbook, log durability** | Ops. Prerequisite for #167's value, not for the contract. |
| **Push adapters (#76) once the token-registry *shape* is frozen** | Under the compatibility bar the registration endpoint's contract can freeze early while FCM/APNs wiring lands behind it. Under the strict bar this is F2.13. |

**Explicitly NOT parallel, despite looking like it:** anything that changes a response field, an
error code, a status code, or a list envelope. Under additive-only discipline, *adding* a field is
parallel; *renaming or removing* one never is.

---

## 4. The contract-freeze inventory

**The primary deliverable — this is what all the work buys.** 34 SE-reachable routes, established by
sweeping every `@Controller` in `apps/backend/src` and resolving every role constant.

Status key: **STABLE** = freeze as-is · **CHANGE** = must change before freeze · **NEW** = does not
exist · **DECIDE** = intentionality must be settled (§F1.9).

### 4.1 Public / auth

| Route | File:line | Status | What must change |
|---|---|---|---|
| `POST /api/auth/login` | `auth.controller.ts:16` | **CHANGE** | Body is an erased interface (F1.1). 401 body carries no code (F1.2). Contract otherwise fine. |
| `POST /api/auth/refresh` | `:22` | **CHANGE** | Two distinct 401 causes are indistinguishable. **Anti-idempotent** — single-use rotation, so a retried *successful* refresh 401s; needs a grace window (F3.4). Client must never blind-retry. |
| — | — | **NEW** | **`POST /api/auth/logout`** — does not exist (F3.4). |
| `GET /api/health`, `/health/ready` | `health.controller.ts:16,22` | STABLE | 503 body lacks `statusCode` (cosmetic). |
| `GET /api/non-op/confirm` | `non-operational.controller.ts:131` | STABLE | Token-authenticated; the only 410 in the surface. |

### 4.2 Reachable by omission — no `@Roles` (§F1.9 DECIDE)

| Route | File:line | Status | What must change |
|---|---|---|---|
| `GET /api/me` | `me.controller.ts:12` | **CHANGE** | Returns 4 fields against a 21-field screen (F2.2). Only **snake_case** object in the whole surface (F1.5/F1.6). |
| `GET /api/notifications` | `notifications.controller.ts:16` | **CHANGE** | Silently capped at 50, no cursor, no `since`, no total (F1.4). `unread` is a string compared to the literal `'true'`. `metadata` is untyped JSON. |
| `POST /api/notifications/:id/read`, `/read-all` | `:21,:27` | STABLE | Genuinely idempotent, ownership-scoped. Good models. |
| `GET /api/org/geo/{states,regions,districts}` | `geography.controller.ts:16,21,26` | **CHANGE / DECIDE** | **Unbounded** (no `take`); BigInt→**number** (lossy, contradicts every other route); `BigInt(NaN)` → 500 on bad `regionId`. |
| `GET /api/zones/:zoneId` | `zones.controller.ts:8` | **CHANGE / DECIDE** | Stub. Returns HTTP 200 `{"zoneId":null}` for a non-numeric param. Remove or implement. |

### 4.3 SE reads (7 — the entire read surface)

| Route | File:line | Status | What must change |
|---|---|---|---|
| `GET /api/schedules/me` | `schedules.controller.ts:64` | **CHANGE (major)** | Per-ticket expansion — currently `{ticketId, sortOrder}` (F2.1). Date filter (F2.10). `planVersion`/`updatedAt`. Removal metadata. Per-stop counts. Bound + cursor (1,453 measured). Rename `deviceCount`. |
| `GET /api/me/shared-pool` | `shared-pool.controller.ts:19` | **CHANGE (major)** | Bare array → envelope + cursor (1,021 measured, F1.4). Add `vehicleNo`, `transporterName/Phone`, `companyName`, `deviceType`, `inactivityHours`, `topTechnicalHint`, `createdAt`. Document `companyTier` as creation-stamped. |
| `GET /api/me/van-stock` | `inventory.controller.ts:42` | **CHANGE** | Add `minQty`/`targetQty` (**no column exists**), `status`, `location` (SE vs Zone Warehouse), `serialTracked`, `category`. `commonKit.complete:true` is three-way ambiguous — disambiguate. |
| `GET /api/tickets/:id/verification` | `verification.controller.ts:103` | **CHANGE** | Add `partialDeadline`, `startedAt`, `deviceId`, per-check results (F2.11). **Add scoping for all roles.** Reconsider `fraudFlag`/`firstPingDistanceMeters` on the SE variant. |
| `GET /api/install/:ticketId` | `install.controller.ts:216` | **CHANGE** | Correctly scoped — the model to copy. Add `vehicleNo`, `plantName`, `companyName`, `simId`, `targetDate`, `notes` (accepted at create, never returned). |
| — | — | **NEW** | **`GET /api/me/tickets/:id`** (or SE role on `GET /tickets/:id`) — F2.1, the keystone. |
| — | — | **NEW** | **`GET /api/recovery/:id`** — no SE-readable recovery route exists. |
| — | — | **NEW** | **`GET /api/me/{vouchers,leave-requests,intraday-insertions,component-requests,vehicle-unavailability,availability}`** — the five one-way streets (F2.3). |
| — | — | **NEW** | **Telemetry/hints read** (F2.4); **ticket search** (F2.8); **enum/reference reads** (F1.8); **`dataAsOf`** (Home + Profile + Inventory + Vouchers freshness pills). |

### 4.4 SE writes (21)

| Route | File:line | Idempotency today | Status |
|---|---|---|---|
| `POST /tickets/:id/troubleshoot` | `troubleshoot.controller.ts:71` | **Key + DB unique** — the model | **CHANGE**: DTO (F1.1 — the `BigInt` 500 lives here); photo slot semantics; no coverage check (F3.1); 201 vs 200 (F1.7); `seGps.lon` (F1.6) |
| `POST /vouchers` | `vouchers.controller.ts:62` | **Key + DB unique** | **CHANGE**: DTO; `expenseDatetime` unvalidated → Finance CSV; add item `description`; photo slots; `SE_NOT_FOUND` as 400 (F1.2) |
| `POST /intraday-insertions/:id/accept` | `intraday-insertion.controller.ts:64` | **Idempotent + atomic CAS** — the best on the surface | **CHANGE**: `BigInt(:id)` → 500; `String(null)` → `"null"` (F1.5) |
| `POST /tickets/:id/soft-state` | `soft-state.controller.ts:34` | Idempotent (`result:'IDEMPOTENT'`) | **CHANGE**: no ticket check at all (F3.1); `location.lng` (F1.6); 201; DTO |
| `POST /me/activity-ping` | `:57` | Natural | **CHANGE**: 500 if caller has no `engineer_master` row |
| `POST /install/:id/{on-site,fitted}` | `install.controller.ts:190,198` | State guard → opaque 409 | **CHANGE**: 409 carries no `status` (F1.2); bare `NOT_FOUND`/`WRONG_STATE` codes; already-done replay (F3.2) |
| `POST /recovery/:id/{on-site,collected}` | `recovery.controller.ts:50,57` | State guard → opaque 409 | **CHANGE**: same; `INVALID_DEVICE_SERIAL` vs install's `INVALID_SERIAL` for one condition |
| `POST /recovery/:id/unable-to-collect` | `:70` | **NONE — silently succeeds twice** | **CHANGE**: once-only guard (F3.2) |
| `POST /vehicle-unavailability` | `vehicle-unavailability.controller.ts:57` | **NONE — duplicate rows** | **CHANGE**: key (F3.2); `gpsLng` (F1.6); DTO |
| `POST /leave-requests` | `leave-request.controller.ts:47` | **NONE — duplicate rows** | **CHANGE**: key; `LEAVE_REQUEST_NOT_FOUND` actually means engineer-not-found; `LEAVE_NOT_PENDING` is 400 not 409 |
| `POST /engineers/:seId/availability` | `engineers.controller.ts:202` | **NONE — duplicate rows** | **CHANGE**: key; the only route with `ParseUUIDPipe`, so its 400 shape differs from its siblings' |
| `POST /component-requests/:id/confirm-receipt` | `component-request.controller.ts:42` | State guard → 409 | **CHANGE**: **no owner check** (F3.1); the SE cannot read what they are confirming (F2.3) |
| `POST /vouchers/:id/resubmit` | `vouchers.controller.ts:161` | State guard → 409 | **CHANGE**: returns a hard-coded literal status, not the service's |
| `POST /intraday-insertions/:id/decline` | `intraday-insertion.controller.ts:75` | None → 409 | **CHANGE**: `BigInt(:id)` 500; two codes for one field |
| — | — | — | **NEW**: SE component-request create (F2.9); media upload (F2.7); offline batch sync (F2.12); push token registration (F2.13) |

### 4.5 Cross-cutting freeze facts

- **54 distinct error codes** across the surface. All must move to `@fsm/shared`.
- **Param validation has four regimes**: `ParseUUIDPipe` (1 route), hand-rolled regex (1 route), raw
  `BigInt()` (2 routes → 500 on garbage), and nothing at all (5 routes → Prisma P2023 → 500).
- **Zero pagination.** Two routes return bare unbounded arrays.
- **No `BigInt.prototype.toJSON`** — one un-stringified BigInt anywhere is an opaque 500.

---

## 5. Revised issue set

### Changes to the existing seven

| # | Revision |
|---|---|
| **#161** SE ticket read | **Scope widened** with the field-level derivation: per-ticket day-plan expansion fields, `GET /api/me` enrichment (~14 fields), recovery read, install read enrichment, lifecycle/timeline, failure-cycle history, component-request status, readiness hint. **Two new HITL ACs**: human-readable ticket number (schema + backfill) and the `companyTier` creation-stamped semantics stated *in the response contract*. Cross-ref F4.1 — its field list depends on resolving the Home-screen conflict. |
| **#162** authz floor | **Corrected**: verification-read scoping is **not SE-specific** — the handler is unscoped for every role including ZM; the fix is a scope argument on `forTicket`, not an ownership check. **`confirm-receipt`'s SLA side effect is dormant** (setting default-off, absent from live DB) — the unauthorised write still burns the one-way transition. Exposure updated to 14,019 / 152 plants. |
| **#163** self-reads | **Widened from 3 to 7**: + recovery ticket read, component-request read, VU read, availability read. This is the "five one-way streets" finding. |
| **#164** retry contract | **Unchanged in substance**; add the `alreadyDone` discriminator to the F1.2 error-shape work so the two land coherently. |
| **#165** poll bounding | **Widened**: bare arrays → envelopes is now the headline (unfixable later), not just cursors. Adds `/org/geo/*` bounding. Measurements refreshed (1,021 / 1,453 / 21-of-64). |
| **#166** capture-time | **Mechanism corrected**: fraud requires **≥3 pings**, not the first; radius is a hard-coded 500 m constant with an unreachable override. **New scope**: `expenseDatetime` is an unvalidated client timestamp reaching the Finance CSV — the "no client timestamps" premise was false. |
| **#167** observability | **Unchanged**; confirmed parallel-safe (additive header + server-side logging). |

### New issues

| # | Title | Type | Why not an extension |
|---|---|---|---|
| **#174** | SE request validation — DTOs on every SE write route | AFK | Cross-cutting across 21 routes; not owned by any existing issue, and no source before the independent pass mentioned validation. |
| **#169** | SE API contract freeze — error-shape normalisation, `@fsm/shared` codes + types, `/api/v1`, serialization + naming + status conventions, enum vocabularies | AFK (2 HITL sub-decisions) | This *is* the freeze. Too large and too foundational to bury in #165. |
| **#170** | Mobile release & upgrade mechanism — OTA channel + server min-client-version gate | **HITL** | Product/infra decision with real cost; spans both apps. |
| **#171** | Transporter contact data — schema + ingestion source | **HITL** | Migration + an AutoPlant-source question nobody has asked. |
| **#172** | Mobile screen-contract ratification — 12 image/PRD conflicts, 22 dead `.png.png` paths, close #88 on image evidence | **HITL** | Gates the field lists in #161/#173; parity gate makes it a governance item. |
| **#173** | SE inventory & component-request surface — SE-initiated request create, van-stock enrichment, zone-warehouse visibility | AFK | The Inventory screen is ~60% unserved and no issue owns the create path. |

### Extensions to existing owners (preferred over new issues)

| Owner | Added |
|---|---|
| **#107** CI | **F0.1** — add `apps/mobile` as a third test step. Note the step label "Typecheck (backend + admin)" is wrong: `turbo run typecheck` already covers mobile. |
| **#91** auth | **Logout endpoint + revocation** (neither exists); rotation grace window; async scrypt; `device_id` on `refresh_tokens` before the table freezes; JSON-body refresh must survive any admin cookie cutover. |
| **#84** hints | **Full scope**: `raw_device_snapshots` is write-only; the Technical Health block is 13 named fields + server-derived hints + a "telemetry unavailable" empty state; hints appear on 4 screens. |
| **#81** media | **Slot semantics** — Troubleshoot 4 named slots, Vouchers 3, Install 1. A flat `string[]` cannot express them. |
| **#59** verification UI | **Contract mismatch**: its pinned `partialDeadline` is computed only on the manager row and is absent from the SE route. |
| **#88** daily status | **`needs-info` is answerable** from `daily-status.png`: 4 counters + completion % + day rows in the Tickets-list row shape, with a date parameter. Also needs historical-date support, which `/schedules/me` cannot do. |
| **#101, #106, #110, #147, #111, #82, #76** | Carried forward from the 07-28 extensions, with the corrections in §1.4 applied. |

---

## 6. Sequence and effort

Estimates are **engineer-days, and they are estimates** — ranges reflect genuine uncertainty, not
padding. Ordering is dependency-driven; items on the same line are parallelisable.

### Wave 0 — unblock the loop (**3–5 d**)
`F0.1` CI mobile step (0.5) · `F0.3` `/api/v1` (1–2) · `#106` pool/timeout config (0.5) ·
`F4.1` spec ratification kickoff (1–2, mostly your time)

### Wave 1 — identity and safety (**14–21 d**) — *must complete before any real credential exists*
`#91` Postgres auth + logout + revocation + async hash + rotation grace (6–9) →
`#110` rate limiting (2–3) · `#162` authz floor (3–4, **land ≤ #91 rollout**) ·
`#101` remaining write-safety (3–5)

### Wave 2 — contract freeze (**16–23 d**) — *the thing you are buying*
`#169` error shapes + `@fsm/shared` + serialization + naming + status + enums (7–10) ·
`#174` DTO validation across 21 routes (4–6) · `#164` retry contract (4–5) ·
`#165` envelopes + cursors (4–5)

### Wave 3 — the read surface (**26–38 d**) — *the bulk*
`#161` ticket read + `/api/me` enrichment (8–11) · `#163` seven self-reads (4–6) ·
`#147` day-plan date + plan-version (2–3) · `#84` telemetry + hints (6–9) ·
`#171` transporter contact, schema + ingestion (3–5) · ticket display number (2–3) ·
`#173` inventory/component-request (4–6) · `#83` ticket search (2)

### Wave 4 — strict-bar only (**32–48 d**)
`#166` capture-time design + build (6–9) · `#82` offline sync (6–9) · `#81` media upload (5–8) ·
`#76`+`#89` push registry + adapters (6–9) · `#170` OTA + version gate (3–5) ·
`#167` observability (3–4) · `F4.2` mockups for 6 screens (3–5, your time + design)

### Totals

| Bar | Waves | Engineer-days | 1 engineer | 2 engineers |
|---|---|---|---|---|
| **Compatibility** (recommended) | 0–3 | **59–87** | 3–4 months | **6–8 weeks** |
| **Strict** (your stated bar) | 0–4 | **96–142** | 5–7 months | **11–16 weeks** |

Wave 4 is where the difference lives, and it is exactly the work whose contract is least knowable
without a client — which is the argument for the compatibility bar in one line.

---

## 7. Decisions (de-duplicated across all three sources plus this one)

**Blocks work starting** — these gate Wave 1–3 and must be decided first:

| # | Decision | Blocks | Options | Recommendation |
|---|---|---|---|---|
| D-1 | **Which bar** — strict freeze vs contract-compatibility | Everything; sets the whole plan | strict (96–142 d) · compatibility (59–87 d) | **Compatibility.** The strict bar's last 15% is unpurchasable; versioning + additive discipline buys 100% of the *value*. |
| D-2 | **One device per SE, or many** | **#91's `refresh_tokens` table, before it freezes** — retrofit is a migration + fleet re-login | one active (replace-on-login) · N devices | **One active device.** Covers handset replacement, kills the stolen-device tail, simplest table. Multi-device is additive later. |
| D-3 | **Transporter contact source** | #171, and 3 screens' tap-to-call | in AutoPlant master (ingest) · FSM-owned column + manual entry · defer the feature | Needs your knowledge of the AutoPlant schema. If it isn't in the master, an FSM-owned column with admin entry is the only honest path. |
| D-4 | **Ticket display number** | #161, 5 screens | derived sequence + backfill · expose the UUID prefix · drop from the design | **Derived sequence with backfill.** The images are unanimous and field engineers quote ticket numbers on the phone. |
| D-5 | **The 12 image-vs-PRD conflicts**, esp. Home content and Inventory scope | #161, #173, #55, #60 field lists | image wins (parity gate default) · PRD wins · case-by-case | **Case-by-case, but decide now.** Home is the expensive one: KPI tiles + 7-day chart need aggregates that do not exist. |
| D-6 | **Capture-time authority + backdating window W** | #166, #82, #17, offline cache schema, SLA semantics | server-time-only (amends the offline-first spec) · **dual-stamp** `capturedAt`+`receivedAt` with bounded W · event-sourced | **Dual-stamp, W = 24 h** aligned to the verification window; server-observed recovery beats a back-dated claim. Tables are empty today, so the columns are ~free now. |
| D-7 | **SE write scope** — covered-any vs covered-claimed | #162's inner predicate (the coverage *floor* is spec-fixed and not blocked) | covered-any · covered-claimed (invents a "claim" act) | **Covered-any.** Matches the sanctioned 409/Shadow-Use race model. |
| D-8 | **The eight by-omission routes** | #169/F1.9 | intentional, document · role-gate them · remove the stubs | Role-gate `/org/geo/*` and delete or implement `/api/zones/:zoneId`. Accidental surface should not freeze. |

**Can be decided while work proceeds:**

| # | Decision | Blocks | Recommendation |
|---|---|---|---|
| D-9 | Mockups for the 6 imageless screens | F4.2; the residual-15% mitigation | Worth doing if you take the strict bar; optional under compatibility. |
| D-10 | OTA + min-version mechanism | #170 | **Both**: EAS OTA for JS fixes + an `X-App-Version` header the server can refuse. Real cost; your call. |
| D-11 | Push provider (FCM only vs +APNs) | #76 token-table `platform` column | FCM-only if the fleet is Android-only — verify handset policy. Column exists either way. |
| D-12 | Media storage mechanism | #81 | #81 assumes S3 presign; CLAUDE.md says no S3 in the stack. Local-disk multipart behind a presign-shaped seam keeps the contract stable either way. |
| D-13 | Mobile access-token TTL (15 min is frozen by #91) | Refresh volume, lockout frequency | 60-min mobile TTL + 30-day refresh. Reopening #91's freeze must be explicit. |
| D-14 | `expenseDatetime` trust model | #166 scope | Bound it like any other client timestamp — it reaches a Finance export unvalidated today. |
| D-15 | Native module vs managed workflow (`react-native-keychain` needs a prebuild that doesn't exist) | The mobile build pipeline | **`expo-secure-store`** unless something else needs native code. |
| D-16 | Single-instance ceiling for the pilot | #111 | Accept and document, with deploys scheduled off-shift until #91 lands. |
| D-17 | Structured-logging format (relitigates #98's pino drop, **with new evidence**: sessions are currently unreconstructable at 1,000 devices) | #167 | Either; the middleware/ALS work is format-agnostic. |

---

*Read-only reconciliation. No code changed. Issue files revised and INDEX updated separately.
Measurements are SELECT-only aggregates taken 2026-07-28; probes deleted. Findings marked **[S]**
rest on a single look — §1.5 lists the load-bearing ones.*
