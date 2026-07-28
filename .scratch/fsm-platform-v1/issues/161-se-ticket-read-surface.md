# 161 — SE ticket-read surface (mobile M3 data source)

Status: ready-for-agent
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
