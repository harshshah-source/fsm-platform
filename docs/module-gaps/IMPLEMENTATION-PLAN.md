# Implementation plan — from the module-gap survey to functional completion

Written 2026-09-03 against the **working tree** (HEAD `a6c87c7` plus the ~200 uncommitted files of the
scheduler-forensics session, slices #295–#334). Every survey finding that drives a slice below was
re-read in current code by six read-only verification passes; file:line references are to today's
tree, not to the survey's `beea7d2` snapshot. Nothing in this document was taken from a status doc.

Scope: all 14 surveyed modules **except** the SE mobile app and the login / signup / account-creation
flows. Backend endpoints the mobile app calls are in scope; mobile screens are not.

Companion files: `_INDEX.md` (survey), `ROADMAP.md` (survey's own ordering), `DEPS.md`, `SPINE.md`.
The slices are filed as issues `336`–`366` in `.scratch/fsm-platform-v1/issues/` and indexed under
"P12 — Module-gaps completion" in `.scratch/fsm-platform-v1/INDEX.md`.

---

## 1. What the verification changed

The survey's ranking held. Its detail needed correction in 21 places. **Do not build against the
survey brief where this table disagrees with it.**

| survey id | survey said | verified reality | consequence |
|---|---|---|---|
| AC-04 (b) | Ops Explorer `auditLogs` dataset projects no `metadata` column | **Incorrect.** `ops-explorer/dataset-registry.ts:2628-2640` projects `a.metadata::text` since `ba6053c` (2026-08-06). | AC-04 shrinks to the settings-service writer (half a). Retract standing rule. |
| AC-13 | threshold may be cached across runs | **Not a gap.** `assignment-threshold.ts:84-88` reads per call; `recommender.service.ts:338-340` "#238 — read per run". | Dropped. |
| SCH-01 | SE never told of a changed day plan | **Falsified by the survey itself**; outbox written in-tx at `batch-assignment.service.ts:521` and 7 `override.service.ts` sites. | Residual = dead push exit (337). |
| SCH-05 | cross-zone assign notifies home ZM, not the target SE | **Incorrect.** `assignTicket(...,'CROSS_ZONE_ASSIGN')` writes the target SE's outbox row at `override.service.ts:850`. The **target ZM** is the one never told. | Folded into CZ-11 (354). |
| CZ-03 | CSM backup actions lose the acting tag | **Falsified**; all writes audit via `auditEscalation` (`:359-378`). Residual: `cross-zone.controller.ts:113` hardcodes `actedAsRole: null`. | One of the 11 sites in 340. |
| NOTIF-05 | WhatsApp acceptance confirmation coded, never called | **Dead code, not a gap.** CONTEXT §21 retired SE Acceptance (#268/#279). | Delete branch in 356. |
| TKT-03 | retry mints a new dedup id | Server dedup is real (`troubleshoot-submission.service.ts:112-115`); the id minting is mobile-only. | Excluded (mobile). |
| INV-G6 | no serial check of fitted GPS/SIM | **Half incorrect.** GPS serial is checked at `install-lifecycle.service.ts:129`. SIM has no expected value anywhere in master data. | Deferred (needs master data). |
| INV-G4 | stale component requests never escalate | **Surfacing exists** — `waiting_component_overdue` card, zone-scoped >7 d (`dashboard.service.ts:976-995`). Missing only the pushed notice. | Folded into 361. |
| DASH-G01 | ZM dashboard has no critical work queue | **Design-superseded.** #277 (DONE 2026-08-24) removed `CriticalQueue.tsx` on purpose; `/assign` is the single manual-assignment surface (#272 R1). | Becomes a summary + link (351), not a rebuild. |
| DASH-G11 | `suggestedSes` hardcoded empty | True, but re-adding one-click assign on the dashboard contradicts #272 R1. | Field removed, not populated (351). |
| RPT-08 | Exports hub lacks a finance voucher batch card (INTEGRATION) | The export exists: `GET /vouchers/export` (`vouchers.controller.ts:108-116`), used from the Vouchers page. | Re-typed to a hub card (364). |
| ING-01 | departed-device auto-close is invisible and unaudited | **Audited** (`device-departure.service.ts:373,411`); unsurfaced and un-notified. | Surfacing → 349, notice → 361. |
| ING-02 | health page drops connectivity, freshness age, drift | Drift already has a screen (`ReconciliationPanel.tsx`, OH). Connectivity, age and lifecycle are the real drops. | Narrowed (349). |
| ING-09 | one health section untestable on the running build | The tree carries #300 uncommitted. | Precondition P0, not a slice. |
| V-05 | escalation reason reaches nothing | Reason is readable in Ops Explorer (see AC-04); still absent from reports/run row. | Narrowed (357). |
| VCH-10 | half a mark-PAID batch commits **and reports success** | It commits partially then **throws 500** — no `failed[]` channel at all. | Same fix, corrected AC (359). |
| VCH-03/04/05, VCH-11, NOTIF-07, TKT-04/07/08, INTRA-G4 | various | Mobile-only, or backend consequence of INV-G8 (TKT-04) / #65 (TKT-07). | Excluded or folded. |
| AA-04, AA-10, AC-01 | login rate-limit, login audit, console account has no password | Auth / account-creation flows. | Excluded by scope (#110, #91 own them). |
| ENG-G7, V-08 | no engineer row for `se.north`; zero verification runs | Fixture gaps. | Slice 336. |
| AC-08 | ops-explorer flag default | Env posture, not code. | Dropped. |

Also verified: **none of the uncommitted #295–#334 work fixed any surveyed gap** except as noted (the
#325 `inTransaction` hook on `assignTicket` is the ready-made seam for CZ-01). #331 is filed but not
started; its two problems are absorbed by 356 and 354.

---

## 2. Preconditions (P0 — not slices)

- **P0-a Commit the scheduler-forensics tree.** 201 uncommitted files (+11,640 / −2,894) belong to the
  other live session (`HANDOFF-ACTIVE.md`). Every slice below assumes that tree is committed first;
  nothing here may be built on a dirty base. Backlog-ownership: theirs.
- **P0-b Restart the dev backend on HEAD** so `ING-09` resolves and the ingestion alert section is testable.
- **P0-c** Slice **336** (fixtures) — the one dev-process item that is a slice, because it is code.

---

## 3. Waves at a glance

Priority: **P1** = shared blocker or a number/control that is wrong in production terms; **P2** =
completes a PRD workflow; **P3** = polish that affects usability.

| # | slice | modules | wave | prio | depends on | absorbs / supersedes |
|---|---|---|---|---|---|---|
| 336 | Dev seed fixtures for SE, verification, inventory, Platinum | all | 0 | P1 | — | ENG-G7, V-08, INV surface, #187 (test side) |
| 337 | Push delivery exit behind the existing gateway seam | notifications | 1 | P1 | 336 | NOTIF-01, INTRA-G1, INV-G7, SCH-01 residual; #89 backend half, #76 adapter half |
| 338 | One durable outbox for every post-commit notify site | notifications, intraday, cross-zone, tickets, scheduling | 1 | P1 | — | NOTIF-02, CZ-02 (#140 notify half) |
| 339 | Acting-scope gate, manager-unavailability windows, audited enter/exit | auth-access, admin-config | 1 | P1 | — | AA-01, AA-05, AA-07, AA-08, AA-09 |
| 340 | Acting attribution: 11 null sites, bulk-unassign column overload, backup-share report | auth-access, cross-zone, intraday, engineers, tickets | 1 | P1 | — | AA-02, AA-03, CZ-03 residual; **#318** |
| 341 | Acting scope narrows every manager write door | auth-access + 20 controllers | 2 | P1 | 339, 340 | AA-11; widens **#239** |
| 342 | Audit ledger search + admin viewer + drawer Audit tab | notifications (audit), admin-config | 1 | P1 | — | NOTIF-03, NOTIF-04, AC-05; **#145** |
| 343 | Audit writers: leave, planner, ingestion triggers, voucher export, settings from/to, VU pause/resume | engineers, ingestion, vouchers, admin-config, tickets | 1 | P2 | — | ENG-G1, ENG-G2, ING-05, VCH-09, AC-04(a), TKT-01 |
| 344 | Admin notification bell + tray | notifications, intraday | 1 | P2 | — | NOTIF-08, INTRA-G2 |
| 345 | Plant deactivation reaches the SE's day-plan notice | admin-config, scheduling | 1 | P2 | — | AC-02, SCH-02 (E-26) |
| 346 | Fleet-uptime honesty + monthly cube coverage | reports, dashboard | 2 | P1 | — | RPT-01, RPT-02, RPT-09 |
| 347 | Report freshness stamps + auto-escalations cube | reports | 2 | P2 | — | RPT-03; **#333** |
| 348 | Ingestion silence detection, reaped-run reason, role-safe freshness | ingestion | 2 | P1 | — | ING-03, ING-06, ING-08 |
| 349 | Integration Health page completion | ingestion, admin-config | 2 | P2 | 348 | ING-02, ING-04, ING-01 (surface), AC-10; **#224**, health part of **#129** |
| 350 | Action Required tells the truth and goes somewhere | dashboard | 2 | P1 | — | DASH-G02, G03, G05, G08 |
| 351 | Dashboard fidelity: freshness badge, trend, operating mode, grouping, CSV, console link | dashboard | 2 | P2 | 348 | DASH-G01, G04, G06, G07, G09, G10, G11; **#136** slice 3 |
| 352 | Field component wire contract: component identity + consumed parts | tickets, inventory | 3 | P1 | 336 | TKT-02, INV-G8, TKT-04; troubleshoot half of **#174**, catalog half of **#173** |
| 353 | Inventory ledger closure: dispute restore, recovery receipt, ZM dispute view | inventory, tickets | 3 | P2 | 352 | INV-G1, INV-G2, INV-G5 |
| 354 | Cross-zone approve is atomic and the target zone is told | cross-zone, scheduling, notifications | 3 | P1 | 338 | CZ-01, CZ-02, CZ-09, CZ-11; **#139**, **#140**, part of #331 |
| 355 | Cross-zone page completion: flag from ticket, re-escalate, modal, deferred resurfacing, history | cross-zone | 3 | P2 | 354 | CZ-04, CZ-05, CZ-06, CZ-07, CZ-08; **#92**, **#93**, cross-zone legs of #80 |
| 356 | Intra-day queue hygiene: bounded reads, refresh, labels, dead routes, dead branch | intraday, scheduling, notifications | 3 | P2 | — | INTRA-G3, G5, G7, G8, G9, G10, SCH-06, NOTIF-05, INTRA-G6; **#331** |
| 357 | Verification integrity: zone-scoped fraud flags, run verdict, de-escalate, reasons | verification | 3 | P1 | 336 | V-01, V-02, V-04, V-05, V-07 (API) |
| 358 | Verification review page completion | verification | 3 | P2 | 357 | V-03, V-06, V-07 (UI); **#148** slice 3 |
| 359 | Expense voucher controls: separation of duties, atomic mark-paid, ticket match | vouchers | 3 | P1 | 336 | VCH-02, VCH-06, VCH-10 |
| 360 | SE poll contract: paginated tickets, VU-deferred visibility, readable day-plan notices | tickets, scheduling | 3 | P2 | — | TKT-11, TKT-12, SCH-09; tickets leg of **#165** |
| 361 | Notification producers for the remaining PRD events | notifications, inventory, ingestion, vouchers, tickets | 4 | P2 | 337, 338 | NOTIF-06, INV-G3, INV-G4, INV-G7, ING-01 (notice), VCH-07 |
| 362 | User administration completion + reference-read hardening | admin-config | 4 | P2 | — | AC-06, AC-07, AC-09 |
| 363 | Leave integrity: revoke, tie-break, overlap guard | engineers | 4 | P2 | 343 | ENG-G4, ENG-G6 |
| 364 | Report pages consume what the API already offers | reports | 4 | P2 | 347 | RPT-04, RPT-06, RPT-07, RPT-08 |
| 365 | SE productivity report | reports | 5 | P3 | 346, design stop | RPT-05 |
| 366 | Zone Warehouse pickup stop on the Day Plan | scheduling, inventory | 5 | P3 | 352, design stop | SCH-03 |

Thirty-one slices. Within a wave, slices are file-disjoint unless a dependency is listed, so a wave
can be worked in parallel sessions.

---

## 4. Slice detail

Format per slice: Problem · Modules · Code areas · Depends on · Expected behaviour · Acceptance
criteria · Verification · Priority. "Reference" names the authoritative UI image where a surface changes.

### 336 — Dev seed fixtures for SE, verification, inventory, Platinum  (W0 · P1)

**Problem.** The only SE login (`se.north@fsm.test`) has a `users` row and no `engineer_master` /
`se_coverage` row (`apps/backend/src/auth/auth-fixture-seed.ts` ~74-78; `auth/dev-seed.ts:74` seeds
users only). `verification_runs` has zero rows; van stock, component requests and shadow use are empty;
no Platinum ticket exists. 17 survey findings were `needs-verify` for this reason alone.
**Modules.** all (dev-process). **Code areas.** `apps/backend/src/auth/dev-seed.ts` (extend
`runDevSeed`), pattern from `prisma/seed-mock-engineers.ts:131-149`; `apps/backend/test/fixtures/shared-auth-se.ts`
for the e2e side; `package.json` `seed:dev`. **Depends on.** —.
**Expected.** `pnpm seed:dev` is idempotent and leaves a dev DB on which every SE-side and verification
walk is possible. **AC.** (1) `engineer_master` `2222…2222` zone 1 DEDICATED capacity 5 active, plus one
`se_coverage` row on a zone-1 plant; (2) three `verification_runs` — zone-1 `FAILED_NO_PINGS`, zone-2
`fraudFlag=true`, zone-1 CLOSED — on real tickets; (3) `se_van_stock` for `se.north` = common kit minus
one item; (4) one PLATINUM-company ticket OPEN/UNASSIGNED older than 4 h in zone 1; (5) one PENDING leave
request for `se.north`; (6) second run changes nothing (upserts). **Verification.** `test/dev-seed.spec.ts`
asserts the rows and the double-run invariance; `GET /me/tickets` as `se.north` returns > 0.
**Reference.** n/a — dev-process, no surface.

### 337 — Push delivery exit behind the existing gateway seam  (W1 · P1)

**Problem.** `LoggingChannelGateway.deliver` returns `'UNAVAILABLE'` unconditionally
(`notifications/notification-channel.gateway.ts:35-40`) and is the only implementation bound
(`notifications.module.ts:18`). The outbox, the in-app rows and the `device_tokens` table
(`schema.prisma:225`) all exist; nothing ever leaves the server. Five modules bottom out here.
**Modules.** notifications (owner); scheduling, intraday, cross-zone, inventory, tickets (consumers).
**Code areas.** new `notifications/fcm-channel.gateway.ts` (FCM HTTP v1, service-account auth);
`notifications.module.ts:18` env-switched provider (`PUSH_PROVIDER=fcm|logging`, default logging);
`device-token.service.ts` (+`findForUser`); `notification.service.ts:168-175` (per-channel result +
provider message id / error onto `notification_deliveries`); `notification-seam.ts:47-60` (the #218c
assertion must become "no real provider unless explicitly configured", not "must be the logging
gateway"); `.env.example`. **Depends on.** 336 (to walk). External: FCM project credentials — **HITL
provisioning; build the seam** (CLAUDE.md "build the seam" applies). Mobile token registration stays #89
(excluded). **Expected.** With a token row and `PUSH_PROVIDER=fcm`, `notify()` delivers a push and
records `SENT`; without a token the PUSH channel returns `UNAVAILABLE` and the chain continues exactly
as today. **AC.** (1) FCM adapter sends `{title, body, data:{type, entityId}}` and maps HTTP 200 → SENT,
404/410 (stale token) → FAILED + token row deleted, 5xx → FAILED with retry left to the outbox; (2)
default binding unchanged (logging) so every existing test passes untouched; (3) seam assertion
rewritten and its e2e updated; (4) `notification_deliveries` carries `providerMessageId` / `error`;
(5) no SMS/WhatsApp/email adapter is added (unchanged UNAVAILABLE). **Verification.** e2e with an
injected HTTP stub for FCM asserting SENT/FAILED/stale-token paths; `notification-seam-assertion`
e2e; manual: one real push to a test device once credentials exist. **Reference.** n/a — backend seam.

### 338 — One durable outbox for every post-commit notify site  (W1 · P1)

**Problem.** Only the two day-plan events are outbox-fed. Twelve `notify()` sites fire after commit
with no retry row: `cross-zone-escalation.service.ts:300,321,339`; `intraday-insertion.service.ts:343,465,498`;
`intraday/stranded-work-escalation.service.ts:121`; `scheduling/bulk-unassign.service.ts:322`;
`ticketing/install-notifier.ts:52,64`; `ticketing/recovery-notifier.ts:76,93`. A crash or a thrown
notify loses the notice; #325 deliberately kept the intraday notify outside the tx.
**Modules.** notifications, intraday, cross-zone, scheduling, tickets. **Code areas.**
`schema.prisma:2906` (generalise `DayPlanNotificationOutbox` → `notification_outbox` with `kind`,
`recipientUserIds`, `payload`, keeping the existing columns, or add a sibling table — prefer one table);
migration; `scheduling/day-plan-notification-outbox.ts` (helper `queueNotification(tx, …)`, drain
dispatches by `kind`); `business-sweep-scheduler.service.ts:275-287` (same tick); the 8 producer
files above; tests `test/day-plan-notification-outbox*.e2e-spec.ts`, `test/notifier-adoption-wiring.e2e-spec.ts`,
`test/intraday-critical-insertion.e2e-spec.ts`. **Depends on.** —. **Expected.** Every notice is written
in the same transaction as the change it announces and delivered at-least-once by the existing drain.
**AC.** (1) each of the 12 sites enqueues inside its mutation tx (intraday via the #325 `inTransaction`
hook); (2) a notify that throws no longer aborts or half-commits the mutation; (3) drain delivers,
marks `sent_at`, retries to `MAX_OUTBOX_ATTEMPTS`, prunes at 30 d — unchanged policy; (4) day-plan
events keep their exact payload and tests; (5) at-most-once claim-then-deliver semantics of #264 are
kept and documented. **Verification.** crash-injection e2e per producer (throw inside notify → row exists,
mutation committed, next tick delivers once); existing outbox tests green. **Reference.** n/a — backend.

### 339 — Acting-scope gate, manager-unavailability windows, audited enter/exit  (W1 · P1)

**Problem.** `auth/acting-context.ts:24-39` grants acting to any CSM/OH whose header parses;
`role_unavailability` is never consulted (`roles/role-backup.service.ts:64-80` has no callers), the
zone is not validated (`99` accepted, `abc` → NaN → pan-India), no admin page writes
`POST /role-unavailability`, entering/leaving acting leaves no trace, the banner shows a zone number
(`AppShell.tsx:69`) and the sidebar keeps the real role's menu (`Sidebar.tsx:28-29`).
**Modules.** auth-access, admin-config. **Code areas.** new `common/acting-context.guard.ts` that
resolves the header once per request into `request.acting` (zone existence via `org/zones`,
unavailability via `RoleBackupService.currentActingRoleForZone`); `common/manager-scope.ts:27-36`
and `common/request-actor.ts:19-30` read `request.acting` instead of re-parsing; `roles/role-backup.controller.ts`
(+`GET` list, `DELETE :id` end window; +`POST /acting/enter|exit` audit); `audit.service.ts` actions
`ACTING_STARTED`/`ACTING_ENDED`; admin `api/roleUnavailability.ts` (new), `pages/settings/sections.tsx`
"Manager availability" section (OH/CSM), `auth/AuthProvider.tsx:135-138`, `AppShell.tsx:69`,
`Sidebar.tsx:28`, `TopBar.tsx:63-67`. Tests: `test/acting-context.e2e-spec.ts`, `role-backup-*.e2e-spec.ts`,
`dashboard-acting-scope.e2e-spec.ts`; admin `acting-banner`, `sidebar-shell`, `settings` tests.
**Depends on.** —. **Architecture note (Strategic HITL, recorded here rather than blocking):** the
gate needs an async lookup, and the two decorators are synchronous — a request-scoped guard is the
smallest change that keeps both decorators. Recommended; no new framework.
**Expected.** A CSM can act in a zone only while that zone's ZM has an open unavailability window; an
OH may act anywhere (pan-India authority) but every acting request is attributed and enter/exit is
audited. **AC.** (1) CSM + header for a zone with no open window → 403 `ACTING_NOT_PERMITTED`; with a
window → scoped as today; (2) OH + header → allowed, attributed; (3) unknown or non-numeric zone → 400
`ACTING_ZONE_INVALID` (never silent pan-India); (4) OH/CSM can open and end an unavailability window
for a ZM from Settings; the list is visible; (5) enter/exit writes `ACTING_STARTED`/`ACTING_ENDED`
audit rows with zone; (6) banner shows the zone **name**; sidebar shows the ZM menu while acting;
(7) ZM and WM sending the header remain clamped/refused as today. **Verification.** e2e for 1-3, 5, 7;
admin tests for 4, 6. **Reference.** `docs/ui/desktop/v2-reference/02-dashboard-csm-acting-as-zone.png`,
`26-settings.png`.

### 340 — Acting attribution: 11 null sites, bulk-unassign column overload, backup-share report  (W1 · P1)

**Problem.** `acted_as_role` is non-null on 1 of 34,758 audit rows. Eleven controller sites hardcode
`actedAsRole: null`: `cross-zone.controller.ts:113`, `devices.controller.ts:131`,
`engineers.controller.ts:254`, `leave-request.controller.ts:69,85,103`,
`intraday-insertion.controller.ts:93`, `intraday-updates.controller.ts:52,94,115`,
`tickets.controller.ts:143`. `scheduling/bulk-unassign.service.ts:289,367` writes the **target** zone
into `acting_zone`, which `roles/role-backup.service.ts:89-96` reads as an acting session — the
backup-share report therefore cannot be fixed by attribution alone. **Modules.** auth-access,
cross-zone, intraday, engineers, tickets, devices. **Code areas.** the 11 sites → `@CurrentActor()`;
`bulk-unassign.service.ts` (own metadata key, `actingZone` only from the actor); `role-backup.service.ts:89-96`
(filter `actedAsRole IS NOT NULL`); tests `csm-backup-report.e2e-spec.ts`, `intraday-updates-controller`,
`leave-request-controller`, `auto-recovery-manual`, `cross-zone-controller` e2e. **Depends on.** —
(339 not required; the actor seam exists). Absorbs **#318**. **Expected.** Every write made under acting
is stamped with the acting role and zone; the "% approvals by CSM" report is computed only from real
acting rows. **AC.** (1) zero literal `actedAsRole: null` remains in `apps/backend/src` (a grep-based
test pins it); (2) paired e2e: same write as CSM acting vs OH acting → both rows stamped; (3)
bulk-unassign rows no longer appear in the backup-share report; (4) report per zone equals
acting-approvals ÷ approvals for a seeded month. **Verification.** e2e above; static pin test. **Reference.** n/a — backend.

### 341 — Acting scope narrows every manager write door  (W2 · P1)

**Problem.** Acting narrows five read controllers and the Scheduler Console writes
(`schedules.controller.ts:81-85 scopeFor`, `batches.controller.ts:113`), but ~60 hand-built
`{ role: user.role, zoneId: user.zone_id }` sites across 20 controllers stay pan-India — a CSM acting in
zone 2 closed a zone-1 ticket for real (`ticketing/tickets.controller.ts:142`). Admin clients
`dispatch-runs.ts`, `intradayInsertions.ts`, `intradayUpdates.ts` build bearer-only headers.
**Modules.** auth-access + ticketing, intraday, engineers (leave), install, vehicle-unavailability,
verification, vouchers, planner, cross-zone, devices. **Code areas.** each controller → `@CurrentScope()`
(reads) / `@CurrentActor()` (writes); `apps/admin/src/api/*` → `authHeaders()`; tests per controller +
`apps/admin/test/acting-zone-scope.test.tsx`. **Depends on.** 339, 340. Widens **#239** (reads) — close
#239 into this. **Expected.** Acting narrows; narrowing a write can only reduce reach (the rule already
recorded on #239). **AC.** (1) a contract test enumerates every manager write route and asserts a CSM
acting in zone 2 gets 403/404 for a zone-1 entity; (2) the same actor with no header keeps pan-India
reach (CSM/OH); (3) every admin api client sends `X-Acting-As-Zone` via one builder; (4) no behaviour
change for ZM/WM/SE. **Verification.** route-enumeration e2e (fails on any new unscoped route);
admin header test. **Reference.** n/a — backend authorization; no surface changes.

### 342 — Audit ledger search + admin viewer + drawer Audit tab  (W1 · P1)

**Problem.** The only audit read is `GET audit-trail/tickets/:ticketId` (`audit/audit-trail.controller.ts:15-27`,
no `@Query`, `entityType:'ticket'` hard-filtered at `audit-trail.service.ts:50`). No admin screen calls
it; the drawer's history derives from `ticket.lifecycle`. Only OH, behind `OPS_EXPLORER_ENABLED`, can see
any audit row. Every audit row written by 343/340 is unreadable until this lands.
**Modules.** notifications (audit), admin-config. **Code areas.** `audit-trail.controller.ts` (+`GET /audit-trail`
with `actorUserId, actedAsRole, zoneId, action, entityType, entityId, from, to, cursor, limit`),
`audit-trail.service.ts` (`search()`, ZM clamped to own zone via `@CurrentScope`), index check on
`audit_logs(actor_id, created_at)` / `(entity_type, entity_id)` (`schema.prisma:1733`); admin
`api/auditTrail.ts` (new), `pages/admin/AuditTrailPage.tsx` (new; OH/CSM all zones, ZM own zone),
`AppRoutes.tsx`, `lib/nav.ts`, `pages/tickets/TicketDetailDrawer.tsx` (Audit tab rendering
`kind:'ACTION'` rows with actor, acting role, reason, from/to metadata); tests
`test/audit-trail-controller.e2e-spec.ts`, admin page + drawer tests. Absorbs **#145**.
**Depends on.** —. **Expected.** Any manager can answer "who did what, in whose scope, when" without
knowing a ticket UUID. **AC.** (1) filters are honoured (byte-identical bodies for different filters is
a failing test); (2) ZM sees own zone only; (3) `metadata` rendered as from/to where present; (4) drawer
Audit tab shows the action chain for the ticket incl. acting role; (5) keyset pagination, `limit ≤ 200`.
**Verification.** e2e per filter + clamp; admin tests. **Reference.** `28-tickets-drawer.png` for the
tab; no v2 image exists for a ledger page — follow the Ops Explorer table chrome and record the page as
an approved-design gap in `docs/ui/desktop/approved-designs/README.md`.

### 343 — Audit writers: leave, planner, ingestion triggers, voucher export, settings from/to, VU pause/resume  (W1 · P2)

**Problem.** Six write paths change dispatch, money or the SLA clock with a missing or unusable audit
row: leave approve writes only `SE_AVAILABILITY_SET` with no request id and reject writes **zero** rows
(`engineers/leave-request.service.ts:96-137`); planner intent upsert/delete is unaudited
(`planner/se-planner.service.ts:44-98`); `sync-masters`, `run-pipeline`, `POST /snapshots/run` write no
audit (`ingestion/autoplant/integration-sync.controller.ts:37-50`, `snapshots.controller.ts:48-56`);
`GET /vouchers/export` is unaudited (`vouchers.service.ts:358-410`); `SETTING_UPDATED` carries no
previous/next value (`settings/settings.service.ts:224-238`); VU `fileReport` pauses and manual
`resumeSla` resumes the SLA with no audit (`ticketing/vehicle-unavailability.service.ts:140-219, 434-456`).
**Modules.** engineers, planner, ingestion, vouchers, admin-config, tickets. **Code areas.** the six
files above via `AuditService.withAudit`; actions `LEAVE_APPROVED`/`LEAVE_REJECTED`,
`PLANNER_ENTRY_SET`/`PLANNER_ENTRY_REMOVED`, `MANUAL_SYNC_TRIGGERED`/`PIPELINE_RUN_TRIGGERED`/
`SNAPSHOT_RUN_TRIGGERED`, `VOUCHER_EXPORT_DOWNLOADED`, `SETTING_UPDATED` + `metadata:{key, previous, next}`,
`VU_SLA_PAUSED`/`VU_SLA_RESUMED_MANUAL`; controllers pass `@CurrentActor()`. Tests: `leave-request-*`,
`se-planner-*`, `snapshots-api`, `integration-health-api`, `voucher-controller`, `settings-write`,
`vehicle-unavailability-*` e2e. **Depends on.** — (readable via 342). **Expected.** Every one of these
actions is reconstructible: actor, acting role, entity, reason, before/after. **AC.** (1) one audit
row per action inside the same transaction as the write, with the metadata named above; (2) leave
reject carries the reason; (3) settings rows carry previous and next. **Verification.** e2e asserting
row + metadata per path. **Reference.** n/a — backend audit writers.

### 344 — Admin notification bell + tray  (W1 · P2)

**Problem.** `components/shell/TopBar.tsx:212-218` renders a bell with no handler and no state;
`apps/admin/src/api/` has no notifications client. Managers hold real unread in-app rows
(cross-zone escalations, `INTRADAY_ESCALATION_REQUIRED`) they can never see. Backend list/read/read-all
work (`notifications.controller.ts:22-40`). **Modules.** notifications, intraday. **Code areas.** new
`api/notifications.ts`; `TopBar.tsx` (unread badge, tray on click); new `components/shell/NotificationTray.tsx`
(list, mark-read, mark-all, deep link per type → `/cross-zone`, `/intraday`, `/tickets/:id`); poll every
60 s; tests `apps/admin/test/topbar-notifications.test.tsx`. Backend unchanged (optional `?since=` from #165).
**Depends on.** —. **AC.** (1) badge shows unread count; (2) tray lists newest 50 with type label and
relative time; (3) click marks read and navigates; (4) mark-all works; (5) works for every admin role.
**Verification.** admin component tests with a mocked client. **Reference.** top bar as drawn on
`01-dashboard-zonal-manager.png`.

### 345 — Plant deactivation reaches the SE's day-plan notice  (W1 · P2)

**Problem.** `plant-deactivation/plant-deactivation.service.ts:222-232` strips `batchAssignmentTicket`
rows inside the deactivate tx and enqueues nothing; spine edge E-26 is carried by "a human remembers".
Reactivation restores nothing (`:97-120`). **Modules.** admin-config, scheduling. **Code areas.**
`plant-deactivation.service.ts` (per affected batch → `queueDayPlanOverridden(tx, {seId, scheduleId,
batchId, action:'PLANT_DEACTIVATED'})`, needs a batch→schedule→SE read), `scheduling/day-plan-notification-outbox.ts`
(action vocabulary), `day-plan-notifier.ts` copy; tests `plant-deactivation.e2e-spec.ts`,
`day-plan-notification-outbox-writers.e2e-spec.ts`. **Depends on.** —. **AC.** (1) every SE whose live
plan lost a stop gets one outbox row in the same tx; (2) message names the plant; (3) reactivation
behaviour is **unchanged** and the "restore" question is recorded as a decision item (§7), not built.
**Verification.** e2e: deactivate a plant on today's plan → outbox row per SE; no row when no live stop. **Reference.** n/a — backend; the Plant Deactivations
page copy is unchanged.

### 346 — Fleet-uptime honesty + monthly cube coverage  (W2 · P1)

**Problem.** `reports.service.ts:703-706` returns `100` for a zero window; the controller defaults to
the current month (`reports.controller.ts:117-120`) while the crons only ever write the **previous**
month (`business-sweep-scheduler.service.ts:124-126, 255-273`); the admin 6-month trend
(`api/reports.ts:63-69`) plots `uptimePct` with no `eligibleDeviceCount` guard, so the trend reads
100,100,100,56.19,100,100. Zone/plant maps (`:86,:92`) and the Reports KPI (`ReportsPage.tsx:113`) are
unguarded; the dashboard hero is guarded (`ManagerDashboard.tsx:85`). No test covers an empty month.
**Modules.** reports, dashboard. **Code areas.** `reports.service.ts` (`uptimePct` → `null` when
window ≤ 0; `FleetUptimeReport.fleet.uptimePct: number | null`, same for zone/plant rows);
`api/reports.ts:20-47,63-69`; `ReportsPage.tsx:113,265-276` ("no data" state; trend gap not zero);
`ZmScorecardPage` / company-plant columns that read the maps; `business-sweep-scheduler.service.ts`
(fleet-uptime, root-cause, zm-performance ticks compute **previous and current** month daily; the
aggregation already clamps `windowEnd = min(now, monthEnd)` at `fleet-uptime-aggregation.service.ts:51`);
tests `fleet-uptime-report.e2e-spec.ts`, `reports-controller.e2e-spec.ts`, `scheduler-wiring.e2e-spec.ts`,
admin trend test. **Depends on.** —. **AC.** (1) empty window → `uptimePct: null`, `eligibleDeviceCount: 0`,
never 100; (2) trend chart shows a gap/"no data" for such months; (3) current month is recomputed daily
and the previous month is still finalised on the first of the month; (4) e2e for the empty month;
(5) manual recompute endpoints unchanged. **Verification.** e2e 1, 3, 4; admin test 2.
**Reference.** `21-reports.png` (hero tile + trend); `25-zm-performance-scorecard.png` for the uptime column.

### 347 — Report freshness stamps + auto-escalations cube  (W2 · P2)

**Problem.** All four cubes store `computed_at` (`schema.prisma:2689, 2713, 2748, 2807`) and no report
payload returns it (`reports.service.ts` has zero `computedAt`/`dataAsOf`); `ReportsPage.tsx:67,74,240`
prints the **client clock** as "Data as of". PRD "Data-as-of Timestamp" requires the data time.
Separately, `#333`: `system-efficiency-aggregation.service.ts:226-231` counts `auto_escalations` by
current status and `updated_at`, so resolved escalations vanish from the day. **Modules.** reports.
**Code areas.** `reports.service.ts` (each cube query returns `MAX(computed_at) AS dataAsOf`; report
types), `api/reports.ts` types, `ReportsPage.tsx:67-74,240`, `RootCauseAnalyticsPage.tsx`,
`SystemEfficiencyPage.tsx`, `ZmScorecardPage.tsx`; #333 per its issue file (predicate on `created_at`,
historical recompute). Tests: the four report e2e specs, `system-efficiency-report.e2e-spec.ts`.
**Depends on.** —. **AC.** (1) every `/reports/*` payload carries `dataAsOf` (null when no cube row);
(2) pages print it and label "No cube computed yet" when null; (3) #333's ACs. **Verification.** e2e per
endpoint; admin render test. **Reference.** n/a — existing report pages are the authority; the stamp
is the "Data as of" line already drawn on `21-reports.png`.

### 348 — Ingestion silence detection, reaped-run reason, role-safe freshness  (W2 · P1)

**Problem.** Detectors count runs that happened (`ingestion/ingestion-alert.ts:145-147, 206-209`), so a
stopped cron reads healthy; `health.service.ts:44` computes `ageMinutes` but no threshold exists;
`SnapshotBanner.tsx:26-33` flags only RUNNING > 15 min. A heartbeat-reaped snapshot run records no
reason (`snapshot-run.service.ts:39-45`; `SnapshotRun` has no `error` column). `GET /snapshots/latest`
is ZM/CSM/OH only (`snapshots.controller.ts:28-29`) and the banner swallows the 403 for WM/SE.
**Modules.** ingestion. **Code areas.** `ingestion-alert.ts` (+`overdue` when latest SUCCESS older
than `expectedCadenceMinutes × 2`, cadence from the configured cron), `autoplant/health.service.ts`
(`freshness.stale`), `snapshot-query.service.ts` (`/snapshots/latest` payload +`overdue`),
`schema.prisma` `SnapshotRun.error` + migration, `snapshot-run.service.ts:39-45`
(`ORPHANED_RUN_ERROR` like `master-sync-run.service.ts:55-61`), `snapshots.controller.ts:29` (widen
`latest` to all roles — it is freshness, not data), `SnapshotBanner.tsx` (overdue → red line; no
silent catch); tests `test/ingestion-alert.spec.ts`, `snapshots-api.e2e-spec.ts`,
`snapshot-run-lifecycle.e2e-spec.ts`, banner test. **Depends on.** —. **AC.** (1) zero runs in
2× cadence → `overdue:true` and the banner is red for every role; (2) reaped run shows
`error: ORPHANED_RUN_ERROR` in `/snapshots/runs`; (3) WM and SE sessions get the banner; (4) no false
alert while the scheduler is deliberately disabled — the disabled state renders as "ingestion paused",
not healthy. **Verification.** unit + e2e above; freeze-clock test for the cadence rule.
**Reference.** n/a — banner and health payload only; no new surface.

### 349 — Integration Health page completion  (W2 · P2)

**Problem.** Backend `IntegrationHealth` carries `source` connectivity, `masterSync/snapshot.ageMinutes`,
`reconciliation`, `lifecycle` (`health.service.ts:22-156`); the admin view types only build, lock,
recomputes, ingestion (`api/integrationHealth.ts:48-55`); `BuildHealthPage.tsx:81-111` renders three
cards. `GET /snapshots/runs` (`snapshots.controller.ts:34-46`) has no consumer. Departure auto-closes are
audited but appear nowhere. **Modules.** ingestion, admin-config. **Code areas.**
`api/integrationHealth.ts` (full type), `BuildHealthPage.tsx` (Connectivity, Freshness age, Lifecycle:
missing-from-source / quiet runs / departures & restores per run / tickets auto-closed by departure,
Run history table from `api/snapshots.ts` +`apiSnapshotRuns`), backend `integration-health` +
per-run departure counters if not already on the payload; tests `build-health-page.test.tsx`,
`integration-health-api.e2e-spec.ts`. Absorbs **#224** and the health-page part of **#129** (the
dashboard tally and device-detail history of #129 stay in #129). **Depends on.** 348. **AC.** (1) the
four dropped sections render with the live values; (2) run history is paged and filterable by status;
(3) departures/restores/auto-closed counts per run; (4) OH-only page unchanged in role.
**Verification.** `integration-health-api.e2e-spec.ts` (payload sections + per-run counters),
`snapshots-api.e2e-spec.ts` (runs paging/filter), `build-health-page.test.tsx`. **Reference.**
no v2 image — the page is the authority (#131); extend, do not redraw.

### 350 — Action Required tells the truth and goes somewhere  (W2 · P1)

**Problem.** `dashboard.service.ts:889-901` wires 4 of 9 cards; five return `{count:0, available:false}`
and the panel paints "coming soon" (`ActionRequiredPanel.tsx:45-47`). Cards have no `onClick`
(`:27-52`) although `pages/dispatch/console/AttentionBand.tsx:30-38` already holds the destination
map. CSM/OH dashboards render no panel (`CentralDashboard.tsx:24-45`, `OpsHeadDashboard.tsx`).
`ManagerDashboard.tsx:94-97` fetches `apiZoneEngineers()` for a consumer #277 removed.
**Modules.** dashboard. **Code areas.** `dashboard.service.ts:883-901` + five count helpers —
`unreviewed_batches` (today's `DispatchRun`/batches with `OVERRIDDEN=false` not yet viewed → define as
batches dispatched today, zone-scoped), `critical_insertions_awaiting_accept` → rename to
`critical_escalations_pending` = `IntradayInsertion` `ESCALATION_REQUIRED` open (§21: no acceptance),
`component_blocked` = `ComponentBlockedQueue` open rows, `non_op_awaiting_manager` = `NonOperationalMarking`
pending, `manual_assignment_required` = OPEN+UNASSIGNED tickets past the dispatch window today;
`ActionRequiredPanel.tsx` (cards are `Link`s via a shared `lib/actionRequiredDestinations.ts` extracted
from `AttentionBand.tsx`); `CentralDashboard.tsx`, `OpsHeadDashboard.tsx` (mount the panel, zone-filtered);
`ManagerDashboard.tsx:45,94-111,150-152` (drop dead fetch); tests `dashboard-action-required.e2e-spec.ts`,
`dashboard-critical-action.test.tsx`. **Depends on.** —. **AC.** (1) nine cards return real counts,
zone-scoped for ZM; (2) each card links to the surface that lists its rows with the matching filter;
(3) CSM/OH see the panel pan-India; (4) no "coming soon" remains; (5) the dead engineers fetch is gone.
**Verification.** e2e per card with seeded rows; admin link test. **Reference.** `01-dashboard-zonal-manager.png`,
`03-dashboard-central-service.png`, `04-dashboard-operations-head.png`.

### 351 — Dashboard fidelity: freshness badge, trend, operating mode, grouping, CSV, console link  (W2 · P2)

**Problem.** "Snapshot Healthy" is a literal (`ZmDashboard.tsx:106-108`, `CentralDashboard.tsx:56-58`,
`WarehouseDashboard.tsx:171`); `trendPctVsPrevDay` is `null` unconditionally (`dashboard.service.ts:454`)
although `SoftInactiveCountHistory` exists (`schema.prisma:2651`); `ZoneOperatingModeCard/Table` are
built and mounted nowhere (#136 slice 3); `EscalationQueueList.tsx:16-33` flattens the company/plant
groups the backend supplies; `ZoneOverviewTable.tsx:13,19` promises a CSV export that is absent; the ZM
dashboard lost its critical queue to `/assign` (#277) with no pointer back; `suggestedSes: []`
(`dashboard.service.ts:192,851`) is a dead field. **Modules.** dashboard. **Code areas.** new
`components/SnapshotHealthBadge.tsx` reading `apiSnapshotLatest` (+`overdue` from 348), the three
dashboards; `dashboard.service.ts:411-460` (trend from the two latest history rows per zone),
`ZoneOverviewTable.tsx:145-151`; mount card on `ZmDashboard`, table on `CentralDashboard`/`OpsHeadDashboard`;
`EscalationQueueList.tsx` (group headers with `clusterSize`); `ZoneOverviewTable.tsx` (`lib/csv.downloadCsv`);
`ZmDashboard.tsx` (Critical+ summary tile linking `/assign?filter=critical-plus`, `useAssignDraft.ts:163`
URL preset); remove `suggestedSes` from `api/dashboard.ts:79-90` and the service; tests
`dashboard-zone-overview.e2e-spec.ts`, `dashboard-operating-mode.e2e-spec.ts`, admin tests.
**Depends on.** 348 (badge). Absorbs **#136** slice 3. **AC.** (1) badge reflects latest status and
age; (2) trend column shows a signed % when two history rows exist; (3) operating mode visible to ZM
(own zone) and CSM/OH (all); (4) escalation list grouped with cluster counts; (5) CSV export downloads
the visible rows; (6) ZM sees a Critical+ count that opens the console preset; (7) `suggestedSes` gone.
**Verification.** `dashboard-zone-overview.e2e-spec.ts` (trend), `dashboard-operating-mode.e2e-spec.ts`,
`snapshots-api.e2e-spec.ts` (badge source), admin render tests per surface.
**Reference.** `01-dashboard-zonal-manager.png`, `03-dashboard-central-service.png`,
`04-dashboard-operations-head.png`, `05-dashboard-warehouse.png`.

### 352 — Field component wire contract: component identity + consumed parts  (W3 · P1)

**Problem.** Two breaks in one submission path. (a) `troubleshooting_submissions` has CHECK
`ts_submissions_component_unavailable_item` (`prisma/migrations/20260623150000_…/migration.sql:51-52`)
requiring `component_unavailable_item` when `component_unavailable = true`; the controller passes
`null` unvalidated (`ticketing/troubleshoot.controller.ts:64-65`), the shared DTO documents the field as
"not sent by this build" (`packages/shared/src/index.ts:434-437`) → HTTP 500 on every component-unavailable
report, so no `component_requests` row is ever created and the warehouse queue stays empty. (b)
`TroubleshootSubmitRequest` (`:425-441`) has no `consumedComponents`; the service already has the
loops (`troubleshoot-submission.service.ts:296-309, 330-346`) and `decrementStock` (`:374-381`) → van
stock never depletes, no `inventory_transactions`, Common Kit always complete, Component-Blocked never
fires, `shadowUseRecorded` always false (TKT-04). **Modules.** tickets, inventory. **Code areas.**
`packages/shared/src/index.ts` (`componentUnavailableItem: string` required-when, `consumedComponents:
{componentId: string, qty: number}[]`), `troubleshoot.controller.ts` (class-validator DTO — the
troubleshoot half of **#174**; 400 `COMPONENT_ITEM_REQUIRED`, 400 `UNKNOWN_COMPONENT`, 409
`INSUFFICIENT_VAN_STOCK` mapped from the service), `troubleshoot-submission.service.ts:142-143, 207-234`,
component catalog read for the picker — `ComponentMaster` (`schema.prisma:1319`) has no list endpoint:
add `GET /api/components` (all roles, active rows) — the catalog half of **#173**; tests
`troubleshoot-controller.e2e-spec.ts`, `component-request-raise.e2e-spec.ts`, `shadow-use-conflict.e2e-spec.ts`,
`inventory-rollback.e2e-spec.ts`. Mobile form changes are excluded; the contract must be ready for it.
**Depends on.** 336. **AC.** (1) component-unavailable with an item → 201 and a `component_requests` row
with the component; without → 400, never 500; (2) `consumedComponents` decrements `se_van_stock`,
writes `TICKET_CONSUMPTION` transactions, and on the business-409 path records SHADOW_USE with
`shadowUseRecorded:true`; (3) Common Kit status changes after a consumption that empties a kit item and
the recommender writes `component_blocked_queue`; (4) `GET /api/components` returns the catalog; (5)
submissions without the new fields behave exactly as today. **Verification.** e2e 1-4 end to end
(submit → van stock → kit → blocked queue → WM request queue); existing rollback tests now have rows.
**Reference.** n/a — backend and shared contract only; the admin queues it fills are unchanged
(`17-component-blocked-queue.png`, `18-component-requests.png`).

### 353 — Inventory ledger closure: dispute restore, recovery receipt, ZM dispute view  (W3 · P2)

**Problem.** `inventory/shadow-use.service.ts:72-99` `markDisputed` flips status and writes audit but
never restores the losing SE's van stock (contrast `verification.service.ts:400-415`). Recovery
`confirmWarehouseReceipt` (`ticketing/recovery.service.ts:138-169`) closes the ticket and writes no
stock/transaction row; `warehouse-stock.service.ts` has no increment API. The Shadow Use routes are
WM-only (`shadow-use.controller.ts:41-56`) so the ZM a dispute is "escalated to" can never see it.
**Modules.** inventory, tickets. **Code areas.** `shadow-use.service.ts` (compensating
`SHADOW_USE_DISPUTE_RESTORE` transaction + `se_van_stock` increment in the same tx),
`recovery.service.ts` (write `RECOVERY_RECEIPT` `inventory_transactions` row keyed by device; increment
`zone_warehouse_stock` only when a device→component mapping exists — **decision item §7**, default:
transaction row only), `warehouse-stock.service.ts` (+`increment`), `shadow-use.controller.ts` (+ZM
zone-scoped `GET /shadow-use?status=DISPUTED`), admin `api/shadowUse.ts`, a "Disputes" section on the
ZM Component Requests page or ticket drawer; tests `shadow-use-*`, `recovery-receipt-unable`,
`warehouse-stock` e2e, admin test. **Depends on.** 352. **AC.** (1) dispute restores exactly the
decremented qty with a ledger row; (2) receipt writes a ledger row (+stock when mapped); (3) ZM lists
own-zone disputes with reason and escalation metadata; (4) WM guard unchanged (ZM/CSM/SE still 403 on
WM writes). **Verification.** `shadow-use-queue`, `shadow-use-controller`, `recovery-receipt-unable`,
`warehouse-stock` e2e (ledger arithmetic before/after); admin test for the ZM disputes section.
**Reference.** `19-shadow-use-queue.png`, `18-component-requests.png`.

### 354 — Cross-zone approve is atomic and the target zone is told  (W3 · P1)

**Problem.** `cross-zone-escalation.service.ts:162` commits the assignment in `assignTicket`'s own tx,
`:163` returns early on `ALREADY_ASSIGNED`, and `:166-178` updates the escalation to APPROVED outside
any tx — a crash leaves the ticket assigned and the escalation PENDING; retry short-circuits
(**#139**). `sweepAutoEscalations` `:99-115` does create → audit → notify with no tx and no per-ticket
catch, and the `crossZoneEscalations:{none:{}}` predicate then excludes the ticket forever (**#140**).
`notifyHomeZm:319-320` returns silently when a zone has no manager (CZ-09). The **target** ZM is never
notified and `listForScope:226` scopes a ZM by `homeZoneId` only, so incoming work is invisible (CZ-11).
**Modules.** cross-zone, scheduling, notifications. **Code areas.** `cross-zone-escalation.service.ts`
(`approve` passes the #325 `inTransaction` callback to `assignTicket` to write APPROVED + target ids in
the same tx; `ALREADY_ASSIGNED` with matching `assignedSeId` reconciles the row instead of returning;
sweep: per-ticket try/catch + enqueue via 338; `notifyHomeZm` → role-based resolver
`notification.service.ts` `recipientsInRoles({role:'ZONAL_MANAGER', zoneId})` with a logged miss;
+`notifyTargetZm`; `listForScope` OR `targetZoneId` for ZM with an `direction: 'incoming'|'outgoing'`
flag), `cross-zone.controller.ts` (map non-OK results — CZ-13), admin `CrossZonePage.tsx` (incoming
badge); tests `cross-zone-escalation.e2e-spec.ts`, `cross-zone-controller.e2e-spec.ts`. Absorbs **#139**,
**#140**, the cross-zone half of #331. **Depends on.** 338. **AC.** (1) crash injected after the
assignment tx cannot leave PENDING (the row flips inside the tx); (2) retry after `ALREADY_ASSIGNED` for
the same SE reconciles to APPROVED; (3) a notify throw in the sweep neither aborts the sweep nor orphans
the escalation; (4) missing ZM → all ZMs of the zone by role, or a logged `NO_RECIPIENT` — never a
silent return; (5) target ZM receives `CROSS_ZONE_INCOMING` and sees the row in `/cross-zone`.
**Verification.** crash-injection e2e using `test/support/tx-hooks.ts`; recipient e2e.
**Reference.** n/a for the backend; the incoming badge follows the existing Cross-Zone page (#78).

### 355 — Cross-zone page completion: flag from ticket, re-escalate, modal, deferred resurfacing, history  (W3 · P2)

**Problem.** `apiCrossZoneFlag` has zero call sites (**#92**); a DENIED AUTO row vanishes from
`listForScope:225` and the ZM re-escalate route (`cross-zone.controller.ts:103`) has no button
(**#93**); approve uses five `window.prompt`s (`CrossZonePage.tsx:56-72`) and the target zone is not
validated against the SE (`service:170-171`); deferred escalations persist `reviewDate` (`:271`) and
nothing ever resurfaces them; no read of who approved what (`listForScope` excludes APPROVED/DENIED).
**Modules.** cross-zone. **Code areas.** `pages/tickets/TicketDetailDrawer.tsx` (ZM "Flag cross-zone"
with reason modal, hidden for PLATINUM), `cross-zone-escalation.service.ts` (`listForScope` includes
DENIED AUTO for the home ZM; `history(scope, range)`; due-review sweep in `business-sweep-scheduler.service.ts`
`crossZoneTick` → DEFERRED past `reviewDate` back to PENDING + notice), `cross-zone.controller.ts`
(+`GET /cross-zone/history`), `cross-zone.dtos.ts` (derive/validate `targetZoneId` from the SE's
`engineerMaster.zoneId`), `CrossZonePage.tsx` (Modal with zone select + SE picker from `api/engineers.ts`,
Re-escalate button for ZM, Review-date column, History tab), `api/crossZone.ts`; tests e2e + admin.
Absorbs **#92**, **#93**, the cross-zone legs of **#80**. **Depends on.** 354. **AC.** (1) ZM can flag a
Gold/Silver ticket from its drawer; (2) home ZM sees DENIED AUTO rows and can re-escalate; (3) approve
uses a modal, SE picker constrains zone, mismatch → 400; (4) a deferred row returns to PENDING on its
review date with a notice; (5) history lists decisions with decider, acting role, reason, date, zone
clamp for ZM. **Verification.** `cross-zone-escalation` + `cross-zone-controller` e2e (DENIED AUTO
visibility, zone/SE validation, due-review sweep with a frozen clock, history clamp); admin tests for
the drawer flag action and the page modal/tab. **Reference.** `28-tickets-drawer.png`; the Cross-Zone
page (#78) is the authority for its own layout.

### 356 — Intra-day queue hygiene: bounded reads, refresh, labels, dead routes, dead branch  (W3 · P2)

**Problem.** `intraday-insertion.service.ts:478-484` returns every insertion ever (552 rows for one
ZM), `same-day-update.service.ts:104-107` loads every `MANUAL_ZM_UPDATE` audit row; the page loads once
(`IntradayQueuePage.tsx:148`) with no refresh; manual-assign rows show the raw `ACCEPTED` enum
(`:74-111`); `escalateToZm` returns silently when a zone has no ZM (`:495`; also
`stranded-work-escalation.service.ts:118`); three same-day write routes (`intraday-updates.controller.ts:40,75,99`)
are live with zero callers after #313 made `/batches/:id/override` the single surface; the comment at
`api/schedules.ts:436` is stale after #311; `notification.service.ts:158-166` `SE_ACCEPTANCE` is dead
after §21. **Modules.** intraday, scheduling, notifications. **Code areas.** `intraday-insertion.service.ts`
(`listForScope` +`take`, `status`, `since`, cursor; `escalateToZm` via the 354 resolver),
`intraday-insertion.controller.ts:44` (query DTO), `same-day-update.service.ts:104` (bound + index
`audit_logs(action, created_at)` if absent), `stranded-work-escalation.service.ts:117-133`,
`intraday-updates.controller.ts` (**delete** add/remove/reorder + their service methods and e2e; keep
GET — recorded decision: #313), `api/intradayInsertions.ts`, `api/intradayUpdates.ts`,
`IntradayQueuePage.tsx` (status chips, "since" filter, pager, 30 s refresh while visible + Refresh
button, label "Manager assignment" for ACCEPTED), `api/schedules.ts:436`, `notification.service.ts:158-166`
+ `NotificationDelivery.firstClass` retirement; tests `intraday-insertions-controller`, `intraday-critical-insertion`,
`se-unavailable-stranded-work`, `same-day-update-service` e2e, `intraday-queue.test.tsx`,
`notification-service.e2e-spec.ts`. Absorbs **#331**. **Depends on.** — (soft: the role-based
recipient resolver `recipientsInRoles` is introduced by 354; whichever of 354/356 lands first builds
it in `notification.service.ts` and the other adopts it). **AC.** (1) default page ≤ 50
rows, newest first, filter by status and date, cursor paging; (2) refresh without reload; (3) no raw
enum label; (4) missing ZM → role fallback or logged miss; (5) the three routes 404 and no client
references remain; (6) dead acceptance branch removed with its test rewritten. **Verification.**
`intraday-insertions-controller` (paging/filter), `intraday-critical-insertion` and
`se-unavailable-stranded-work` (recipient fallback), `same-day-update-service` (bound), route-absence
assertion for the three deleted doors, `notification-service` e2e (branch gone); `intraday-queue.test.tsx`.
**Reference.** `13-intraday-queue.png`.

### 357 — Verification integrity: zone-scoped fraud flags, run verdict, de-escalate, reasons  (W3 · P1)

**Problem.** `verification-query.service.ts:214-226` `fraudFlags()` takes no scope while `review()`
and `forTicket()` clamp ZM (`:161-183`); `verification.service.ts:183-186` marks auto-recovery only on
`outcome: null` runs so a FAILED_NO_PINGS run keeps FAILED while the ticket becomes
CLOSED_AUTO_RECOVERY (two ledgers disagree; `/reports/verification-outcomes` counts it FAILED); no
route reverses ESCALATED (`verification.controller.ts:67-101`); the escalation reason lives only in
`auditLog.metadata` (`verification.service.ts:138`); mark-auto-recovery takes no reason (`:88-101`).
**Modules.** verification. **Code areas.** `verification-query.service.ts` (`fraudFlags(scope)`),
`verification.controller.ts:111-115` (pass `@CurrentScope`), `verification.service.ts:183` (update the
run to `CLOSED_AUTO_RECOVERY` outcome for FAILED rows too, guarded by #301's `stampOnceOrLose`),
+`deescalate(ticketId, actor, reason)` (ESCALATED → back to the pre-escalation review state, audited,
guarded), `schema.prisma` `VerificationRun.escalationReason` + migration, `reports.service.ts:545-556`
(reason/outcome columns), `mark-auto-recovery` body `{reason}` required; tests `verification-controller`,
`verification-guarded-transitions`, `verification-staleness` e2e. **Depends on.** 336. **AC.** (1) ZM
gets own-zone fraud flags only; CSM/OH all; (2) after mark-auto-recovery the run and the ticket agree
and the outcomes report counts it as auto-recovery; (3) de-escalate exists, ZM/CSM/OH, requires reason,
audited, refused on a closed ticket; (4) reason persisted on the run and returned by the outcomes report;
(5) mark-auto-recovery without reason → 400. **Verification.** e2e per AC with the 336 rows.
**Reference.** n/a — backend; the page half is 358.

### 358 — Verification review page completion  (W3 · P2)

**Problem.** No admin client calls `fraud-flags` (`api/verification.ts`); the countdown prints
"overdue" for windows the sweep will never expire (`verification-query.service.ts:206-209`;
`VerificationReviewPage.tsx:31-34`) with no stall indicator (**#148** slice 3); mark-auto-recovery has no
confirm (`:228`); no de-escalate control. **Modules.** verification. **Code areas.**
`verification-query.service.ts` (expose `telemetryAsOf`, `stalled`), `api/verification.ts`
(+`apiFraudFlags`, `apiDeescalate`, reason on mark), `VerificationReviewPage.tsx` (Fraud-flagged
filter/tab from the endpoint, "stalled — telemetry as of …" chip instead of "overdue", reason+confirm
modal for mark-auto-recovery, De-escalate action), admin tests. Absorbs **#148** slice 3.
**Depends on.** 357. **AC.** (1) fraud-flagged rows come from the scoped endpoint; (2) a window whose
telemetry watermark has not advanced shows stalled, never overdue; (3) both destructive actions need a
reason and a confirm; (4) de-escalate visible only on ESCALATED rows. **Verification.**
`verification-staleness.e2e-spec.ts` (stalled flag), admin page tests for the tab, chip and modals.
**Reference.** `14-verification-review.png`.

### 359 — Expense voucher controls: separation of duties, atomic mark-paid, ticket match  (W3 · P1)

**Problem.** `REVIEW_ROLES` includes OH (`vouchers.controller.ts:26,134-136`) and `markPaid`
(`vouchers.service.ts:321-330`) checks only `status === 'APPROVED'`, so one OH clears both money gates
(reproduced live). `markPaid` loops one `withAudit` tx per voucher with no outer tx and no catch
(`:321-348`): a failure at N leaves 1..N-1 PAID and throws 500 with no `failed[]`. `activityCheck`
(`:469-484`) proves only that the ticket exists — not that it was assigned to the SE or matches the plant.
**Modules.** vouchers. **Code areas.** `vouchers.service.ts:312-348` (skip with `SAME_APPROVER` when
`reviewedBy === actor.userId`; one `$transaction` for the batch, or per-row catch returning `failed[]`
— choose per-row catch so one bad id does not block a month's batch), `MarkPaidOutcome` type
(`paid[] / skipped[] / failed[]`), `:226-233,469-484` (join ticket → assignment SE + plant; warnings
`TICKET_NOT_ASSIGNED_TO_SE`, `TICKET_PLANT_MISMATCH`), `VoucherActivityCheck` type, admin
`pages/vouchers/VoucherReviewPage.tsx` (skip/fail reasons, new warning labels); tests `voucher-service`,
`voucher-controller` e2e. VCH-08 (no un-pay) is a **decision item §7**, not built. **Depends on.** 336.
**AC.** (1) the reviewer of a voucher cannot mark it paid — skipped with reason, audited; (2) a batch
reports every id in exactly one of paid/skipped/failed and never 500s on a bad id; (3) ticket-match
warnings appear in the review queue; (4) reject-reason gate unchanged. **Verification.**
`voucher-service` and `voucher-controller` e2e (same-approver skip, mixed batch outcome, mismatch
warnings) using the 336 engineer; admin test for the outcome rendering. **Reference.** none in v2 for
vouchers — page is the authority.

### 360 — SE poll contract: paginated tickets, VU-deferred visibility, readable day-plan notices  (W3 · P2)

**Problem.** `GET /me/tickets` (`me-tickets/me-tickets-query.service.ts:72-96`) returns the whole
shared pool unpaginated (521 rows). Filing vehicle unavailability defers the ticket
(`vehicle-unavailability.service.ts:186-195`) and `notDeferredOn` (`:81`) drops it from the SE's own
list the moment they file it. The day-plan notice body is `` `Your Day Plan was updated (${action}).` ``
(`scheduling/day-plan-notifier.ts:75`) — a raw audit action with no ticket or plant. **Modules.**
tickets, scheduling. **Code areas.** `me-tickets.controller.ts:34-38` + query service (`take` default
50, cursor, `section` filter; `MeTicketsView` in `packages/shared`), `me-tickets-query.service.ts`
(+branch: tickets with the SE's own OPEN VU report, `workState:'VEHICLE_UNAVAILABLE'`),
`day-plan-notifier.ts` (action → sentence map), `day-plan-notification-outbox.ts:54` (payload +`ticketId`,
`plantName`, or resolve at drain), the 7 `queueDayPlanOverridden` callers if the payload widens; tests
`me-tickets-controller`, `me-tickets-removal-metadata`, `day-plan-notifier-spine`, `day-plan-notification-outbox`
e2e. Takes the tickets leg of **#165** (shared pool / day-plan bounding stay there). **Depends on.** —.
**AC.** (1) paged, cursor-stable, default 50, `total` returned; (2) an SE who filed VU still sees the
ticket with its state and return date; (3) notices read "Stop added: <plant> (<ticket ref>)" etc. —
no enum leaks; (4) unpaginated callers (none in admin; mobile) keep working via defaults.
**Verification.** `me-tickets-controller` (paging, cursor stability, defaults),
`me-tickets-removal-metadata` (VU branch), `day-plan-notifier-spine` and
`day-plan-notification-outbox` e2e (copy per action). **Reference.** n/a — backend contract; the
mobile list that renders it is out of scope.

### 361 — Notification producers for the remaining PRD events  (W4 · P2)

**Problem.** PRD story 72 lists SLA warnings, verification failures, component approvals, batch status
changes, recovery decisions. Missing producers: component request APPROVED/SHIPPED/REJECTED
(`component-request.service.ts:323-350` writes audit only — INV-G3), Common-Kit-short / component
blocked (`inventory.service.ts:107-125` — INV-G7, #53), 7-day waiting-component escalation notice to
ZM (INV-G4), SLA-warning at bucket crossing, snapshot FAILED/overdue to OH, departure auto-close notice
to the ZM (`device-departure.service.ts:299-334` — ING-01), voucher decisions (`vouchers.module.ts:17`
binds `LoggingVoucherNotifier` while `VoucherReviewPage.tsx:24,228` claims the SE is notified — VCH-07).
**Modules.** notifications, inventory, ingestion, vouchers, tickets. **Code areas.** producers in the
files above using the 338 helper inside their transactions; new `vouchers/notification-voucher-notifier.ts`
bound in `vouchers.module.ts`; SLA sweep producer where the bucket recompute runs
(`device-state`/ticket SLA service); `ingestion-alert.ts` → OH notice on transition to alert/overdue;
tests `notifier-adoption-wiring.e2e-spec.ts` extended per event, `component-request-warehouse`,
`voucher-service` e2e. Absorbs #53, the adoption remainder of #76 (customer-confirmation excluded, see §7).
**Depends on.** 337, 338. **AC.** (1) one notification per listed event, to the role the PRD names
(SE for ship/reject/kit-short, WM for approval requests, ZM for waiting-component and departure
auto-close, OH for snapshot failed/overdue, SE for voucher decisions); (2) every producer enqueues via
the 338 helper inside the mutation transaction; (3) sweep-driven events are deduplicated per
(event, entity, day); (4) the Voucher Review page's "SE is notified" wording is true, or removed.
**Verification.** `notifier-adoption-wiring.e2e-spec.ts` extended with one case per event,
`component-request-warehouse` and `voucher-service` e2e; dedup pinned with a double sweep.
**Reference.** n/a — backend producers only; the voucher page wording change is copy on the existing
Vouchers page.

### 362 — User administration completion + reference-read hardening  (W4 · P2)

**Problem.** `PATCH org/users/:userId {status}` exists (`org/users.controller.ts:29-35`) but the admin
client and Users section expose no disable control (`api/org.ts:105-112`, `sections.tsx:513-545`); no
route changes a user's role or zone (`users.service.ts` has `list/create/setStatus` only);
`org/geography.controller.ts:9-12` is readable by every authenticated role. (Account creation and
passwords are out of scope — #91.) **Modules.** admin-config. **Code areas.** `users.controller.ts`,
`users.service.ts` (+`update({role?, zoneId?})`, audited, revoking refresh tokens via
`auth/prisma-refresh-token-store.ts` on role/zone change, refusing to demote the last OH),
`api/org.ts` (+`setUserStatus`, `updateUser`), `pages/settings/sections.tsx` Users rows (Disable/Enable,
Edit role/zone modal), `geography.controller.ts` (`RoleGuard` + manager roles); tests `org-users`,
`org-geography` e2e, `settings.test.tsx`. **Depends on.** —. **AC.** (1) OH can disable/enable and
change role/zone from Settings; (2) a changed user's sessions are revoked; (3) last active OH cannot be
disabled or demoted; (4) geography reads refuse SE/WM. **Verification.** `org-users` e2e
(status, role/zone change, token revocation, last-OH guard), `org-geography` e2e (role refusal),
`settings.test.tsx` for the row controls. **Reference.** `26-settings.png`.

### 363 — Leave integrity: revoke, tie-break, overlap guard  (W4 · P2)

**Problem.** `se-availability.service.ts:60-64, 87-94` order by `windowStart desc` with no tie-break,
so a correction written for the same day loses to the older row while the UI shows it on top; there is
no revoke/cancel route (`leave-request.controller.ts` has submit/list/approve/reject only); `submit`
(`leave-request.service.ts:61-77`) accepts overlapping and duplicate PENDING windows. **Modules.**
engineers. **Code areas.** `se-availability.service.ts:62,90` (`orderBy: [{windowStart:'desc'},{id:'desc'}]`),
`leave-request.service.ts` (+`revoke(id, actor, reason)` on APPROVED → writes an AVAILABLE window and
audits `LEAVE_REVOKED`; overlap query on PENDING/APPROVED → 409 `OVERLAP`), `leave-request.controller.ts`,
admin `api/engineers.ts`, `pages/engineers/LeaveRequestsPage.tsx` (Revoke with reason; overlap error
state); tests `se-availability-service`, `recommender-availability`, `leave-request-*` e2e, admin test.
**Depends on.** 343. **AC.** (1) latest write for a day wins in both reads and the recommender;
(2) revoke returns the day to the recommender within one run; (3) overlapping submit → 409; (4) all
audited. **Verification.** `se-availability-service` (tie-break), `recommender-availability`
(revoke reaches dispatch), `leave-request-*` e2e (overlap 409, audit rows); admin test for Revoke and
the overlap error. **Reference.** `15-se-activity.png`.

### 364 — Report pages consume what the API already offers  (W4 · P2)

**Problem.** The clients call five report endpoints with no parameters (`api/reports.ts:120-201`) while
the backend accepts from/to/zone/company/plant/deviceType/SE (`reports.controller.ts:149-257`); the ZM
scorecard `trend[]` is computed (`reports.service.ts:470-509`) and typed `unknown[]` on the client
(`api/reports.ts:199`); no report number links to its rows; the Exports hub has one card while the
finance voucher export lives only on the Vouchers page. **Modules.** reports. **Code areas.**
`api/reports.ts` (param builders, typed `ZmScorecardSeries`), `ReportsPage.tsx`, `RootCauseAnalyticsPage.tsx`,
`SystemEfficiencyPage.tsx`, `ZmScorecardPage.tsx` (filter bar: zone (ZM clamped), date range, company,
plant, device type, SE; `TrendChart` for the scorecard; row links → `/reports/fleet?zone=`,
`/tickets?rootCause=`, `/engineers/:id`), `pages/exports/ExportsPage.tsx` (+Finance voucher batch card
→ `apiExportVouchers(month)`, month picker), optional `exports.controller.ts` voucher summary; admin
tests. **Depends on.** 347. **AC.** (1) every filter round-trips to the API and the ZM clamp is echoed;
(2) scorecard trend drawn; (3) each report table row links to a filtered source list; (4) exports hub
shows the voucher batch with row count for the month. **Verification.** admin tests per page
asserting the query string each filter produces and the ZM clamp echo; scorecard trend render test;
exports-hub card test; backend unchanged. **Reference.** `21-reports.png`,
`23-root-cause-analytics.png`, `24-system-efficiency.png`, `25-zm-performance-scorecard.png`.

### 365 — SE productivity report  (W5 · P3)

**Problem.** PRD (`:33`, `:340`, story 25) names SE productivity on `/reports`; no route, endpoint or
page exists. Raw material: `fleet.seRepairedClosures` (`reports.service.ts:322-333`), the `se_id`
dimension of `system_efficiency_summary_daily`, `me-work-history.service.ts`. Prerequisite: audit F7 —
`se_repaired_closures` mis-attributes departure closures (`fleet-uptime-aggregation.service.ts:89-94`)
and must split by `closure_type` first. **Modules.** reports. **Code areas.** `fleet-uptime-aggregation.service.ts:89-94`,
new `reports.service.ts` method + `reports.controller.ts` route (OH/CSM all zones, ZM own), `api/reports.ts`,
new `pages/reports/SeProductivityPage.tsx`, `AppRoutes.tsx`, `lib/nav.ts`, new e2e spec. **Depends on.**
346; **design stop** — no v2 or approved design exists; produce one under
`docs/ui/desktop/approved-designs/` before the page (filed `ready-for-human`, Type HITL then AFK).
**AC.** per-SE closures by type, first-time-fix rate, failed-verification rate, average on-site →
submission time, weekly/monthly, from summary tables, zone clamped. **Verification.** new e2e spec
against a seeded month; the F7 split pinned by `fleet-uptime-report.e2e-spec.ts`. **Reference.**
none exists — the design produced at the design stop under `docs/ui/desktop/approved-designs/`
becomes the reference; `21-reports.png` governs the page chrome.

### 366 — Zone Warehouse pickup stop on the Day Plan  (W5 · P3)

**Problem.** `DayPlanStop` (`packages/shared/src/index.ts:571-578`) has no stop kind; the query
docblock defers the pickup step (`scheduling/day-plan-query.service.ts:15-16`); an SE with a SHIPPED
part has no warehouse stop. **Modules.** scheduling, inventory. **Code areas.** `packages/shared`
(`kind: 'PLANT' | 'WAREHOUSE_PICKUP'`), `schema.prisma` (+ pickup flag/row on the schedule) + migration,
`day-plan-query.service.ts`, `batch-assignment.service.ts` (emit stop 0 when a SHIPPED request exists
for a ticket on the plan), `test/day-plan-query.e2e-spec.ts`. Mobile rendering excluded. **Depends on.**
352; **design stop** for the mobile/admin rendering (PRD flow text only; filed `ready-for-human`,
Type HITL then AFK). **AC.** a plan whose tickets have SHIPPED-not-RECEIVED requests carries one
pickup stop first; none otherwise; admin schedule detail shows it. **Verification.**
`day-plan-query.e2e-spec.ts` with and without a SHIPPED request; schedule-detail admin test.
**Reference.** none exists — produced at the design stop under `docs/ui/desktop/approved-designs/`;
`12-batch-schedule-review.png` governs the schedule-detail chrome the stop appears in.

---

## 5. Critical path, shared blockers, parallelism

**Shared blockers (do first, in this order):** P0-a commit → **336** → **338** and **337** (the exit
and the durable path; every "nobody is told" finding in five modules ends here) → **339 → 340 → 341**
(the control chain) → **342** (the ledger becomes readable; 343/340's rows need it).

**Critical path (longest dependency chain):** 336 → 338 → 354 → 355 (cross-zone), and 337/338 → 361.
The money path (359) and the component path (352 → 353 → 366) are independent of the notification
chain and can run beside it.

**Wave parallelism.** Within a wave the slices touch disjoint files except where "depends on" says
otherwise; two or three sessions can run a wave concurrently (as the survey and the forensics session
did). Cross-wave: 346/347/348/350 have no upstream dependency and may start in wave 1 if capacity exists.

---

## 6. Expected completion progression

Survey baseline 63 % capability-weighted (the survey's own number; absolute values are LOW confidence,
ranking is not). Indicative, for the in-scope modules:

| after | what is true that is not true today | approx |
|---|---|---|
| Wave 1 (336–345) | the field is told; acting is gated and attributed; the ledger is readable; deactivation reaches the plan | ~70 % |
| Wave 2 (341, 346–351) | every number on a dashboard or report is either right or visibly absent; acting narrows writes | ~77 % |
| Wave 3 (352–360) | component, cross-zone, verification, voucher and intra-day workflows run end to end without a human remembering | ~86 % |
| Wave 4 (361–364) | PRD notification events, user admin, leave correction, report usability | ~91 % |
| Wave 5 + §7 decisions | productivity report, pickup stop, un-pay / reactivation rulings | ~94 % |

The remaining ~6 % is mobile, auth/account flows, external provisioning (FCM, WhatsApp/SMS, SAP PGI
#116) and the product decisions below — all outside this plan by scope.

---

## 7. Deliberately excluded, and decisions the plan needs from the operator

**Excluded by scope (not filed):** mobile app (NOTIF-07/#89 client, VCH-03/04/05/11, TKT-03, TKT-05/06/08,
INTRA-G4 client, INV-G7 screen); login/signup/account creation (AA-04 → #110, AA-10, AC-01 → #91);
purely cosmetic items (ENG-G3, SCH-07, CZ-10 — scanner notes); findings disproven above (AC-04b, AC-13,
SCH-01, SCH-05, CZ-03, NOTIF-05 as a gap).

**Decision items — Strategic HITL (business rule / architecture / backlog ownership).** Each is recorded
on the slice that touches it and none blocks the wave it sits in:

| item | question | default the plan assumes |
|---|---|---|
| VCH-08 | May a PAID voucher be reversed? | No reversal; a `PAYMENT_REVERSED` status is not built. |
| AC-03 | Should reactivating a plant restore the tickets/stops it cancelled? | No; a fresh cycle opens on the next pipeline run (current behaviour). |
| E-15 | Should a closed ticket pre-fill an expense voucher? | Backend accepts `ticketId`/`plantId` already; the prefill is a mobile change (excluded). |
| E-17 | Is a finance/payroll seam wanted beyond the CSV + mark-paid? | No seam; 359 makes mark-paid safe. |
| INTRA-G4 | May an SE decline one stop (§21 retired whole-day decline only)? | Not built; whole-day unavailable stays the only path. |
| INV-G2 | Which component (if any) does a recovered device increment? | Transaction row only; stock unchanged. |
| AA-06 | Auto-open a ZM's unavailability window from a >24 h login gap? | Not built; windows are opened by OH/CSM in 339. |
| 339 architecture | Request-scoped acting guard replacing sync header parsing. | Recommended and assumed. |
| 356 deletion | Delete the three uncalled same-day write routes (#313 made override the single surface). | Delete. |
| TKT-09 | Customer confirmation channel (SMS/WhatsApp to a non-user). | External seam; stays on #76 (HITL accounts). |
| INV-G6 | SIM serial cross-check needs an expected SIM in master data. | Deferred until AutoPlant supplies it. |
| SCH-04, VCH-12, ENG-G5 | cadence-review reminder; configurable spend limits; enumerated availability reasons | Not filed; polish once waves 1–4 land. |
| ING-07 | Partition maintenance default-off. | Ops posture; #320 owns resilience. |

---

## 8. PRD-critical workflows and the slices that complete them end to end

| workflow (PRD) | today | complete after |
|---|---|---|
| Dispatch → SE is told (stories 74–76) | outbox written, never delivered | 337, 338, 360 |
| CRITICAL insertion → SE told, ZM alerted (§21) | in-app only, bell dead | 337, 338, 344, 356 |
| Component unavailable → WM request → ship → SE receipt (64–65, 79) | 500 on step 1 | 352, 361 |
| Parts consumed → van stock → Common Kit → Component-Blocked (55, 71, 80) | never recorded | 352, 353 |
| Shadow use → reconcile/dispute → ZM (66–67, 70) | dispute loses stock, ZM blind | 353 |
| Recovery → warehouse receipt → inventory (62) | ticket closes, no ledger | 353 |
| Cross-zone Platinum auto-escalation → approve → target zone works it (42–44) | approve can orphan; target zone blind | 354, 355 |
| CSM acts for an absent ZM, attributed (43, 45, 46) | ungated, unattributed | 339, 340, 341 |
| Audit trail for any ticket / any action (73) | ticket-UUID read only | 342, 343 |
| Fleet Uptime / data-as-of / stuck snapshot (47, 74) | fabricated 100 %, client clock | 346, 347, 348, 351 |
| Action Required → act (story set 1–12) | 5 of 9 cards dead, none clickable | 350 |
| Verification review → escalate / auto-recovery / fraud (153–160) | unscoped flags, no undo | 357, 358 |
| Voucher review → export → PAID (59, 60) | same person both gates; partial batch | 359, 364 |
| Leave / availability → recommender (136–146) | correction loses to older row | 363 |
| Plant deactivation → SE plan (51) | silent | 345 |
| Departed device → ticket auto-close → manager sees it (61d) | audited, invisible | 349, 361 |

---

## 9. Issue files — how the slices were filed (2026-09-03)

Slices 336–366 are filed one-to-one as `.scratch/fsm-platform-v1/issues/<n>-<slug>.md` and indexed
under **P12** in `INDEX.md`. The filing pass recorded these transcription notes; the plan above has
been reconciled to them so the two never disagree:

- **343** — the plan's single composite AC is filed as three checkboxes (row-in-tx with metadata;
  reject reason; settings previous/next). Same scope.
- **361** — filed with one composite AC; the plan now states the four clauses explicitly (recipient
  per event, in-tx via 338, sweep dedup, voucher wording). The issue file carries the same four.
- **339** — carries two "Decisions recorded" entries: the request-scoped acting guard and the AA-06
  default (no heartbeat auto-activation; windows are opened by OH/CSM).
- **356** — no hard dependency; the role-based recipient resolver is shared with 354 and is built by
  whichever lands first (recorded on both).
- **351** — reference images resolved to full filenames (`05` is `05-dashboard-warehouse.png`).
- **365, 366** — filed `ready-for-human`, Type "HITL (design stop) then AFK", because no reference
  design exists; every other slice is `ready-for-agent` / AFK, with 337 additionally HITL for FCM
  credentials only.
- Where the plan named no Reference (347, 348, 352, 354) the issue says `n/a` with the reason; where
  it named no Verification line (349, 351, 353, 355, 356) the issue lists the test files the plan
  names — both are now stated in §4 as well.
- Each issue lists the survey ids and existing issues it absorbs; absorbed issues (#92, #93, #139,
  #140, #145, #224, #239, #318, #331, #333; slices of #136, #148, #129) keep their files as the
  detailed spec and close into the slice when it lands.
