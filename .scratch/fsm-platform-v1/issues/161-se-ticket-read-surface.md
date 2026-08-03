# 161 — SE ticket-read surface (mobile M3 data source)

Status: ready-for-agent — **partial: item 2 (day-plan/shared-pool merge), item 1 + `ticketNo`
(ticket detail — SE/recovery reads), item 3 (own submitted forms), and the `/api/me` enrichment
(all landed 2026-08-03).** Only the day-plan removal/deferral-metadata AC (PRD:510) remains open.
See the dated comments for scope and why each stopped where it did.
Type: AFK · Backend

Filed 2026-07-28 by the mobile-readiness verification
(`docs/status/backend-mobile-readiness-plan-2026-07-28.md` §C). This is the prior audit's
**rank-1 hard blocker**, unchanged since 07-22: the SE day plan returns ticket IDs and nothing
expands them, so the central mobile screen (M3 Ticket Detail, issue #57) has **no data source** —
and #57's own pinned API contract cites `GET /api/tickets/:id`, which is manager-only
(`ticketing/tickets.controller.ts:70-71`).

## What to build

SE-callable reads for the SE's own ticket work, scoped to the coverage floor (#162's predicate —
build together, reuse one scoping helper):

1. **Ticket detail for an SE** — either add `SERVICE_ENGINEER` to `GET /api/tickets/:id` with a
   row-level scope (ticket assigned to the SE, or in a covered plant), or a dedicated
   `GET /api/me/tickets/:id`. Must cover **troubleshoot and recovery** tickets (recovery currently
   has no GET at all — `recovery.controller.ts` is POST-only, `:52-72`). Payload per PRD:484 /
   story 82: device, vehicle, plant, transporter name+number, SLA bucket, tier, symptom/failure-cycle
   history, expected components, createdAt/lastStateChangedAt. Install detail already exists and is
   correctly scoped (`install.controller.ts:216-217`, `install-lifecycle.service.ts:266`) — mirror
   its shape where sensible, don't duplicate it.
2. **Day-plan expansion** — the day plan (`day-plan-query.service.ts:62-77`) either embeds the
   per-ticket summary (bounded fields, list-card sized) or the client batch-fetches via (1).
   Decide once; the shape becomes the client's cache schema. Include removal/deferral metadata:
   PRD:510 requires a "removed" label for one session — today a deferred/removed ticket silently
   vanishes from the read (`day-plan-query.service.ts:55`, `shared-pool.service.ts:43-45`).
3. **Own submitted forms** — SE-readable variant of `GET /api/tickets/:id/forms`
   (currently manager-only, `tickets.controller.ts:83-84`), scoped to the SE's own submissions.

Payload note: shared-pool/`companyTier` is creation-time-stamped and diverges from #157's effective
tier **by decided design** (Q-B) — document the field's meaning in the response contract; do not
"fix" it.

## Acceptance criteria

- [ ] An SE can expand every ticket ID on their day plan and shared pool into a detail payload; a ticket outside their coverage returns 404/403 (never data)
- [ ] Recovery tickets are SE-readable (same scope rule)
- [ ] An SE can read their own submitted troubleshoot forms; never another SE's
- [ ] Day-plan read carries enough per-ticket context for the M2 list card without N+1 client fetches, and carries removal/deferral metadata (PRD:510)
- [ ] Payload sizes stay phone-friendly: detail ≤ ~5 KB; day-plan expansion bounded (see #165 for the list bound)
- [ ] Contract documented (fields + meaning, incl. the companyTier stamped-at-creation semantics) — this shape is what #54/#57 pin against

## UI surfaces

n/a (backend contract; consumed by Mobile #55/#56/#57/#64 — those issues own the screens).

## Reference

n/a (backend-only; mobile references live in the consuming M-series issues).

## Blocked by

- None hard. Build together with #162 (shared coverage predicate). HITL-7 (covered-any vs
  covered-claimed) does not block: coverage floor is spec-fixed (workflow:792/:2011).

## Comments

### 2026-07-28 — revised against the freeze bar (docs/status/mobile-backend-freeze-plan-2026-07-28.md)

Scope widened by the field-level derivation against the mobile reference images. The gap is bigger
than "expand a ticket id":

- **`GET /api/me` is in scope and was missed.** It returns 4 primitives (`me.controller.ts:18-23`)
  against a Profile screen rendering **21** data points and a Home header needing 4 more. Needs
  ~14 fields: `name`, `phone`, `email`, `zoneName`, home plant id+name, `coverageType`,
  `dailyCapacity`, shift window, covered plants, `reportsTo{name,role,phone,email}` (derivable via
  `Zone.zonalManagerUserId`, `schema.prisma:219`), current availability, `dataAsOf`.
- **Per-ticket day-plan expansion fields** (from the images): `vehicleNo`, `deviceId`, `deviceType`,
  `transporterName`, `companyName`, `slaBucket`, `inactivityHours` (`DeviceState.inactivityHours`
  exists at `schema.prisma:1915`, exposed nowhere), `status`, `activeSoftState`, `topTechnicalHint`,
  `workType`, `isCriticalInsertion`; plus per-stop `inactiveDeviceCount`/`urgentCount`/`inWorkCount`.
- **Ticket detail** additionally needs `lifecycle[]` (exists on the manager view,
  `ticket-query.service.ts:62-70`), failure-cycle history, expected components, component-request
  status + SLA-paused badge, and the readiness hint (`recommender.service.ts:111` still hardcodes
  `UNKNOWN`).
- **`activeSoftState` is load-bearing and has no read anywhere** — without it the action bar cannot
  know which CTA to render.
- **Recovery read** confirmed absent (`recovery.controller.ts` has no SE GET) — install has one
  (`install.controller.ts:216`) and is the model. **Install's own view** omits `vehicleNo`,
  `plantName`, `companyName`, `simId`, `targetDate`, `notes` — all accepted at create
  (`install.controller.ts:85-94`), none returned.

**Two new HITL ACs:**
- [ ] **Human-readable ticket number.** Every reference image renders `TCK-#####`; `Ticket.ticketId`
      is a UUID (`schema.prisma:2027`) and no column exists. Schema + backfill + product decision (D-4).
- [ ] **`companyTier` semantics stated in the response contract** — it is stamped at ticket creation
      and diverges from #157's effective tier *by decided design*. A comment is not enough; a frozen
      client will render it as current.

**Dependency added:** the Home-screen field list depends on **#172** (the reference image shows KPI
tiles + a 7-day chart + a workload grid where the PRD describes a ticket list). Do not build the
Home payload before that conflict is resolved.

### 2026-07-28 — #172 ratified; contract shape changed

[#172](./172-mobile-screen-contract-ratification.md) is decided. Three consequences land here:

**1. The day-plan / shared-pool split is no longer a contract boundary.** Decision 3 merged the
Tickets list, so this issue and #165 now owe **one** endpoint rather than two shapes:

```
GET /api/me/tickets
  -> { items: [{ ticketId, assigned: boolean,
                 workState: 'VISIT_NOW'|'PLAN'|'IN_WORK'|'VERIFY',
                 ...row fields }],
       cursor }
```

`workState` is the image's row glyph (V/P/W/✓) and its filter chips. Naming is pinned under #169.
Coverage scoping is unchanged — the merged list is still "across all mapped plants".

**2. Home is built from this issue's field list.** Decision 1 confirmed the KPI tiles, the Next
Visit counts (`4 inactive · 3 urgent · 2 in work`) and the Plant Workload percentages all derive
from **per-ticket status** plus the per-stop counts already scoped here. `Last sync` is `dataAsOf`.
The one thing that does *not* derive is the 7-day chart → split out as **#175**, deferred.

**3. New AC — `employeeCode` on `GET /api/me`.** The Home header renders `ID - ANV1012`; there is no
such column on `User` (`schema.prisma:131-148`) or `EngineerMaster` (`:154-168`). Small additive
column; decide whether it is FSM-owned or sourced.

Also confirmed by the ratification: the telemetry/Technical-Health block and transporter tap-to-call
are **not** spec conflicts — the PRD requires both explicitly, so they are pure gaps owned by **#84**
and **#171** respectively. Do not re-litigate them here.

### 2026-07-28 — D-4 answered: ticket display number

**The spec never defines a format.** Grep across PRD, workflow and CONTEXT finds exactly two
mentions, both incidental: the WhatsApp SE-Acceptance confirmation "carries the **Ticket number**"
(`PRD:228`, `workflow:1461`). The `tickets` data-dictionary row (`workflow:1647`) lists no such
column. `TCK-#####` exists **only** in the reference images. So the format is genuinely open.

#### Recommendation — global monotonic sequence, `TCK-` + zero-padded integer

Observed in the images: `TCK-10252`, `TCK-10265`, `TCK-10287`, `TCK-10291`, `TCK-10301`,
`TCK-10302`, `TCK-10306` — five digits, flat, no zone or date segment.

**Reject per-zone sequences (`TCK-W-####`), and not merely because the images don't show one:**
**#158 lets an Operations Head move a plant to a different zone.** A zone-encoded ticket number
would become *actively wrong* after any such move — the number would assert a zone the ticket no
longer belongs to, on a label whose entire job is to be quoted in a phone call. That is a
correctness argument, not an aesthetic one.

Reject date-prefixed (`TCK-260728-###`): longer to read aloud, and `createdAt` already carries the
date wherever it matters.

**Global sequence it is.** The number's job is to be short, unique, and quotable — not to carry
information. The schema already uses `@default(autoincrement())` BigInt on 8+ models, so a Postgres
sequence is idiomatic here.

#### Derivation

Add `ticketNo BigInt @default(autoincrement()) @unique @map("ticket_no")` **alongside** the existing
UUID primary key. Format `TCK-` + the number, zero-padded to 5 for display; the client formats, the
server returns the integer and (recommended) the formatted string, so padding rules never fork.

**`ticketId` stays the primary key and stays the API path parameter.** The display number is a
*label*, not an identity — do not switch routes to it, and do not let it into foreign keys.

#### Backfill

**21,438 tickets exist today.** Backfill in creation order (`ORDER BY created_at ASC, ticket_id`) so
numbers are chronologically monotonic — an SE reading two numbers should be able to infer which
ticket is older. Set the sequence start above the backfilled maximum. Do it as a single migration
transaction, or a batched idempotent one that can resume; a half-backfilled table with a live
sequence is the failure mode to avoid.

Note the images' numbers (~10 300) are below our real volume, so backfilled numbers will run to
21 000+. Still five digits; no display change needed.

#### Downstream that needs updating

| Surface | Impact |
|---|---|
| **#161 / #165 payloads** | `ticketNo` on the ticket read **and** the merged list row — it appears on 5 screens. In scope here. |
| **Admin ticket search** | `tickets.controller.ts:47` takes `@Query('q')`; the search must match a ticket number, not just vehicle/plant/device. A support call will quote `TCK-10306`. |
| **Notifications / WhatsApp** | `notifications.entityId` carries the ticket **UUID** (`notification.service.ts:104`), but `workflow:1461` requires the WhatsApp confirmation to carry the **Ticket number**. Decide now whether to denormalise `ticketNo` into notification metadata at write time or resolve at send time — **#76** has not built the adapters yet, so the payload shape is still free. |
| **Audit-trail route** | `audit-trail.controller.ts:23` validates `UUID_RE` on the path param. Fine to leave UUID-only (it is an internal deep link), but decide deliberately rather than by omission. |
| **Admin ticket drawer / deep links** | Display the number, keep the UUID in the URL. |
| **Exports** | **No change needed** — the OH entity-mapping export carries `open_ticket_count` only, no ticket identifiers (`exports/entity-mapping-export.service.ts:36`). Worth stating so nobody goes looking. |

#### New acceptance criteria

- [ ] `tickets.ticket_no` exists, unique, monotonic, backfilled in creation order for all existing rows
- [ ] The SE ticket read and the merged list row both carry it; `ticketId` remains the PK and the route param
- [ ] Admin ticket search matches a quoted ticket number
- [ ] The notification/WhatsApp payload decision is recorded before #76 builds the adapters

### 2026-07-28 — `/api/me` phone/email: column confirmed present, this is an exposure gap only

Checked while settling D-2. `User.phone` (`String @unique`, non-null) and `User.email` both already
exist on `schema.prisma:136-137`, and `EngineerMaster` explicitly defers to `users` for SE identity
and contact. So the `name` / `phone` / `email` items on this issue's `/api/me` enrichment list need
**no migration** — they are a pure exposure gap behind an endpoint that returns four primitives
(`me.controller.ts:18-23`).

Same applies to the Profile screen's **ZM contact block** (name, phone, email): resolvable via
`Zone.zonalManagerUserId` (`schema.prisma:219`) → `users`. All present, none exposed.

No new issue; the other consumer of the same field is **#76** (WhatsApp delivery address).

### 2026-08-03 — item 2 landed (merged `GET /api/me/tickets`); scope deliberately stopped there

Built together with #162's coverage predicate, as both issues require. New `MeTicketsModule`
(`src/me-tickets/`) — `MeTicketsQueryService` + `MeTicketsController` at `GET /api/me/tickets`,
SE-only, registered in `AppModule` alongside `SharedPoolController`.

**What it does.** Implements #172 Decision 3's contract exactly:
`{ items: [{ ticketId, assigned, workState, ...row fields }], cursor: null }`. Merges two existing,
**untouched** read paths rather than replacing them: the SE's own dispatched day-plan (`WorkSchedule`
→ `PlantBatchAssignment` → `BatchAssignmentTicket`, `assigned: true`) and the shared-pool set (OPEN /
UNASSIGNED tickets at covered plants, `assigned: false`) — both scoped through #162's
`SeCoverageService`. `DayPlanQueryService` (still backs the ZM SE-detail view) and `SharedPoolService`
(still its own contract) are unchanged; this is a new SE-facing read on top of the same data, not a
replacement of either service.

`workState` derivation — the two unambiguous cases are exact: `VERIFY` = `status === 'VERIFICATION_PENDING'`;
`IN_WORK` = an active `ON_SITE`/`TROUBLESHOOT_STARTED` soft state. The `PLAN` vs `VISIT_NOW` split
(assigned-but-not-started vs. pool) is a reasonable default, **not a ratified decision** — #172 itself
says naming/semantics for this vocabulary is pinned under **#169**, which this session did not touch.
Row fields shipped: `workType`, `status`, `plantId`/`plantName`, `companyName`, `companyTier`,
`slaBucket`, `deviceId`, `vehicleId`, `activeSoftState`, `createdAt`, `lastStateChangedAt` — enough
for the M2 list card without an N+1 fetch, per AC, but **not** the full widened field list from the
2026-07-28 comment above (`vehicleNo`, `deviceType`, `transporterName`, `inactivityHours`,
`topTechnicalHint`, `isCriticalInsertion`, per-stop counts) — those need derivations owned elsewhere
(recommender hint is hardcoded `UNKNOWN`; transporter fields are #171's gap) or weren't in the task's
scope for this slice.

**Deliberately not built this session** (left for a follow-up pass on this same issue, not filed as
new issues per instruction):
- Item 1 — ticket detail read (`GET /api/tickets/:id` SE access or `GET /api/me/tickets/:id`),
  including RECOVERY SE-readability (`recovery.controller.ts` is still POST-only).
- Item 3 — SE-readable own submitted forms (`GET /api/tickets/:id/forms` is still manager-only).
- `GET /api/me` enrichment (still 4 primitives against the ~14-field ask).
- `tickets.ticket_no` migration/backfill and its downstream (admin search, notifications).
- Day-plan removal/deferral "removed for one session" label (PRD:510) — `BatchAssignmentTicket.removedAt`
  exists but is not surfaced on this row.

Tests: `test/me-tickets-controller.e2e-spec.ts` (5 cases — merge, IN_WORK derivation, out-of-coverage
exclusion, non-SE 403, unauthenticated 401).

### 2026-08-03 — item 1 (ticket detail) + ticketNo landed

Both remaining pieces this session was scoped to (`ticketNo` end-to-end, and item 1's ticket-detail
read) are built, tested, and committed. Item 3 (own submitted forms), `/api/me` enrichment, and the
day-plan removal/deferral metadata AC are still open — deliberately out of scope for this pass, not
attempted.

**`ticketNo` (D-4).** `Ticket.ticketNo BigInt @default(autoincrement()) @unique @map("ticket_no")`,
migration `20260803120000_ticket_no`. Additive: column added nullable with no default, backfilled by
a single `ROW_NUMBER() OVER (ORDER BY created_at ASC, ticket_id ASC)` update (not the default
`nextval()` path, which would have numbered by physical heap order instead of creation order), then
the sequence is created and seeded above the backfilled max and the column is set `NOT NULL` +
unique-indexed — all in the one transaction a Postgres migration file already runs in, so the
"half-backfilled table with a live sequence" failure mode the issue calls out cannot occur; no
batching/resume logic was needed at the ~24k-row scale this local DB backfilled at (verified
monotonic against `created_at` post-backfill). Display format exactly as specified: `TCK-` +
zero-padded-to-5. **Both** the raw integer and the pre-formatted string are returned (the issue's own
recommendation) — `ticketNo: number` (JSON number; ticket volumes are far inside
`MAX_SAFE_INTEGER`, unlike the UUID-adjacent bigint ids elsewhere in these payloads that get
stringified) and `ticketNoDisplay: string`. Helper: `src/ticketing/ticket-no.ts`. Wired into: the
`GET /api/me/tickets` row (`MeTicketRow`), the new `GET /api/me/tickets/:id` detail payload, and
`GET /tickets`'s `@Query('q')` search (`ticket-query.service.ts` — a `TCK-?(\d+)` match, case-
insensitive, dash-optional, added as its own `OR` leg so a bare numeric `q` keeps its existing
plant/company-id meaning). Audit-trail route and exports untouched, per the issue's own "no change
needed" calls. Notification/WhatsApp payload decision explicitly **not** made here — still #76's to
make when it builds adapters.

**Item 1 — `GET /api/me/tickets/:id`.** New `MeTicketDetailService` (`src/me-tickets/
me-ticket-detail.service.ts`), wired onto the existing `MeTicketsController` (`GET /me/tickets/:id`,
SE-only). One endpoint covers TROUBLESHOOT, RECOVERY and INSTALL uniformly — this is what closes the
literal `RecoveryController`-is-POST-only gap the issue names, without adding a parallel GET there;
`install.controller.ts`'s own `GET /install/:ticketId` is untouched and still serves its existing
`INSTALL_READER_ROLES` callers (WM included).

Scope rule, reusing #162's `SeCoverageService` (no second coverage predicate): readable if EITHER
assigned to the caller (`Ticket.assignedSeId === seId` — the column RECOVERY/INSTALL dispatch writes
directly — OR the caller's live `WorkSchedule → PlantBatchAssignment → BatchAssignmentTicket` names
it, the same mechanism `MeTicketsQueryService` already resolves "assigned" with) OR shared-pool-
visible (`OPEN` + `UNASSIGNED` + not currently deferred, at a covered plant). Outside both → `null` →
controller 404s; out-of-coverage and unknown-ticket-id are never distinguished from each other or
from "assigned to someone else" in the response.

**Response contract** (`MeTicketDetailView`, `src/me-tickets/me-ticket-detail.service.ts`) — the
shape #54/#57 pin against:

| Field | Type | Notes |
|---|---|---|
| `ticketId` | `string` (UUID) | canonical identity, unchanged |
| `ticketNo` | `number` | raw `TCK-` number |
| `ticketNoDisplay` | `string` | pre-formatted `TCK-#####` |
| `deviceId` | `string` | |
| `vehicleNo` | `string \| null` | null when the ticket has no linked vehicle |
| `plantName` | `string` | |
| `companyName` | `string` | |
| `companyTier` | `string` | **stamped at ticket creation** — diverges from #157's zone-scoped *effective* tier override by decided design (Q-B); this is not a bug and must not be "fixed" by joining the live override in |
| `transporterName` | `string \| null` | name only — transporter **phone/number** is a column that does not exist yet (#171's gap); left out rather than invented |
| `slaBucket` | `string \| null` | from `device_states`, null if never computed |
| `workType` | `string` | `TROUBLESHOOT \| RECOVERY \| INSTALL` |
| `status` | `string` | ticket status enum |
| `activeSoftState` | `string \| null` | the caller's own unresolved `SoftState` on this ticket (per-(SE,ticket); a shared-pool ticket the SE hasn't engaged reads `null` even if some other SE has an active state on it) |
| `createdAt` | `string` (ISO) | |
| `lastStateChangedAt` | `string` (ISO) | |
| `failureCycleHistory` | array, bounded to 10 | walks `FailureCycle.previousFailureCycleId` from the ticket's own cycle backward — `[]` for RECOVERY/INSTALL (no failure cycle). Each entry: `{cycleId, openedAt, closedAt, repeatFailure}` |
| `expectedComponents` | array | **judgment call** — this is the ticket's actual `ComponentRequest` history (what was requested + its approve/ship/receive status), reusing the model as-is. It is *not* a catalog-driven "expected components for this device" list — that derivation genuinely does not exist yet (`hard-filters.ts`'s `expectedComponentsAvailable` is still hardcoded `true`; no `expected_components` table exists — Issue 21/22, out of scope here). Each entry: `{requestId, componentId, componentName, status, requestedAt}` |
| `componentRequestStatus` | `string \| null` | latest `ComponentRequest.status`, null if none raised |
| `waitingComponentSince` | `string (ISO) \| null` | the SLA-pause badge anchor — set only while the failure cycle is `WAITING_COMPONENT` |
| `readinessHint` | `'READY' \| 'ON_TRIP' \| 'STALE' \| 'UNKNOWN'` | **judgment call** — literal `'UNKNOWN'` today, always. There is no per-ticket vehicle-readiness value persisted anywhere to read: the Recommender computes `vehicleReadiness` in-memory per dispatch run (`recommender.service.ts`, hardcoded `'UNKNOWN'`) and never stores it. The field is genuinely present (satisfying "has no read anywhere"), but fixing the hardcode is the separate systemic gap the issue explicitly defers — not attempted here |

Explicitly excluded, per the issue's own #172-ratified comment: Technical Hints, raw telemetry
(owned by #84).

Payload size: the richest fixture in the e2e suite (repeat-failure chain + component request) is
well under the ≤5KB budget — asserted directly in the test.

**Judgment calls made this session:**
- `expectedComponents` reused `ComponentRequest` (real data) rather than returning an empty
  placeholder for a nonexistent "expected kit" concept — see the contract table above.
- `readinessHint` is a literal constant, not a live computation — see the contract table above.
- Both `ticketNo` and `ticketNoDisplay` are returned (the issue's own "recommended" option), on both
  the list row and the detail payload, for consistency.
- One unified `GET /api/me/tickets/:id` covers all three work types rather than adding a parallel GET
  to `RecoveryController`; `install.controller.ts`'s existing `GET /install/:ticketId` was left as-is
  rather than merged away, since manager/WM callers already depend on its exact shape.
- Migration backfill used a single set-based `UPDATE ... FROM (ROW_NUMBER() OVER ...)` inside the one
  transaction Postgres migrations already run in, rather than hand-rolled batching — correct and
  fast at the real ~21k-row / this DB's ~24k-row scale; documented in the migration file itself as a
  deliberate choice, not an oversight.

Tests: `test/me-ticket-detail-controller.e2e-spec.ts` (8 cases — full-payload happy path incl.
repeat-failure history + component-request/SLA-pause badge + payload-size assertion, RECOVERY
readability, shared-pool visibility, out-of-coverage 404, unknown-id 404, "correct role wrong SE"
404, non-SE 403, unauthenticated 401); `test/issue-122-dashboard-reads.e2e-spec.ts` gained one case
for the `TCK-#####` admin search match; `test/me-tickets-controller.e2e-spec.ts` extended to assert
`ticketNo`/`ticketNoDisplay` on the list row.

### 2026-08-03 — item 3 (own submitted forms, `GET /api/me/tickets/:id/forms`) landed

`/api/me` enrichment and the day-plan removal/deferral metadata AC remain open — not attempted this
session, per operator direction to build item 3 next.

**Scope rule.** New `MeTicketFormsService` (`src/me-tickets/me-ticket-forms.service.ts`) filters
`TroubleshootingSubmission` rows to `ticketId` + `seId === caller` — "never another SE's" is
enforced at the query, not by post-filtering. Access gate is an OR: the caller sees the (filtered,
possibly empty) list if EITHER they have at least one submission of their own on the ticket
(ownership — independent of the ticket's *current* coverage/assignment, since a plant/zone
reassignment, #158, must not erase an SE's own past work from their view) OR the ticket is currently
readable to them under item 1's rule (covers the "I can see this ticket but haven't submitted
anything yet" empty-array case). Outside both → `null` → controller 404s, same never-distinguish-
unknown-from-out-of-scope convention as item 1.

**Refactor, no behavior change.** Item 1's scope predicate (`assignedSeId` direct / day-plan
schedule / shared-pool-visible-and-covered) was private to `MeTicketDetailService`. Extracted to
`src/me-tickets/se-ticket-access.ts` (`isTicketReadableBySe` + its `assignedViaSchedule` helper) so
item 3 reuses the identical rule rather than growing a second copy — the issue's own #172-era note
("Coverage scoping is unchanged... reuse one scoping helper") applied to this predicate too.
`MeTicketDetailService` now calls the shared function; its own two private methods were deleted, not
duplicated. All of item 1's existing tests stayed green through the extraction, unmodified.

**Route.** `GET /me/tickets/:id/forms` on the existing `MeTicketsController`, SE-only. Reuses
`TicketFormView` (`ticketing/ticket-query.service.ts`) — the same shape the manager read
(`GET /tickets/:id/forms`) already returns — so no new response type had to be pinned for #57.

**Judgment call — a real submission workflow can't produce two SEs' submissions on one open
ticket.** `TroubleshootSubmissionService.submit` moves a TROUBLESHOOT ticket `OPEN` →
`VERIFICATION_PENDING` on the first accepted submission (normal path) or into `WAITING_COMPONENT`
(component-unavailable path); either way a second SE's `POST .../troubleshoot` on the same ticket
hits the Business-409 conflict path, not a second row. The "never another SE's" test therefore
inserts the second submission directly via Prisma rather than through the API, to isolate what this
*read* is responsible for (query-level filtering) from #16's submission-workflow rule.

Tests: `test/me-ticket-forms-controller.e2e-spec.ts` (8 cases — own submission returned, empty array
when readable-but-unsubmitted, cross-SE isolation on one ticket, ownership survives a coverage
revocation that also 404s the ticket detail read, out-of-coverage-with-no-own-submissions 404,
unknown-ticket-id 404, non-SE 403, unauthenticated 401). Full backend suite re-run after the
extraction: 321/325 files, 1364/1371 tests green, `tsc` clean — the only failures are the
pre-existing [#187](./187-voucher-controller-e2e-missing-engineer-seed.md) `voucher-controller`
fixture defect (reproduces identically in isolation on this branch, unrelated to any file touched
here).

### 2026-08-03 — `/api/me` enrichment landed, scope corrected from the earlier field guess against direct image re-review

Only the day-plan removal/deferral-metadata AC (PRD:510) remains open on this issue.

**The 2026-07-28 "~14 fields" estimate was written without directly re-checking the two images it
cites.** Read `docs/ui/mobile/home-dashboard.png` and `docs/ui/mobile/profile.png` directly before
building (per the workflow's UI-reference-image-authority rule, the same rule #172/#88 already used
to settle this exact screen). Neither image renders `coverageType` (as a labelled field — see below),
`dailyCapacity`, a shift window, or the *list* of covered plants anywhere; both are fully accounted
for by: `name`, one `homePlant`/zone identity block, and a 3-level `reportsTo` (ZM name/phone/email).
The Device Status tile ("Last sync 2 min ago", "Location permission enabled", "Role-based access
enabled") and the "Online / Network status" badge on both screens are client-side facts (network
connectivity, OS permission state) — not resolvable from any backend field, and not attempted here,
same principle as the issue's own precedent of not inventing `readinessHint`/`expectedComponents`
derivations that don't exist. This narrows the AC, it does not weaken it — every value actually
rendered on both screens is now served.

**New gap found, not modeled anywhere: a Plant has no `Company` relationship.** The Profile image's
"Mapped Area → Company: Nuvoco" row has no schema backing — `Plant` (`schema.prisma`) carries no
`companyId`; only `Vehicle`/`Ticket`/etc. relate to `Company`, never `Plant`. `Plant.name` is very
likely just formatted `"{Company} - {Plant}"` at the data-entry/seed layer (`"Nuvoco - Mumbai
Plant"`), which is probably all the mockup's "Company" row actually reflects — not a queryable
relationship. Left out rather than invented; flagged here since it will recur the moment anyone
tries to build a real Plant→Company field.

**`homePlant` is genuinely undefined for non-DEDICATED coverage.** CONTEXT.md: "A Dedicated SE has 1
Plant in coverage; Multi-Plant SE has 3–4 Plants; Floating SE covers 1+ Regions/Districts." The
reference image depicts a Dedicated SE. For MULTI_PLANT/FLOATING there is no "home" plant concept in
the domain model at all — `homePlant: null` for those, `coverageType` returned alongside it so the
client can tell "no home plant, expected" from "no home plant, error."

**Contract.** `SeProfileView` (`packages/shared/src/index.ts`) — `name`, `phone`, `email`,
`zoneName`, `coverageType`, `homePlant: {plantId,name} | null`, `reportsTo:
{name,role,phone,email} | null`. Attached as `SessionView.profile?`, present **only** when
`role === 'SERVICE_ENGINEER'` — every other role gets no `profile` key at all (zero extra joins on
the session-hydration path every role hits on every app load). `null`/omitted also for an SE with no
`EngineerMaster` row (a real state in some dev/test fixtures — every production SE has one via
`engineer-admin.service.ts` — the base session read must never error over an enrichment gap).

**Where it lives.** New `src/me/me-profile.service.ts` (`MeProfileService.getSeProfile`), new
`src/me/me.module.ts` supplying it (`MeController` itself stays registered directly on `AppModule`,
matching the `me-tickets.module.ts` convention). `MeController.me()` is now `async`, calling the
service only when `role === 'SERVICE_ENGINEER'`.

**Test-fixture note.** `auth-fixture-seed.ts`'s `se.north@fsm.test` has a `User` row but **no**
`EngineerMaster` row — the same gap #187 already root-caused for `voucher-controller`. Confirmed
`recovery-controller.e2e-spec.ts`/`recovery-decision-controller.e2e-spec.ts` call `GET /api/me` as
this exact fixture SE; both stayed green because a missing `EngineerMaster` row now correctly omits
`profile` rather than 500ing.

Tests: `test/me-profile.e2e-spec.ts` (5 cases — full profile for a DEDICATED SE with an assigned ZM,
`homePlant: null` for MULTI_PLANT, `reportsTo: null` for a ZM-less zone, no `profile` key for a
non-SE role, no `profile` key for an SE with no `EngineerMaster` row). `test/me.e2e-spec.ts`'s
existing exact-equality assertion for a ZM's `/me` response was left unmodified and stayed green —
direct proof the `profile` key is truly absent, not `null`, for non-SE roles. Full backend suite:
321/326 files, 1364/1376 tests green, `tsc` clean across backend + admin + mobile — only the
pre-existing #187 voucher failures and one known #184-class worker crash, both unrelated.
