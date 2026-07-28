# SE Mobile — Data-Needs Spec for the Six Unreferenced Screens

**Date:** 2026-07-28 · **HEAD:** `12a3e70` · Companion to
[`mobile-backend-freeze-plan-2026-07-28.md`](./mobile-backend-freeze-plan-2026-07-28.md).

**Why this exists.** Ten SE mobile screens have reference images and were field-derived under #172.
Six have none: Recovery Collection, Install Form, Intra-day offer, Leave Request, Availability, and
the 409 Conflict screen. The operator **closed D-9 as not-taken** — no mockups will be commissioned,
because UI is cheap to iterate during the build and the visual design is not what forces a mid-build
backend change. **A missing field is.** So this derives the data needs from PRD and workflow prose
instead, and flags every field that does not exist today.

Status legend: **(a)** served today · **(b)** endpoint exists, field absent · **(c)** no SE-callable
endpoint · **(d)** **not in the schema at all — needs a migration**.

---

## The headline: seven things that do not exist in the schema

These are the expensive class and the reason to settle them before the freeze.

| # | Missing data | Screens | Authority requiring it | Evidence absent |
|---|---|---|---|---|
| **D1** | **`expected_component` per ticket** | Intraday offer, Ticket Detail, Day Plan | CONTEXT:239 (the WhatsApp confirmation "carries … expected component"), workflow:291-292, PRD:484/523 | No column on `Ticket` (`schema.prisma:2026-2080`); no `expected_components` table. `ComponentBlockedQueue` (`:1079`) is a manager queue, not a per-ticket expectation |
| **D2** | **`offline_submission_receipts`** — the `(se_id, submission_type, client_submission_id)` ledger | all five write screens | workflow:1668; workflow:1689 — *"**All** SE-mobile write endpoints accept `client_submission_id`"* | No model. `clientSubmissionId` exists only on `TroubleshootingSubmission` (`schema.prisma:844`) and `ExpenseVoucher` (`:913`) |
| **D3** | **`client_submission_id` on recovery / install / leave / availability writes** | 1, 2, 4, 5 | workflow:1752-1754 specifies it explicitly for install-fitted and recovery-collected | `FittedBody` (`install.controller.ts:52-56`), recovery body (`recovery.controller.ts:63`), `SubmitBody` (`leave-request.controller.ts:28-34`), `SetAvailabilityBody` (`engineers.controller.ts:70-75`) — none accept it |
| **D4** | **A Warehouse entity** (id + name + address) | Recovery drop-off | PRD:573 "SE returns device to Zone Warehouse"; workflow:1133-1137 assumes `warehouse_id` | `ZoneWarehouseStock` (`schema.prisma:1028`) is `(zone, component, qty)` only |
| **D5** | **SE live position** | Intraday offer (travel judgement) | `TRAVEL_TOO_FAR` decline reason (`intraday-insertion.service.ts:20`) — [INFERRED] the SE needs distance to choose it honestly | GPS captured only at troubleshoot-submit (`schema.prisma:839+`); nothing on `EngineerMaster` (`:154-196`) |
| **D6** | **Install failure discriminator** (no-ping vs window-expired-on-stale-telemetry) | Install | [INFERRED] from workflow:1176's troubleshoot precedent | `failActivation` writes status only (`install-lifecycle.service.ts:245-251`) |
| **D7** | **`se_availability.activity_sourced`** | Availability | workflow:1658 lists it as a column | Absent (`schema.prisma:1164-1179`). Needed so a derived `OFFLINE` (workflow:1348-1351) is never shown as a *set* availability |

**D1 and D2 are the two that will force a mid-build change if left.** D1 because the offer prompt,
the Day Plan card and the Troubleshooting Form all reference expected components and none can serve
them. D2 because offline behaviour is an acceptance criterion on five of these six screens and there
is no server-side dedup for any of their writes.

---

## Three findings that are not data gaps at all

**1. 🔴 An SE can currently self-grant leave.** `SETTABLE_STATUSES` includes `ON_LEAVE`,
`OFF_SHIFT` and `WEEKLY_OFF` (`engineers.controller.ts:68`), and the service authorises an SE for
any of them on themselves (`se-availability.service.ts:62`). Workflow:1338 is explicit — *"SE
**cannot self-approve**. Only ZM (or acting role) can write `ON_LEAVE` or `WEEKLY_OFF`"* — and
workflow:1360-1363 tabulates all three as ZM-only. PRD:496 gives the SE **only** SOFT_UNAVAILABLE.
**The mobile app could bypass the entire Leave Request approval flow (#86) by writing availability
directly.** Spec-vs-code, not a PRD/workflow conflict. → **#162**.

**2. RECOVERY tickets can never reach the SE Day Plan.** `/api/schedules/me` reads
`plantBatchAssignment` → `batchAssignmentTicket` only (`day-plan-query.service.ts:49-60`), and the
recommender selects `TROUBLESHOOT` (`recommender.service.ts:113-115`) and `INSTALL` (`:477-479`) —
**there is no RECOVERY path**. `POST /api/recovery/:id/schedule` only sets `assignedSeId`
(`recovery.service.ts:92-98`) and creates no batch row. Issue #68's premise ("RECOVERY appears in
the Day Plan as a first-class work type") is **not satisfiable by any current endpoint**. This is a
design decision, not a field addition. → **#68**, **#161**.

**3. The Shadow Use path is structurally unreachable over HTTP.** `TroubleshootBody`
(`troubleshoot.controller.ts:32-44`) has no `consumedComponents` field and the controller never
passes one (`:81-96`), so `SubmitTroubleshootInput.consumedComponents`
(`troubleshoot-submission.service.ts:37`) is always empty, `consumed.length > 0` (`:275`) is never
true, and **`shadowUseRecorded` is permanently `false`** — no `SHADOW_USE` row, no van-stock
decrement, ever, through the API. Issue #63's AC#2 cannot be demonstrated end-to-end. This
independently confirms the "armed but unreachable" finding in the freeze plan §1.4, from the
opposite direction. → **#101**, **#63**.

---

## Per-screen specs

### 1. Recovery Collection Form (#68)
*PRD:567-583, workflow:578-597, workflow:1200-1264.*

**Displays:** ticket id · work-type marker `RECOVERY` · lifecycle position · **expected device
serial** · vehicle no · plant name + location · transporter name + phone · device type · condition
notes · unable-to-collect reason enum · **whether an unable-to-collect is already filed, with reason
and timestamp** · recorded collection data after submit · "returned to Zone Warehouse pending
receipt" · closure outcome + `closure_type` · **the ZM's decision after an unable-to-collect** ·
Zone Warehouse identity.

**Actions:** on-site (`recovery.controller.ts:50-55`) · collected `{deviceSerial, conditionNotes}`
(`:57-68`) · unable-to-collect `{reasonCode}` (`:70-76`) — all `@Roles('SERVICE_ENGINEER')`.

**States:** SCHEDULED · ON_SITE · **ON_SITE + unable-filed (invisible today)** · COLLECTED ·
RECEIVED_AT_WAREHOUSE · CLOSED · FAILED_RECOVERY · serial mismatch · empty notes · out-of-order 409 ·
not-the-assigned-SE 403 (after a ZM reschedule) · offline-queued · repeat-submit 409 (**not**
idempotent — no client key).

**Sharpest gap:** the **expected device serial** is category (c). The server compares
`deviceSerial === String(ticket.deviceId)` exactly (`recovery.service.ts:124`), and there is **no
`GET /api/recovery/:id`** — every read on that controller is WM/manager (`:85-111`). The SE types
blind against an exact-match check. Also (b) on `RecoveryView` itself: `unableToCollectAt`
(`schema.prisma:2056`) and `closureReason` (`:2058`) exist but are not in the view
(`recovery.service.ts:26-36`).

### 2. Install Form / activation result (#71)
*PRD:558-565, workflow:555-576, workflow:1186-1198.* **Best-served of the six.**

**Displays:** ticket id · lifecycle · **expected GPS serial (a) ✅** · vehicle no · plant ·
**pre-allocated `installSimId`** · device type · install notes + target date · transporter ·
serial inputs · optional photo · `activatedAt` · **activation-window deadline** · outcome
(CLOSED vs FAILED_ACTIVATION) · recorded serials · next-step guidance on failure.

**Actions:** on-site (`install.controller.ts:190-195`) · fitted `{gpsDeviceSerial, simSerial,
photoRef?}` (`:198-213`, one hop `ON_SITE → FITTED → ACTIVATED`) · poll `GET /api/install/:ticketId`
(`:216-229`, SE in `INSTALL_READER_ROLES`, own-ticket scoped).

**Gaps:** `vehicleNo`, `plantName` (**already joined and discarded** at
`install-lifecycle.service.ts:260-262`), `installSimId` (`schema.prisma:2067`), `deviceType`,
`installNotes`/`installTargetDate` (`:2068-2069`) all (b). **`activationDeadline` is (b) and the
client cannot compute it** — `INSTALL_ACTIVATION_WINDOW_MS` is a server constant
(`install-lifecycle.service.ts:30`) *and* expiry additionally requires the telemetry watermark to
have advanced (`:236-239`), so a ticket can sit in `ACTIVATED` indefinitely with nothing on screen
explaining why. Ship `activationDeadline` **and** a `verificationBlockedByStaleTelemetry` flag.

**Note:** `SERIAL_REQUIRED` fires only for a blank **SIM** serial (`:127`); a blank GPS serial falls
to `INVALID_SERIAL` (`:128`). #71 lists both codes without the mapping — pin it.

### 3. Intra-day Insertion offer (#77)
*PRD:541-547, CONTEXT:232-243, CONTEXT:779-789, workflow:1469-1471.*

**Displays:** **plant name** · ticket no · **SLA bucket** · **`acceptanceDeadline`** · `offeredAt` ·
vehicle no · travel implication · **expected component** · company/tier · decline reasons ·
"Accepted — WhatsApp Confirmation sent" · `CRITICAL INSERTION` badge on the accepted plan ticket ·
**ghost notice with the routed-to SE's name and both timestamps** · escalated-instead-of-rerouted
variant · why the prompt closed.

**Actions:** accept (`intraday-insertion.controller.ts:64-73`, idempotent for the same SE at
`service:143-153`) · decline `{reasonCode}` (`:75-90`).

**Gaps — this screen is the worst-served:** `pushOffer` sends only
`{insertionId, ticketId, actions}` with generic title/body (`intraday-insertion.service.ts:396-407`),
so **the PRD's own push copy "CRITICAL Ticket at [Plant]" is not renderable**. `acceptanceDeadline`
(`schema.prisma:429`) is (b) — **without it there is no countdown**, and the only carrier is
manager-only (`controller:37-38`). 🔴 **The ghost notification interpolates a raw UUID into
user-visible text** — `` `routed to ${nextSeId}` `` (`service:477,:482`) — where PRD:547 requires
"[SE Name]". `_now` is accepted and discarded (`:476`), so neither timestamp is available.
`whatsappSent` exists on the manager row (`:49`) but not in the SE's `AcceptOutcome` (`:53-54`), so
the screen cannot honestly say "sent" per CONTEXT:508.

⚠ **#77:34 is factually wrong** — it claims a `GET /api/intraday-insertions` row is "surfaced to the
offered SE". That route is manager-only. **An SE cannot read any insertion, ever**, including their
own live offer on a cold start.

### 4. Leave Request (#86)
*PRD:604-609, workflow:1323-1339.*

**Displays:** type selector · start/end date · optional reason · **PENDING badge** · **own-requests
list** · **rejection reason** · approved-window confirmation · decision timestamp/actor · validation
errors · which ZM it went to.

**Actions:** submit (`leave-request.controller.ts:47-64`) · resubmit after reject (a **new row** —
`schema.prisma:1183-1184`).

⚠ **#86:29 is wrong** — `GET /api/leave-requests` is manager-only (`controller:66-67`). **An SE
cannot read their own leave requests**, so **#86 AC#2 and AC#3 are unbuildable as written.**
`LeaveRequestRow` (`leave-request.service.ts:27-38`) already carries everything needed; this is
purely a role gate plus a self-scope filter. `decidedAt`/`decidedBy`/`decidedByRole` exist
(`schema.prisma:1194-1196`) but are absent even from the manager row. The submit response returns
only `{result, id}` — it should echo `status` so the PENDING badge renders without a second call.
**No notification is emitted on approve or reject** (workflow:1474 requires one).

**Trust note:** `seId` comes from the request **body**, not the token (`controller:49-50`), though
the service does check `canActFor` (`service:63`).

### 5. Availability / SOFT_UNAVAILABLE (#87)
*PRD:611-615, workflow:1341-1364.*

**Displays:** current status · active window · time to auto-revert · **who set it (self vs ZM)** ·
from/to pickers · optional reason · **consequence copy** ("excluded from intra-day CRITICAL
insertions; morning batch unaffected" — workflow:1363) · "ZM notified" · recent window history.

**Actions:** set availability (`engineers.controller.ts:202-228`; SE-self enforced at
`se-availability.service.ts:62`).

⚠ **#87:29 is wrong** — `GET /api/engineers/:seId` is manager-only (`controller:191-192`). **An SE
cannot read their own availability**, so **#87 AC#2 and AC#3 are unbuildable.** #87:33 also misses
`INVALID_WINDOW_START`, `INVALID_WINDOW_END` and `AVAILABILITY_FORBIDDEN`, and marks `windowStart`
optional when the controller makes it mandatory (`:212-215`).

**Two open behaviours nothing specifies:** an **open-ended window** (`windowEnd: null`) is legal
(`schema.prisma:1169`, matched at `se-availability.service.ts:35`) — an SE can go SOFT_UNAVAILABLE
forever, which PRD:615 does not contemplate. And **there is no way to clear a window early**: the
model is append-only and "set an AVAILABLE window on top" is forbidden by `SETTABLE_STATUSES`. Both
need a decision before the freeze.

Plus the self-grant violation in the headline section above. **No notification to the ZM is emitted**
despite PRD:614.

### 6. 409 Conflict screen (#63)
*PRD:591-595, CONTEXT:171-176, CONTEXT:297-301, CONTEXT:415, workflow:1092-1123.*

**Displays:** **winning SE's name** · winning timestamp · ticket id · whether Shadow Use was logged ·
**which components and quantities** · reconciliation copy · **the closure kind** (another SE vs
auto-recovery) · View Van Stock · Back to Day Plan · for an offline replay, **which queued
submission** was rejected.

**The 409 body** is `{code:'TICKET_ALREADY_CLOSED', status, winnerSeId, winnerAt,
shadowUseRecorded}` (`troubleshoot.controller.ts:102-108`).

**Gaps:** 🔴 **`winnerSeId` is a bare UUID and no SE-callable endpoint resolves it to a name** —
`/api/engineers/:seId` and `/api/engineers` are manager-only, `/api/me` returns only the caller. The
screen's headline field (PRD:593, *"already closed by **[SE Name]**"*) is unbuildable. The component
list is absent, and structurally dead anyway (headline finding 3). **Good news:** the already-present
`status` field is exactly the auto-recovery discriminator — with `CLOSED_AUTO_RECOVERY` there is no
winning SE and the PRD copy would be a lie, so pin `status` in the contract.

---

## Consolidated gaps by owning endpoint

**`GET /api/schedules/me`** → `workType`, `status`, `deviceId`, `vehicleNo`, `slaBucket`,
`companyTier`, transporter name+phone, `criticalInsertion` flag, plant lat/lon. Plus the RECOVERY
design decision (headline 2). *(Now the merged `GET /api/me/tickets` per #172 decision 3.)* → #161/#165

**New `GET /api/recovery/:id` (SE-scoped)** — does not exist → #163

**`GET /api/install/:ticketId`** → `vehicleNo`, `plantName`, `installSimId`, `deviceType`,
`installNotes`, `installTargetDate`, `activationDeadline`, `verificationBlockedByStaleTelemetry`,
transporter → #161

**Intraday offer** — widen `pushOffer` metadata *and* add `GET /api/me/intraday-offers` (cold start);
fix the ghost UUID; add `whatsappSent` to `AcceptOutcome` → #163/#76

**New `GET /api/leave-requests/me`** — role gate only, the row shape exists → #163

**Availability on `GET /api/me`** — `availabilityStatus`, window, `setBy`/`setByRole`, history → #161

**409 body** → `winnerSeName`, `shadowUseComponents[]`, pin `status` → #161/#169

**Six notifications specified but never emitted** (install verified/failed, recovery closure, ZM
post-unable decision, leave decision, SOFT_UNAVAILABLE→ZM) — only cross-zone and intraday inject
`NotificationService`; install and recovery use logging-only ports
(`install-notifier.ts:32-40`, `recovery-notifier.ts`) → #76

---

## Derived values — who computes what

| Value | Server or client | Client has the inputs? |
|---|---|---|
| **Acceptance countdown (10 min)** | Server stores `acceptanceDeadline` (`intraday-insertion.service.ts:517-519`); client renders | **No.** Ship it as an absolute ISO instant — a client-side "10 min from receipt" drifts against `sweepTimeouts` (`:275-288`) and shows a live countdown on a dead offer |
| **Install activation window (24 h)** | Server owns the outcome | **No, and the client must not derive it** — expiry is not pure time; it also needs `telemetryAsOf > activatedAt` (`install-lifecycle.service.ts:236-239`). A client computing `activatedAt + 24h` shows "overdue" while the server correctly holds `ACTIVATED` |
| **SOFT_UNAVAILABLE auto-revert** | Server, by query-time derivation (`se-availability.service.ts:33-39`) — no job, matching #87 AC#3 | Not today (can't read `windowEnd`); once readable, a pure-client render is safe |
| **PARTIAL_RECOVERY 24 h deadline** | Server, on the **manager** row only (`verification-query.service.ts:45-46`) | No — and `/api/tickets/:id/verification` **is** SE-callable, so it is the natural carrier (already #59/#161) |
| **`CRITICAL INSERTION` badge** | Neither today — server orders top-of-plan (`intraday-insertion.service.ts:190`) but publishes no marker | No. Needs a server-side flag |

---

## Spec conflicts flagged, not resolved

1. **Unable-to-collect ticket state** — PRD:579/workflow:1258 both say "enters the ZM decision
   queue"; neither names a status. The code keeps it at `ON_SITE` and flags a column. What should the
   SE's screen say the state is?
2. **Recovery closure notification** — PRD:574 says the SE receives one; the workflow's own event
   table (1481-1482) lists only ZM rows.
3. **SOFT_UNAVAILABLE scope** — PRD:614 says intraday only; workflow:1363 agrees, but workflow:1658
   describes `se_availability` feeding the "Recommender Hard Filter" unqualified. Determines the
   consequence copy.
4. **Who may write ON_LEAVE/WEEKLY_OFF** — PRD and workflow agree (ZM only); **the code disagrees**.
   Spec-vs-code → #162.
5. **`last_activity_at` 15-min filter** — workflow:1353/1364 still assert it; CONTEXT:450/784
   explicitly removed it and the code follows CONTEXT. Resolved by authority, but workflow §20 still
   carries stale text.
6. **Endpoint paths** — workflow:1728-1754 lists `/api/insertions/…`, `/api/tickets/{id}/install-fitted`,
   `/api/me/day-plan`; none match the shipped routes. Freeze the code's paths; workflow §26 needs a
   correction pass.

**One thing no screen specifies:** an **offline read** contract. Every issue says "status reads
render from cache" — but for Leave and Availability there is *no server read to cache*, so that
behaviour is not merely unbuilt, it is undefined.

---

*Read-only derivation. Issue-file "API contract" sections were treated as claims and verified
against code; three (#77:34, #86:29, #87:29) are factually wrong about endpoints being SE-callable.
`[INFERRED]` marks inference throughout.*
