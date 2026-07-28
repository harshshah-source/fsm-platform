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
