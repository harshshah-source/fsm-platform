# SE Mobile App — Hardcoded Values & Real-Data Path Audit

**Date:** 2026-08-05
**Scope:** `apps/mobile/src` (49 non-test source files), `packages/shared/src/index.ts`,
`apps/backend/src`, `apps/backend/prisma/schema.prisma`.
**Method:** source, schema and controller reading only. No documentation, issue files, or prior
audits were read. Every claim below is tagged **OBSERVED** (with `file:line` or command output) or
**INFERRED**.

**Headline:** the app contains **no mock data**. Nothing renders a fabricated record. But six
screens render a *fabricated state* — a plausible-looking value substituted when the fetch failed,
returned nothing, or returned something the client didn't enumerate — and five endpoints the client
treats as complete lists are silently truncated or unbounded server-side. Details in §4.

---

## 1. Hardcoded value inventory

### 1.1 Bucket A — Mock data rendered in place of an API response

**None. Zero instances.** — OBSERVED.


```
$ grep -rniE "__DEV__|\bmock|\bdummy|\bsample|\bfixture|seedData|placeholderData" \
    apps/mobile/src --include=*.ts --include=*.tsx | grep -v "\.test\."
```
Seven hits, all of them the word "mockup" inside doc comments referring to reference images
(`TilePicker.tsx:18`, `troubleshootDisplay.ts:14`, `LeaveRequestFormScreen.tsx:21`,
`vehicleUnavailabilityDisplay.ts:18`, `VehicleUnavailabilityFormScreen.tsx:31`,
`VoucherFormScreen.tsx:25`, `theme/tokens.ts:4`). No sample arrays, no seeded objects, no
`if (__DEV__)` branches, no fixture imports outside `.test.tsx` files. — OBSERVED.

There is therefore **no dev-gating question to answer**: no mock path exists in either build.

The one component library file that *could* have carried sample data does not —
`components/kit/*` are all pure presentational components taking props
(`StatTile.tsx:22`, `StatusPill.tsx:12`, `TicketCard.tsx:29`, `TilePicker.tsx:22`,
`ProgressBar.tsx:14`, `PhotoCaptureRow.tsx:21`, `IconSelectGrid.tsx:21`). — OBSERVED.

### 1.2 Bucket B — Fallback defaults on failure or empty response

Ordered by how misleading the rendered result is.

| # | Site | Substituted value | What the user sees | Distinguishable from real data? |
|---|---|---|---|---|
| B1 | `navigation/screens/AvailabilityScreen.tsx:122` + `:45-47` + `:55` | `active?.status ?? 'AVAILABLE'` | Big status card reading **"Available"** plus an active **"Go Unavailable"** button | **No.** Identical to a genuinely-available SE. A one-line `availability-offline` note sits above it (`:108-112`), but the card itself asserts a status the server never sent. |
| B2 | `navigation/screens/StockScreen.tsx:25` + `:78` | `kitComplete: true`; `status:'loading'` falls through the `error` ternary into the ready render | **"0 AVAILABLE / 0 LOW STOCK / 0 HEALTHY"** + a green **"Kit Complete"** pill + "No component requests." | **No.** Byte-identical to a successfully-loaded empty response. There is no loading state on this screen at all. |
| B3 | `navigation/screens/LeaveRequestScreen.tsx:42-44` + `:87-91` | `items` stays `[]` on catch | **"No leave requests yet."** | Partially — an offline line renders at `:75-79`, but the list asserts emptiness. |
| B4 | `tickets/verification/VerificationScreen.tsx:58` | `BADGE_COPY[badge] ?? { title: 'Verification pending', subtitle: '' }` | Headline **"Verification pending"** for any outcome not in the 4-entry map | **No.** See §1.3 D7 — `FAILED_ACTIVATION` is a real `VerifyOutcome` that lands here. |
| B5 | `tickets/detail/TicketDetailScreen.tsx:386` | `state.verification.badge ?? 'PENDING'` | The literal text `PENDING` | Yes — `null` badge genuinely means pending. |
| B6 | `navigation/screens/HomeScreen.tsx:77-78` | `session?.profile?.name ?? ''`, `?.zoneName ?? ''` | Blank header where the SE's name and zone belong | Yes (visibly blank). Reachable: `/api/me` omits `profile` entirely for an SE with no `EngineerMaster` row — `me.controller.ts:30-32`, `me-profile.service.ts:17-25`. |
| B7 | `navigation/screens/HomeScreen.tsx:144` | `max={stopRows.length \|\| 1}` | An empty progress bar reading **"0 / 0"** for a plant stop | Marginal — looks like a not-started stop. Reachable, see §3.5. |
| B8 | `navigation/screens/TicketsScreen.tsx:36`, `tickets/detail/TicketDetailScreen.tsx:298` | `row.vehicleNo ?? row.ticketNoDisplay` | `TCK-00042` in the vehicle-registration slot | Yes — the `TCK-` prefix is unmistakable. Contract-sanctioned (`packages/shared/src/index.ts:94-96`). |
| B9 | `navigation/screens/TicketsScreen.tsx:42` | `row.topHint?.label ?? ''` | Blank issue-description line on the ticket card | Yes (blank). |
| B10 | `navigation/screens/StockScreen.tsx:115` | `req.componentName ?? 'Component'` | The generic word **"Component"** | **No.** Reachable — `ComponentRequestRow.componentName` is nullable (`packages/shared/src/index.ts:488`). |
| B11 | `navigation/screens/VouchersScreen.tsx:99` | `categories \|\| '—'` | An em-dash | Yes. |
| B12 | `navigation/screens/AvailabilityScreen.tsx:91` | `active.windowEnd ?? new Date().toISOString()` | Nothing visible — it is *sent to the server* as the clear-window end | Not user-visible; a write, not a render. |
| B13 | `api/client.ts:96` | `EXPO_PUBLIC_API_URL ?? 'http://10.0.2.2:3000/api/v1'` | On a physical handset with no `.env`, every request fails | Yes — total failure, not a plausible screen. Documented at `apps/mobile/.env.example` Route C. |
| B14 | `api/client.ts:98` | `Constants.expoConfig?.version ?? '0.0.0'` | Sent as `X-App-Version` | Not user-visible. |
| B15 | `api/connectivity.ts:11-16` | `isInternetReachable === null` → treated as `'online'` | Optimistic; a real failure is caught by the screen's own `catch` | Yes, by design. |
| B16 | `navigation/screens/TicketsScreen.tsx:74`, `:86` + `:113` | `s.items.length ? 'ready' : 'offline-no-cache'` | Banner **"Offline — showing the last cached list"** rendered *simultaneously* with **"No cached tickets yet"** (`:135`) | Self-contradictory. There is no cache: `items` is component state and the effect runs once on mount (`:69-92`), so `s.items.length` is always `0` on the offline path. The "last cached list" claim is never true. — INFERRED from the state machine; OBSERVED at the cited lines. |
| B17 | `navigation/screens/VouchersScreen.tsx:64-66` + `:69` | `status:'offline'` with `view === null` | The offline line renders; the tiles and list render nothing | Yes (screen is visibly bare). |

### 1.3 Bucket C — Duplicated vocabulary

**The good news first.** `packages/shared/src/index.ts` is a genuine shared contract, and the
backend imports it rather than re-declaring: 27 backend files import `@fsm/shared` (OBSERVED,
`grep -rn "@fsm/shared" apps/backend/src | wc -l` → 27), including the two lists that matter most —
`ROOT_CAUSE_CATEGORIES` is imported *and used as the validator* at
`apps/backend/src/ticketing/troubleshoot.controller.ts:11,50`, and `MEDIA_SLOTS_BY_KIND` is imported
*and used as the slot validator* at `apps/backend/src/media/media.controller.ts:18,63-64`. Every
`TilePicker` in the mobile app is fed from these shared constants
(`TroubleshootFormScreen.tsx:5,14`, `VoucherFormScreen.tsx:6,14`,
`UnableToCollectScreen.tsx:3,10`, `VehicleUnavailabilityFormScreen.tsx:3,12`,
`IntradayOfferScreen.tsx:4,11`, `LeaveRequestFormScreen.tsx:3,11`). **Those six pickers cannot
drift** — they are one array, imported twice. — OBSERVED.

What follows is what is *not* covered by that arrangement.

---

**C1 — `home/homeKpi.ts:10-11` — ticket-status sets, client-local, no shared constant.**

```ts
const COMPLETED_STATUSES = new Set(['CLOSED', 'CLOSED_AUTO_RECOVERY']);
const FAILED_STATUSES = new Set(['FAILED_VERIFICATION', 'FAILED_ACTIVATION', 'ESCALATED']);
```

Diff against `TicketStatus` (`prisma/schema.prisma:1692-1712`, 17 values: `OPEN, SUBMITTED,
VERIFICATION_PENDING, CLOSED, CLOSED_AUTO_RECOVERY, FAILED_VERIFICATION, ESCALATED,
CLOSED_NON_OPERATIONAL, REQUESTED, SCHEDULED, ON_SITE, FITTED, ACTIVATED, FAILED_ACTIVATION,
COLLECTED, RECEIVED_AT_WAREHOUSE, FAILED_RECOVERY`):

- Values the client has that the schema doesn't: **none**.
- Values the schema has that the client's FAILED tile doesn't: **`FAILED_RECOVERY`**. A recovery
  ticket that failed is a real terminal failure state and never increments the FAILED tile. —
  OBSERVED (`schema.prisma:1709` vs `homeKpi.ts:11`).
- `CLOSED_NON_OPERATIONAL` is excluded from COMPLETED deliberately and the reasoning is written down
  (`homeKpi.ts:19-20`).
- **Unknown value behaviour:** silently ignored — a status not in either set increments nothing. The
  four tiles under-count rather than error. — INFERRED from `homeKpi.ts:34-40`.

`HomeScreen.tsx:140` carries a **third, inline copy** of the same "done" list
(`t.status === 'CLOSED' || t.status === 'CLOSED_AUTO_RECOVERY'`) for the Plant Workload bars. Three
copies of one concept, none of them shared with the backend. — OBSERVED.

**C2 — `tickets/ticketDisplay.ts:10-25` — SLA bucket → colour.** All 8 values present and exactly
matching `SlaBucket` (`schema.prisma:1590-1601`) and `packages/shared/src/index.ts:151-159`. No
drift. Unknown value → `'neutral'` (`:22-24`) and `formatSlaBucketLabel` title-cases whatever string
arrives (`:29-38`), so an added bucket renders as a grey pill with a readable label. **This is the
correct failure mode and the only place in the client that gets it right.** — OBSERVED.

**C3 — `tickets/ticketDisplay.ts:40-45`, `navigation/screens/TicketsScreen.tsx:24-30`,
`vouchers/voucherDisplay.ts:12-30`, `leave/leaveDisplay.ts:15-24`.** All are `Record<Union, …>`
typed against the shared unions and are total against them. No drift today. Unknown value at
runtime → `undefined` label, i.e. an empty `StatusPill` (a coloured chip with no text) for vouchers
and work-state. — OBSERVED / INFERRED.

**C4 — `tickets/troubleshoot/troubleshootDisplay.ts:18-29` — `ACTION_TAKEN_OPTIONS`.** The one
genuinely client-invented vocabulary:

```
'Power','Battery','SIM','Wire','Antenna','Restart','Device','Config','No Fault','Escalate'
```

Backend side: `actionTakenCategory` is passed through unvalidated
(`troubleshoot.controller.ts:61`) into `actionTakenCategory?: string | null`
(`troubleshoot-submission.service.ts:32`) and stored verbatim (`:146`). There is **no enum, no
validator, and no Prisma type** for this field — confirmed by grep: `ACTION_TAKEN_OPTIONS` appears
in exactly two files, both mobile. — OBSERVED.

Drift is not currently possible (nothing to drift against), but the analytic consequence is real:
these ten display strings are the *de facto* production vocabulary for a persisted analytics column,
and they are Title Case free text, not `SCREAMING_SNAKE` codes like every sibling field.

**C5 — `stock/vanStockDisplay.ts:7` — `'LOW' | 'OK'`.** Client-invented, and correctly so: there is
no status/threshold column on `VanStockItem`, and the derivation cross-references the server's own
`commonKit.missing` rather than guessing a threshold (`vanStockDisplay.ts:18-33`; contract note at
`packages/shared/src/index.ts:451-453`). Not drift. **But** the raw string `'LOW'`/`'OK'` is rendered
as the pill label to the SE (`StockScreen.tsx:100`). — OBSERVED.

**C6 — `navigation/screens/StockScreen.tsx:116` — raw enum as label.**
`<StatusPill label={req.status} …>` renders `REQUESTED` / `APPROVED` / `SHIPPED` / `RECEIVED` /
`REJECTED` verbatim, in caps, at a field engineer. Every other status surface in the app runs
through a formatter (`voucherStatusLabel`, `formatRecoveryStatusLabel`, `leaveStatusLabel`,
`formatInstallStatusLabel`). This one doesn't. Semantic colour is also binary — `REJECTED` is red,
everything else including `RECEIVED` is blue `info` (`:116`). — OBSERVED.

**C7 — `tickets/verification/VerificationScreen.tsx:25-30` — `BADGE_COPY`. Real drift.**

| `VerifyOutcome` (`schema.prisma:1106-1114`, `shared:274`) | In `BADGE_COPY`? |
|---|---|
| `CLOSED` | yes (`:27`) |
| `CLOSED_AUTO_RECOVERY` | yes (`:28`) |
| `FAILED_VERIFICATION` | yes (`:29`) |
| `PARTIAL_RECOVERY` | yes (`:26`) |
| **`FAILED_ACTIVATION`** | **no** |

When the backend sends `badge: 'FAILED_ACTIVATION'` — a failed GPS install activation, a real
terminal outcome the schema defines and `MeTicketDetailView` already renders elsewhere
(`TicketDetailScreen.tsx:344-348`) — the Verification screen renders the headline **"Verification
pending"** with an empty subtitle (`VerificationScreen.tsx:58`), directly above a blue pill reading
`FAILED_ACTIVATION` (`:78` — the `critical` branch is keyed on `FAILED_VERIFICATION` only). The
screen tells the SE to keep waiting on a run that has already terminally failed. — OBSERVED, both
sides cited.

**C8 — `tickets/verification/VerificationScreen.tsx:108-113` — "POSSIBLE OUTCOMES" legend.** Four
hardcoded pills: `Closed / Failed / Partial / Escalated`. Static copy, not derived from
`VerifyOutcome` (5 values) and not reflecting the actual run. `Escalated` is not a `VerifyOutcome` at
all — it is a `TicketStatus` (`schema.prisma:1699`) — and `CLOSED_AUTO_RECOVERY` is missing from the
legend. Legend ≠ enum in both directions. — OBSERVED.

**C9 — `tickets/detail/TicketDetailScreen.tsx` — incomplete status branching.** The INSTALL card
(`:315-349`) branches on `SCHEDULED`, `ON_SITE`, `ACTIVATED`, `CLOSED`, `FAILED_ACTIVATION` — it does
**not** handle `FITTED` (`schema.prisma:1704`). The RECOVERY card (`:350-381`) branches on
`SCHEDULED` and `ON_SITE` only — it does **not** handle `COLLECTED`, `RECEIVED_AT_WAREHOUSE`, or
`FAILED_RECOVERY` (`schema.prisma:1707-1709`). In every unhandled case the card renders its title
line and nothing else: e.g. **"Recovery — Collected"** with no body, no action, no next step. Not
wrong, but empty. — OBSERVED.

**C10 — Correct, verified-matching literals** (listed so they are not re-investigated):
`TicketDetailScreen.tsx:37` `PAST_ON_SITE = {ON_SITE, TROUBLESHOOT_STARTED}` ⊂ `SoftStateType`
(`schema.prisma:846-852`); `IntradayOfferScreen.tsx:54,71` error codes `INSERTION_NOT_PENDING` /
`NOT_OFFERED_TO_YOU` match `intraday-insertion.controller.ts:70-71,87-88` exactly;
`SeTabShell.tsx:50` `'INTRADAY_GHOST_ASSIGNMENT'`; `NotificationsScreen.tsx:57` `'ticket'`;
`AppEntry.tsx:27` and `AvailabilityScreen.tsx:128` `'SERVICE_ENGINEER'` ∈ `ROLES` (`shared:8-14`,
`schema.prisma:18-26`); `VerificationScreen.tsx:68` `'ESCALATED'` ∈ `TicketStatus`. — OBSERVED.

**C11 — Server data the client discards.** `MeVoucherItemView.limit` and `.overLimit` are computed
server-side from `CATEGORY_LIMITS` (`vouchers.service.ts:15-22`, applied at
`me-vouchers.service.ts:107,117`) and shipped on every voucher item. `VouchersScreen`/`VoucherRow`
render neither (`VouchersScreen.tsx:94-105`). An SE who claims ₹8,000 of `MEAL` against a ₹500 limit
sees a perfectly normal row. Similarly `MeTicketDetailView.failureCycleHistory`,
`expectedComponents`, `componentRequestStatus`, `waitingComponentSince`, `readinessHint`, and
`technicalHealth.rawTelemetry` are all populated by `me-ticket-detail.service.ts:62-99` and **none**
are rendered by `TicketDetailScreen.tsx` (only `technicalHealth.hints`, `:456-467`). — OBSERVED.

### 1.4 Bucket D — Legitimate constants

Named once as a group, no further comment:

- **Design tokens** — `theme/tokens.ts` (colour ramp, `radius`, `spacing`, `typeScale`,
  `semanticColors`). Every component routes through it; no component hardcodes a hex.
- **Layout numerals** — pixel widths/heights inside `StyleSheet.create` blocks in all 21 screens and
  7 kit components.
- **UI copy** — every user-facing string ("Ready to start", "Start only when field work begins.",
  "No cached tickets yet…", "Routed to the Zone Manager", the conflict headline at
  `ConflictScreen.tsx:24-27`, etc.).
- **`testID` values and input placeholders** — including the ISO/date examples at
  `AvailabilityScreen.tsx:157,165` and `LeaveRequestFormScreen.tsx:81,90`.
- **Keychain identifiers** — `auth/tokenStore.ts:6-7`, `device/deviceId.ts:8-9`.
- **Timezone / formatting** — `leave/leaveDisplay.ts:32` `IST_OFFSET_MS`;
  `troubleshoot/troubleshootDisplay.ts:3` `ACRONYMS = {GPS, SIM}`.
- **Relative-time presets** — `vehicleUnavailabilityDisplay.ts:19-24` `EXPECTED_FROM_OPTIONS`
  (2h / 4h / tomorrow 9AM / tomorrow 2PM). Client-invented but a UX affordance, not a domain enum;
  the value posted is a computed absolute ISO instant (`VehicleUnavailabilityFormScreen.tsx:70`).
- **Config** — `api/client.ts:96,98` (also listed as B13/B14 for their failure behaviour).

---

## 2. Per-screen data path — all 21 screens

Legend: **✅ server-driven** = every rendered value came from a response; **⚠️** = renders something
the server did not send; **🔴** = renders something plausible while the server returned nothing, an
error, or an unhandled shape.

| # | Screen | Endpoint(s) | Shape match | Renders non-server data? |
|---|---|---|---|---|
| 1 | `LoginScreen` | `POST /auth/login` (`client.ts:113`) | ✅ `LoginResponse` | ✅ none |
| 2 | `SessionScreen` (non-SE fallback) | `GET /me` via `AuthProvider` | ✅ `SessionView` | ⚠️ `Zone ${session.zone_id}` renders a raw numeric FK as a label (`SessionScreen.tsx:10`); no zone-name lookup |
| 3 | `HomeScreen` | `GET /schedules/me`, `GET /me/tickets`, `GET /notifications?unread=true` (`:48-52`) | ✅ all three | ⚠️ 4 KPI tiles are **client-computed** (`homeKpi.ts`, see C1); Plant Workload bars are a **client-side join** of two endpoints (§3.5); "Synced"/"Offline" is pure client telemetry (`:89-95`) |
| 4 | `TicketsScreen` | `GET /me/tickets` (`:80`) | ✅ `MeTicketsView` | 🔴 `transporterName` slot is fed `row.companyName` (`:41`) — see §2.1; section subtitle asserts an ordering the server doesn't provide (§3.2); "Newly Added"/"Removed" badges are client-diffed (`dayPlanCues.ts`) |
| 5 | `StockScreen` | `GET /me/van-stock`, `GET /me/component-requests`, `POST /component-requests/:id/confirm-receipt` (`:39,61`) | ✅ `VanStockView`, `MeComponentRequestsView` | 🔴 no loading state → renders "Kit Complete / 0 / 0 / 0" before any response (B2); LOW/OK derived client-side (C5); raw enum labels (C6) |
| 6 | `VouchersScreen` | `GET /me/vouchers` (`:30`) | ✅ `MeVouchersView` | ⚠️ discards server-computed `overLimit` (C11); server caps items at 50 while the summary tiles count all (§3.4) |
| 7 | `ProfileScreen` | none (uses `session` from context) | ✅ | ✅ none — two static nav links |
| 8 | `TicketDetailScreen` | `GET /me/tickets/:id`, `GET /tickets/:id/verification`, `POST /tickets/:id/soft-state`, `POST /recovery/:id/on-site`, `POST /install/:id/on-site` (`:74-76,109,127,144,156`) | ✅ `MeTicketDetailView`, `VerificationView` | ⚠️ six server fields fetched and never rendered (C11); unhandled statuses render title-only cards (C9) |
| 9 | `VerificationScreen` | `GET /tickets/:id/verification` (`:46`) | ✅ `VerificationView` | 🔴 `FAILED_ACTIVATION` → "Verification pending" (C7); static outcome legend (C8); on fetch failure the screen holds its blank loading state forever (`:48-51`, no error UI) |
| 10 | `TroubleshootFormScreen` | `POST /tickets/:id/troubleshoot` (`:55`) | ✅ `TroubleshootSubmitRequest` | ⚠️ `ACTION_TAKEN_OPTIONS` is client-invented (C4). **Also:** a non-409 submit failure is swallowed entirely (`:65-71` catches only `TroubleshootConflictError`) — the button un-disables with no error shown and no navigation, i.e. a failed submit is indistinguishable from an unpressed button |
| 11 | `ConflictScreen` | none (renders a 409 body) | ✅ `TroubleshootConflictBody` | ✅ none — correctly avoids "closed by null" (`:24-27`) |
| 12 | `VehicleUnavailabilityFormScreen` | `POST /vehicle-unavailability` (`:63`) | ✅; route confirmed SE-allowed at `vehicle-unavailability.controller.ts:54,59-60` | ⚠️ `EXPECTED_FROM_OPTIONS` presets (Bucket D); transporter fields prefilled from Ticket Detail then editable — by design (`:16-18`) |
| 13 | `CollectionFormScreen` | `POST /recovery/:id/collected` (`:36`) | ✅ | ✅ none. "Expected device serial" hint is `detail.deviceId`, and the server compares against exactly that: `input.deviceSerial?.trim() !== String(ticket.deviceId)` (`recovery.service.ts:124`). Correct. |
| 14 | `UnableToCollectScreen` | `POST /recovery/:id/unable-to-collect` (`:40`) | ✅ | ✅ none |
| 15 | `InstallFormScreen` | `POST /install/:id/fitted`, `POST /media/upload` (`:68,48`) | ✅ | ✅ none. Serial hint matches `install-lifecycle.service.ts:128`. |
| 16 | `VoucherFormScreen` | `POST /vouchers`, `POST /media/upload` (`:80,60`) | ✅ | ✅ none |
| 17 | `NotificationsScreen` | `GET /notifications`, `POST /notifications/:id/read`, `POST /notifications/read-all` (`:37,52,67`) | ✅ `NotificationList` | ⚠️ renders a server-capped 50 as complete (§3.3); on error renders header + filter chips and **no list and no message** (`:114-129` — the `error` branch has no UI) |
| 18 | `IntradayOfferScreen` | `GET /me/tickets/:id`, `POST /intraday-insertions/:id/{accept,decline}` (`:38,51,68`) | ✅ | ⚠️ if the detail fetch fails it degrades honestly to `Ticket {offer.ticketId}` (`:124`) — a raw UUID at a field engineer, but not a fabrication |
| 19 | `LeaveRequestScreen` | `GET /me/leave-requests` (`:39`) | ✅ `MyLeaveRequestsView` | 🔴 fetch failure → "No leave requests yet." (B3) |
| 20 | `LeaveRequestFormScreen` | `POST /leave-requests` (`:43`) | ✅ | ✅ none |
| 21 | `AvailabilityScreen` | `GET /me/availability`, `POST /engineers/:seId/availability` (`:42,65,88`) | ✅ `MyAvailabilityView`; route confirmed SE-allowed at `engineers.controller.ts:205-206` | 🔴 fetch failure → **"Available"** (B1); active window derived client-side from a server-truncated page (§3.3) |

### 2.1 `TicketsScreen` — the transporter mislabel

```ts
// navigation/screens/TicketsScreen.tsx:32-45
function toCardData(row: MeTicketRow) {
  return {
    …
    transporterName: row.companyName,   // :41
```

`TicketCard` renders that value in the slot styled `styles.transporter`, top-right of the card
(`components/kit/TicketCard.tsx:35`).

Both sides:

- **Client:** `MeTicketRow` has no transporter field at all — `companyName` and `companyTier` only
  (`packages/shared/src/index.ts:89-90`).
- **Backend:** `companyName` is populated from `t.company.name`
  (`me-tickets-query.service.ts:121`), where `Company` is the customer. `Transporter` is a separate
  model with its own `name` (`schema.prisma:1883-1886`), reached via `Vehicle.transporterId`
  (`:1859,1870`), and the backend *does* resolve it — but only on the **detail** payload:
  `transporterName: ticket.vehicle?.transporter?.name ?? null`
  (`me-ticket-detail.service.ts:84`).

So the Tickets list labels the **customer company** as the **transporter**, while the Ticket Detail
for the same ticket shows the actual transporter (`TicketDetailScreen.tsx:431-446`). Two screens,
one ticket, two different names under the same concept. On the dev database with one seeded company
this is invisible. — OBSERVED, both sides cited.

---

## 3. Assumptions that only break on real data

> Dev: 1 engineer, 0 rows. Production: ~19k devices, 76 engineers.

### 3.1 `GET /me/tickets` is completely unbounded — 🔴 the largest finding

```ts
// apps/backend/src/me-tickets/me-tickets-query.service.ts:73-96
const tickets = await this.prisma.ticket.findMany({
  where: { OR: [
    { ticketId: { in: [...assignedTicketIds] } },
    { plantId: { in: coveredPlantIds }, status: 'OPEN', assignmentState: 'UNASSIGNED', … },
    …
  ]},
  orderBy: [{ plantId: 'asc' }, { createdAt: 'asc' }],
  …
});
…
return { items, cursor: null };            // :136
```

- **No `take:`.** — OBSERVED (`:73-96`).
- **No limit passed by the controller** — `list()` calls `getMyTickets(user.user_id)` with no
  options (`me-tickets.controller.ts:33-35`). — OBSERVED.
- `cursor` is hardcoded `null` in both the service (`:136`) and the type
  (`packages/shared/src/index.ts:143`). There is no pagination to opt into.
- The second `OR` arm is **every OPEN + UNASSIGNED ticket at every covered plant**. Coverage for a
  `FLOATING` SE is the whole `plant_eligible_floating_se` territory
  (`se-coverage.service.ts:20-22`). — OBSERVED.
- **N+1 amplification:** `topHintsByDevice` issues one `findFirst` against `raw_device_snapshots`
  **per distinct device** in the result set (`me-tickets-query.service.ts:143-158`). 400 tickets =
  400 additional round trips inside one HTTP request.
- **Client side:** `TicketsScreen` renders the whole array with `.map()` inside a plain `ScrollView`
  — no `FlatList`, no virtualisation, no windowing (`TicketsScreen.tsx:138-185`). Every row mounts a
  `TicketCard` with three `StatusPill`s. — OBSERVED.

`HomeScreen` pulls the same unbounded payload on app open (`:48-52`) purely to compute four integers
and a pool count.

### 3.2 Ordering is assumed, not requested — ⚠️

The client's own copy:

```tsx
// navigation/screens/TicketsScreen.tsx:140-141
<Text style={styles.sectionTitle}>Visit Now</Text>
<Text style={styles.sectionSubtitle}>Most urgent tickets across all plants</Text>
```

The server's actual ordering: `orderBy: [{ plantId: 'asc' }, { createdAt: 'asc' }]`
(`me-tickets-query.service.ts:89`). Not SLA, not tier, not severity — **plant FK, then age
ascending (oldest last within a plant is not even guaranteed to correlate with SLA, since
`slaBucket` comes from `DeviceState`, a different table: `:93,123`).**

Worse, "Visit Now" does not mean urgency:

```ts
// me-tickets-query.service.ts:13-17
function workStateFor(status, assigned, inWork) {
  if (status === 'VERIFICATION_PENDING') return 'VERIFY';
  if (inWork) return 'IN_WORK';
  return assigned ? 'PLAN' : 'VISIT_NOW';     // :16
}
```

`VISIT_NOW` is simply **"not assigned to you"** — the shared pool. The client renders that section
first, with a red `critical` pill on every row (`TicketsScreen.tsx:44`), under a heading claiming
these are the most urgent tickets. On production, an SE's first screen is the entire unassigned pool
for their whole coverage territory, sorted by plant id, flagged red. The SE's *own dispatched day
plan* is below it in "Other Tickets — Planned, in-work, and verification tickets"
(`:163-164`). — OBSERVED, both sides.

### 3.3 Availability: 10-row server page vs. unbounded window set — 🔴

```ts
// apps/backend/src/engineers/se-availability.service.ts:55-60   (listWindows)
async listWindows(seId: string, limit = 10): Promise<AvailabilityRow[]> {
  const rows = await this.prisma.seAvailability.findMany({
    where: { seId },
    orderBy: { windowStart: 'desc' },
    take: limit,
  });
```

The client then derives "which window is active right now" by scanning **only those 10**:

```ts
// apps/mobile/src/availability/availabilityDisplay.ts:15-24
export function currentAvailabilityRow(items, now = new Date()) {
  return items.find((r) => start <= nowMs && (end === null || end > nowMs)) ?? null;
}
```

The server's *own* answer to the same question is a direct, unpaged query:

```ts
// se-availability.service.ts:43-49   (currentStatus)
const row = await this.prisma.seAvailability.findFirst({
  where: { seId, windowStart: { lte: now }, OR: [{ windowEnd: null }, { windowEnd: { gt: now } }] },
  orderBy: { windowStart: 'desc' },
});
return row?.status ?? 'AVAILABLE';
```

Because `listWindows` sorts by `windowStart` **descending**, future-dated windows sort *first*. An SE
with ten or more future rows — a manager pre-scheduling weekly-offs, a rota loaded a quarter ahead —
pushes the *currently active* window off the end of the page. The client then finds nothing, falls
through `active?.status ?? 'AVAILABLE'` (`AvailabilityScreen.tsx:122`), renders **"Available"**, and
offers a **"Go Unavailable"** button — while the recommender and dispatcher, reading
`currentStatus`, correctly treat the SE as `ON_LEAVE`. With 76 engineers and a real rota this is not
an edge case. — OBSERVED, both sides cited. Unreachable on a dev DB with zero availability rows.

### 3.4 Lists the backend caps that the client renders as complete

| Endpoint | Server cap | Client behaviour |
|---|---|---|
| `GET /notifications` | `take: Math.min(Math.max(limit ?? 50, 1), 200)` → **50** (`notification.service.ts:91,94`) | `client.ts:448-456` sends no limit. `NotificationsScreen.tsx:114-129` renders all returned items with no "more" affordance. **`unreadCount` is a separate uncapped `count()`** (`notification.service.ts:95`) — so the Home badge can read `137` (`HomeScreen.tsx:86`) above a list showing 50. — OBSERVED |
| `GET /me/vouchers` | `take: 50` (`me-vouchers.service.ts:6,69,74`) | `VouchersScreen.tsx:77-87` renders the 50 as the complete history. **The summary tiles are computed over the full set** — a second uncapped query (`:77`) reduced at `:122-130`. So `CLAIMED` can exceed the sum of every visible row. — OBSERVED |
| `GET /me/leave-requests` | `take: 200` (`leave-request.service.ts:147,151`) | Rendered as complete (`LeaveRequestScreen.tsx:82-92`). Unlikely to bite. |
| `GET /me/availability` | `take: 10` (`se-availability.service.ts:59`) | See §3.3 — this one is load-bearing, not cosmetic. |
| `GET /me/tickets` | **none** (§3.1) | Rendered unvirtualised. |
| `GET /me/component-requests` | **none** (`component-request.service.ts:130-135` — `findMany` with `orderBy` and no `take`) | `StockScreen.tsx:112-131` renders all in a `ScrollView`. |

### 3.5 Two endpoints resolve different schedules — ⚠️

`GET /schedules/me` filters the schedule by date:

```ts
// day-plan-query.service.ts:37
where: { seId, dateFrom: { lte: today }, dateTo: { gte: today }, ...liveScheduleFilter() },
```

`GET /me/tickets` does **not**:

```ts
// me-tickets-query.service.ts:41-44
const schedule = await this.prisma.workSchedule.findFirst({
  where: { seId, ...liveScheduleFilter() },
  orderBy: { dispatchedAt: 'desc' },
});
```

`liveScheduleFilter()` is a status filter only — `{ status: { in: ['ACTIVE','OVERRIDDEN'] } }`
(`schedule-status.ts:29-31`). No date predicate. — OBSERVED, both sides.

Consequence on a day with no dispatch: `/schedules/me` correctly returns
`{ dispatched: false, stops: [] }` (`day-plan-query.service.ts:9,40`) and Home shows "Your plan is
being prepared" (`HomeScreen.tsx:99-102`), while `/me/tickets` picks up **yesterday's** still-live
schedule and marks yesterday's tickets `assigned: true` (`me-tickets-query.service.ts:107`). The
Tickets tab and the Home KPI tiles then present stale work as today's. The comment at
`day-plan-query.service.ts:34-36` records that this exact bug was fixed there; the fix was not
applied to `me-tickets-query`. — OBSERVED / INFERRED (the consequence).

The same divergence drives **B7**: `HomeScreen.tsx:137-147` intersects `dayPlan.stops[].tickets`
against `state.tickets` by id. When the two endpoints resolve different schedules, the intersection
is empty and every Plant Workload card renders **"0 / 0"** with a full-width empty bar.

### 3.6 ID formats — parsed, not assumed ✅

- `Device.deviceId` is `String @id` (`schema.prisma:1793`) — it *is* the serial. The client treats it
  as an opaque string throughout (`TicketsScreen.tsx:38`, `TicketDetailScreen.tsx:303`,
  `VerificationScreen.tsx:99`, `CollectionFormScreen.tsx:51`, `InstallFormScreen.tsx:87`). No
  parsing, no format assumption. Correct.
- `ticketId` is validated as a UUID **server-side** before any lookup
  (`me-ticket-detail.service.ts:11,46`). The client never parses it.
- `notificationId` must be all-digits (`notifications.controller.ts:36`); the client passes
  `item.id`, which is `String(n.id)` of a bigint (`notification.service.ts:99`). Consistent.
- `seId` is always `session.user_id` (`ProfileScreen.tsx:21`, `LeaveRequestFormScreen.tsx:44`,
  `VehicleUnavailabilityFormScreen.tsx:65`), and the server 403s anything else
  (`packages/shared/src/index.ts:696-697,909-910`).

**No ID format is assumed anywhere in the client.** — OBSERVED.

### 3.7 Hardcoded zone or plant references — none ✅

Grep found no plant id, zone id, plant name, or zone name literal in `apps/mobile/src`. Zone comes
from `session.profile.zoneName` (`HomeScreen.tsx:78`), plants from `dayPlan.stops[].plantName`
(`:143`) and `detail.plantName` (`TicketDetailScreen.tsx:429`). The single exception is
`SessionScreen.tsx:10`, `Zone ${session.zone_id}` — a raw FK rendered as a label, on the non-SE
fallback screen only. — OBSERVED.

### 3.8 Offline writes are not queued — ⚠️

`api/writeQueue.ts` implements a `WriteQueue` with PENDING/SYNCED/FAILED and replay-on-reconnect
(`:19-63`), and `api/connectivity.ts:33-52` exposes a matching `createConnectivitySource()`.
**Neither is imported by any screen.** — OBSERVED:

```
$ grep -rn "WriteQueue|createConnectivitySource" apps/mobile/src --include=*.tsx --include=*.ts | grep -v "\.test\."
apps/mobile/src/api/connectivity.ts:28   (comment)
apps/mobile/src/api/writeQueue.ts:19     (definition)
apps/mobile/src/components/kit/PhotoCaptureRow.tsx:8   (comment)
```

Only `getConnectivityState()` is used, and only for two read-path banners
(`HomeScreen.tsx:40`, `TicketsScreen.tsx:72`). Every form — troubleshoot, voucher, install,
collection, leave, availability, vehicle-unavailability — posts directly and surfaces a raw error
code string on failure (`SUBMIT_FAILED`, `PHOTO_UPLOAD_FAILED`, or the server's own code). A repair
submitted in a basement is lost, not queued.

### 3.9 Client-side session state that grows unbounded — ⚠️

`tickets/dayPlanCues.ts:3-4` holds two **module-level mutable singletons**. `removedRowsThisSession`
only ever grows (`:35`) and every accumulated row is rendered as an additional non-tappable
`TicketCard` badged "Removed" in *both* sections on *every* subsequent render
(`TicketsScreen.tsx:148-150,171-173`). Over a long-lived session with an active ZM doing overrides,
the Tickets list accumulates ghost cards that never clear until a cold app start (`:16-18`).

### 3.10 Expired intraday offers gate the whole app — ⚠️

`getMyPendingOffers` filters on status only, not on the deadline:

```ts
// intraday-insertion.service.ts:353-356
where: { offeredSeId: seId, status: 'PENDING_ACCEPTANCE' },
orderBy: { offeredAt: 'desc' },
```

`SeTabShell` takes `offers.items[0]` and renders `IntradayOfferScreen` **instead of the entire tab
navigator** (`SeTabShell.tsx:49,85-87`). Between deadline expiry and the timeout sweep
(`intraday-insertion.service.ts:277`), an SE opening the app is blocked on a dead offer whose
`formatAcceptByLabel` shows a time already past (`intradayDisplay.ts:14-19`). Recoverable — Accept
409s and the screen flips to "no longer available" (`IntradayOfferScreen.tsx:54-56,79-88`) — but the
SE cannot reach any tab until they interact with it. If more than one offer is live, only the first
is ever shown.

---

## 4. Could it pass a smoke test while being broken?

**Yes — comfortably.** Someone installs it tomorrow, logs into a populated backend, and taps through
all 21 screens. Here is the split.

### 4.1 They would notice (visible on the first populated screen)

| Finding | What they'd see |
|---|---|
| §3.1 unbounded `/me/tickets` + unvirtualised `ScrollView` | The Tickets tab and app launch are slow or the list janks/OOMs. Hard to miss with a real pool. |
| §3.2 "Visit Now — most urgent" is the shared pool sorted by plant id | An experienced SE will immediately say "these aren't mine and they aren't urgent." A tester who doesn't know the domain **will not notice.** |
| §2.1 transporter slot showing the customer company | Only noticed by someone who knows both names. Cross-checkable by opening Ticket Detail on the same ticket and seeing a different name — but nobody does that in a smoke test. |
| §3.4 notification badge `137` over a 50-row list | Noticeable only if the tester counts. |
| §3.9 accumulating "Removed" ghost cards | Needs a long session plus concurrent ZM activity. |

### 4.2 They would **not** notice — this is the list you asked for

Every one of these renders a normal, confident, plausible screen.

1. **`AvailabilityScreen` says "Available" when the fetch failed.** (B1 —
   `AvailabilityScreen.tsx:45-47,55,122.`) Green light, working button, nothing wrong on screen. The
   only tell is a 12px muted line above it.
2. **`AvailabilityScreen` says "Available" when the active window fell off the 10-row page.**
   (§3.3.) Not an error path at all — a *successful* 200 that the client mis-derives. Server says
   `ON_LEAVE`; app says available and offers to make the SE unavailable. Undetectable without
   querying the DB.
3. **`StockScreen` shows "Kit Complete" + "0 AVAILABLE / 0 LOW / 0 HEALTHY".** (B2 —
   `StockScreen.tsx:25,78`.) Renders during load *and* on a genuinely empty response *and* — via the
   backend's own seam-default `if (anyStock === 0) return { complete: true, missing: [] }`
   (`inventory.service.ts:56-57`) — for any production SE whose van stock has never been recorded.
   A green all-clear is the single most confidence-inspiring thing on the screen and it is the least
   trustworthy.
4. **`VerificationScreen` says "Verification pending" for a `FAILED_ACTIVATION` run.** (C7 —
   `VerificationScreen.tsx:25-30,58`.) The SE is told to keep waiting on a terminally failed
   activation. Requires an INSTALL ticket that failed activation — not something a smoke test
   creates.
5. **`LeaveRequestScreen` says "No leave requests yet."** when the request errored. (B3 —
   `LeaveRequestScreen.tsx:42-44,87-91`.) An SE with a pending leave request sees a clean "none".
6. **`TroubleshootFormScreen` silently swallows every non-409 submit failure.**
   (`TroubleshootFormScreen.tsx:65-71`.) The SE taps "Submit Repair"; the button label reverts from
   "Submitting…" to "Submit Repair"; nothing else happens. Identical to never having pressed it. The
   SE walks away believing the repair is filed. **This is the most operationally dangerous finding
   in the report** and it is completely invisible in a smoke test, because a smoke test's submits
   succeed.
7. **Home KPI tiles under-count.** (C1 — `homeKpi.ts:10-11`.) `FAILED_RECOVERY` never appears in the
   FAILED tile. The tile shows a number; numbers look correct.
8. **Home Plant Workload shows "0 / 0"** when the two endpoints resolve different schedules. (§3.5,
   B7.) Reads as "nothing started at this plant yet."
9. **Tickets tab shows yesterday's plan as today's** on a no-dispatch day, while Home simultaneously
   says "your plan is being prepared." (§3.5.) Both screens look internally coherent.
10. **`VouchersScreen` CLAIMED tile exceeds the visible rows** past 50 vouchers. (§3.4.) Nobody adds
    up the list.
11. **Over-limit voucher items render as ordinary rows.** (C11 — `me-vouchers.service.ts:107,117`
    computes `overLimit`; `VouchersScreen.tsx:94-105` ignores it.) A ₹8,000 meal claim looks exactly
    like a ₹200 one.
12. **`StockScreen` shows "Component"** for any request whose `componentName` is null. (B10.)
13. **Ticket Detail cards render title-only** for `FITTED`, `COLLECTED`, `RECEIVED_AT_WAREHOUSE`,
    `FAILED_RECOVERY`. (C9.) "Recovery — Collected" with no body reads like a finished state, not a
    missing branch.
14. **`NotificationsScreen` on error** renders its header and filter chips and nothing else.
    (`NotificationsScreen.tsx:114-129` — the `error` state has no UI.) Reads as "no notifications."
15. **`VerificationScreen` on error** holds a blank loading state indefinitely.
    (`VerificationScreen.tsx:48-51`.)
16. **`TicketsScreen` offline** shows "Offline — showing the last cached list" over "No cached
    tickets yet." (B16.) Contradictory, and the cache it names does not exist.
17. **Offline writes are silently not queued.** (§3.8.) The seam exists in the codebase, which is
    exactly why nobody will check.

---

## 5. Negatives — explicitly verified

**Fully server-driven, correct shapes, nothing fabricated (7 screens):**
`ProfileScreen`, `ConflictScreen`, `CollectionFormScreen`, `UnableToCollectScreen`,
`InstallFormScreen`, `VoucherFormScreen`, `LeaveRequestFormScreen`.

**Verified correct and worth recording:**

- No mock data anywhere in `apps/mobile/src` (§1.1).
- All six `TilePicker` vocabularies are imported from `@fsm/shared`, and the backend validates
  against the same imported arrays for root cause (`troubleshoot.controller.ts:11,50`) and media
  slots (`media.controller.ts:18,63-64`). These cannot drift.
- `slaBucketToStatus` / `formatSlaBucketLabel` degrade correctly on an unknown bucket
  (`ticketDisplay.ts:22-24,29-38`).
- Device-serial hints on both Collection and Install forms match the server's comparison exactly
  (`recovery.service.ts:124`, `install-lifecycle.service.ts:128`).
- Intraday error codes match the controller exactly
  (`IntradayOfferScreen.tsx:54,71` ↔ `intraday-insertion.controller.ts:70-71,87-88`).
- `X-Device-Id` and `X-App-Version` are on every request including login
  (`client.ts:104-111,113-124`).
- The client pins `/api/v1`, and the backend registers every route at both `/api/v1` and `/api`
  (`client.ts:96` ↔ `app.config.ts:18,27-30`).
- Every route the client calls exists with the SE role permitted — verified against the controller
  inventory (`grep -rn "@Controller(" apps/backend/src`), including the two easy-to-get-wrong ones:
  `POST /engineers/:seId/availability` (`engineers.controller.ts:205-206`) and
  `POST /vehicle-unavailability` (`vehicle-unavailability.controller.ts:54,59-60`).
- No hardcoded zone or plant reference exists (§3.7). No ID format is assumed (§3.6).
- `ErrorBoundary` sits outside `AuthProvider` and catches keychain-rehydrate throws
  (`app/_layout.tsx:8-15`).

**Not reached / out of scope:** runtime behaviour (nothing was executed); the 51 `.test.tsx` files;
`apps/admin`; push delivery (`#89` — no FCM registration call exists in `apps/mobile/src`, only the
backend endpoint at `notifications.controller.ts:44-55`); the Android native build; and
`GET /me/tickets/:id/forms` (`me-tickets.controller.ts:52-60`), which the mobile client never calls.

---

## 6. Verdict

**Does this app work on real FSM data?**

**Partly. It is not running on baked-in values — but it is not safe to hand to 76 engineers as-is.**

The architecture is sound and the discipline is visible: one shared contract package imported by
both sides, no mock data, no fabricated records, no hardcoded plants or zones, IDs treated as opaque,
server-authoritative validation with the client doing only pre-flight checks. Almost every screen
calls a real endpoint and renders what came back. Judged on the question you actually asked — *is
the UI secretly running on client-side data?* — the answer is **no**.

The failures are of a different kind, and they are worse in one specific way: **the app is confident
when it is wrong.** Nine of the seventeen invisible findings in §4.2 render a green, complete,
plausible screen built from a value the server never sent.

Concretely, these are the screens and values that would be **wrong or fabricated** in production:

1. **`AvailabilityScreen` → the status card.** Renders **"Available"** both on fetch failure and —
   more seriously — whenever the SE's active window is outside the server's 10-row page. The server
   and the app will disagree about whether an engineer is on leave.
   (`AvailabilityScreen.tsx:122`; `se-availability.service.ts:43-49` vs `:55-60`.)
2. **`StockScreen` → the "Kit Complete" pill and the three tiles.** Shows a green all-clear during
   load, on an empty response, and for any SE with no recorded van stock.
   (`StockScreen.tsx:25,78`; `inventory.service.ts:53,56-57`.)
3. **`TroubleshootFormScreen` → the submit path.** A non-409 failure is swallowed with no error and
   no navigation. An SE will believe a repair was filed when it was not.
   (`TroubleshootFormScreen.tsx:65-71`.)
4. **`VerificationScreen` → the headline.** `FAILED_ACTIVATION` renders "Verification pending".
   (`VerificationScreen.tsx:25-30,58`.)
5. **`TicketsScreen` → the transporter name and the section ordering.** Renders the customer company
   as the transporter, and labels the unassigned shared pool "Most urgent tickets across all plants"
   over a plant-id sort. (`TicketsScreen.tsx:41,141`; `me-tickets-query.service.ts:16,89,121` vs
   `me-ticket-detail.service.ts:84`.)
6. **`LeaveRequestScreen` → "No leave requests yet."** on a failed fetch.
   (`LeaveRequestScreen.tsx:42-44`.)
7. **`HomeScreen` → the KPI tiles and Plant Workload bars.** Under-count (`FAILED_RECOVERY` is never
   counted) and render "0 / 0" when the two endpoints disagree about which schedule is today's.
   (`homeKpi.ts:11`; `me-tickets-query.service.ts:41-44` vs `day-plan-query.service.ts:37`.)
8. **`VouchersScreen` → the CLAIMED tile past 50 vouchers, and every over-limit item.**
   (`me-vouchers.service.ts:69,74,77,122-130`; `VouchersScreen.tsx:94-105`.)

And one that is not a wrong value but will be felt first: **`GET /me/tickets` has no limit, no
cursor, and an N+1 snapshot lookup per device, and the client renders the result unvirtualised**
(`me-tickets-query.service.ts:73-96,143-158`; `TicketsScreen.tsx:138-185`). On a dev database with
one engineer and zero rows this is free. On ~19k devices it is the first thing that breaks.
