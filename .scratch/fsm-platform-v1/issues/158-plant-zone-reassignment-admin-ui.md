# 158 — Plant zone reassignment (OH-editable) — surface plant_zone_overrides in the admin UI

Status: ready-for-agent (draft — needs HITL sign-off on the two open questions before any slice starts)
Type: AFK after HITL sign-off (design session 2026-07-23; investigation was read-only, no code touched)

> Filed from the 2026-07-23 investigation session. OH cannot edit a plant's zone through the admin
> UI today — the entire zone-mapping/override surface is API-only (verified: zero matches for
> `plant-zone-overrides` / `zone-mappings` / `reapply` anywhere under `apps/admin`). The 47
> historical overrides that cut UNZONED devices 83% → 23% were applied by curl. The plumbing is
> already OH-only, transactional-audited, and proven to survive master sync, so this is a **thin
> UI wrapper plus one small audit-metadata backend slice** — with one non-obvious contract the UI
> must respect: **setting an override does nothing until `reapply` runs.**
>
> Correction to the filing context: the sync-survival verification lives in
> `docs/audits/zone-application-verification-2026-07-14.md`, **not #128** —
> #128 (`128-device-deployment-lifecycle.md`) is the device-departure lifecycle. And "insert-only"
> describes `plants.zone_id` in the master-sync upsert (create-only, never updated), not the
> override table itself, which is upsert-one-row-per-plant.

## Evidence (verified 2026-07-23, current working tree)

### The existing plumbing

- **Table** `plant_zone_overrides` — `schema.prisma:1754-1767`: `sourcePlantId` (AutoPlant source
  id, `@unique` ⇒ one row per plant, **upsert not history**), `fsmZoneId` FK → zones, nullable
  `reason`, `createdBy` uuid, timestamps. The row does **not** record the previous zone, and a
  re-set **overwrites** `reason` in place; `createdBy` is only set on create, never refreshed on
  update (`zone-mapping.service.ts:142-143`) — the audit log is the only trail.
- **Endpoints** — `zone-mapping.controller.ts`, class-level guard `@UseGuards(AuthGuard, RoleGuard)`
  + `@Roles('OPERATIONS_HEAD')` (`:47-50`): `GET /api/org/plant-zone-overrides` (`:85-88`),
  `PUT /api/org/plant-zone-overrides` (`:90-101`), `DELETE /api/org/plant-zone-overrides/:sourcePlantId`
  (`:103-110`), and the load-bearing sibling `POST /api/org/zone-mappings/reapply` (`:79-83`).
  **OH-only today; no change needed.**
- **Audit** — every mutation is audited in the same transaction via `AuditService.withAudit`
  (`audit.service.ts:56-76` — mutation + `audit_logs` row commit together): `PLANT_ZONE_OVERRIDE_SET`
  (`zone-mapping.service.ts:131-137`), `PLANT_ZONE_OVERRIDE_CLEARED` (`:153-159`),
  `ZONE_MAPPING_REAPPLIED` with counts metadata (`:221-234`). **Gap:** the SET/CLEARED entries carry
  **no metadata** — actor/plant/timestamp yes, but no prev zone, no new zone, no reason. Contrast
  `COMPANY_UPDATED`'s `previous:{}` block (`companies.service.ts:96-105`) — that is the shape to add.

### Sync survival (the anti-drift pattern a new UI rides on)

- `master-mapping.ts:263-273` `mapPlant`: `zoneId` is in the upsert **`create` set only** — the
  `mirrored` update set (`:251-262`) contains AutoPlant-authoritative columns exclusively, so
  re-sync never touches an existing plant's operational zone. Sync only ever *reads* the override
  table (via `MappingTableZoneResolver`, precedence override → MAPPED mapping → UNZONED,
  `mapping-table-zone-resolver.ts:62-88`); nothing in sync writes or deletes overrides.
- The FSM-owned effect happens **only** via `ZoneMappingService.reapply` (`zone-mapping.service.ts:172-237`):
  recomputes every synced plant's target with the same precedence (`:202-205`) and writes
  `plants.zone_id` where changed (`:207-213`) — "the one sanctioned FSM-owned write to `zone_id`"
  (module header `:47`).
- **Proof**: `docs/audits/zone-application-verification-2026-07-14.md` — 47/47 overrides intact and
  zones unchanged through fresh master-sync run 34 (751 plants updated, mirrored columns only), then
  reapply `{plantsConsidered: 751, updated: 0, unchanged: 751}`. Resolver precedence + reapply are
  also e2e-pinned (`test/zone-mapping-resolver.e2e-spec.ts`).
- **Verdict: a UI calling the existing endpoints follows exactly the pattern that survived sync.
  No new sync-survival design is needed.** The one contract to honour: **PUT alone is inert for an
  already-synced plant — the UI must trigger reapply for the edit to take effect.**

### Downstream effects of a zone change (all verified — cleaner than feared)

- **The effective zone is the single denormalised column `plants.zone_id`** (`schema.prisma:199`).
  There is no `getEffectiveZone` helper and no view; every consumer scopes through the plant join —
  recommender/ticket selection (`recommender.service.ts:115,417,454,489`), batch dispatch
  (`batch-assignment.service.ts:77,276`), planner (`se-planner.service.ts:68`), intraday
  (`intraday-insertion.service.ts:108`), cross-zone (`cross-zone-escalation.service.ts:85`),
  auto-recovery (`auto-recovery.service.ts:70`), VU (`vehicle-unavailability.service.ts:111`),
  component requests (`component-request.service.ts:98,115`), inventory (`inventory.service.ts:95`),
  verification queries (`verification-query.service.ts:127`).
- **Tickets, devices, and vehicles store NO zone copy** (`Ticket` `schema.prisma:1977-2066` — no
  zone_id; `Device` `:1602-1626` — none; devices derive zone Device → vehicle → plant). So when
  reapply moves `plants.zone_id`, **every device and open ticket re-scopes instantly through the
  join — no recompute job exists because nothing needs recomputing, and no stored rows go stale.**
- **UNZONED → East, 200 devices**: after reapply the plant's devices and open tickets appear in
  East's dashboards, queues, and next dispatch run (subject to SE coverage existing in East);
  nothing else transitions. **East → South**: identical — tickets leave East's queues for South's
  at read time. Ticket creation itself never touches zone (`ticket-creation.service.ts` — zero
  zone references).
- **What deliberately does NOT follow a plant move**: people's home zones (`User.zoneId`
  `schema.prisma:87`, `EngineerMaster.zoneId` `:109`) and the frozen per-zone monthly/daily
  summary cubes (point-in-time snapshots; correctly not rewritten).
- **The one genuine edge**: `work_schedules` / dispatch-run rows are keyed by the zone at dispatch
  time. A plant moved mid-day while its tickets sit on an ACTIVE/OVERRIDDEN day plan keeps that
  plan under the old zone (provenance — arguably correct) while the *tickets* now read as the new
  zone — old-zone ZM holds the plan, new-zone ZM sees the tickets. Not corrupting, but confusing;
  S4 owns surfacing it (warning in the UI when the plant has live batch assignments today).

### Prior-art trust-boundary context

#130 (run-65 stale-code incident, DONE) is why this design keeps reads on source-of-truth joins
and adds no denormalised zone copies; `plant_deactivations` (#119) is the sibling side-table
precedent, including its OH-only admin page — the closest existing UI pattern
(`PlantDeactivationsPage.tsx`, which already lists plants with `source_plant_id` + read-only zone).

## Design decisions

1. **Thin wrapper — no new mutation semantics.** The UI drives the three existing endpoints +
   reapply. No composite backend endpoint: reapply is idempotent and separately audited, and a
   failure between PUT and reapply is benign (the override sits pending; the next reapply converges
   — exactly the state the 2026-07-14 verification exercised). The UI chains PUT → reapply and
   shows the `ReapplyResult` counts (`plantsConsidered/updated/unchanged/landedUnzoned`) as the
   success surface, so the admin sees the effect, not just the write.
2. **One small backend slice: audit metadata.** Add to `PLANT_ZONE_OVERRIDE_SET`/`CLEARED` entries
   `metadata: { prevFsmZoneId, newFsmZoneId, reason }` (prev read inside the same transaction),
   mirroring `COMPANY_UPDATED`'s `previous:{}` shape. Without it, "who moved this plant from East
   to South and why" is not answerable from `audit_logs` once the override row is re-upserted.
3. **Reason becomes mandatory at the API boundary** (currently nullable, `controller:96`) — every
   other override surface in the platform (ZM override engine) requires a reason; the 47 applied
   overrides all carried one. (Confirm in OQ-3; if declined, the UI still requires it.)
4. **UI shape**: an OH-only "Plant Zones" surface (new Settings tab beside Plants/Companies, or a
   page beside Plant Deactivations — pick after reading the v2 reference, hard gate). Lists synced
   plants: name, `source_plant_id`, `source_zone_name` (what AutoPlant claims), current FSM zone,
   override badge + reason. Actions: set/change override (zone select + mandatory reason), clear
   override. Both chain reapply and display the result counts. Data composes from existing
   endpoints: org plants list (#45), `GET /plant-zone-overrides`, zones list — plus one new admin
   API client module.
5. **Role scope: OH-only, unchanged** — matches the endpoint guard, the #119 sibling page, and the
   graded-party principle (a ZM must not move plants into/out of their own graded zone).
6. **Open tickets: auto-rescope is the existing, by-construction behaviour** — recommend accepting
   it (OQ-1). "Leave under the old zone" is not a config choice; it would require net-new snapshot
   machinery (a zone column on tickets) and contradicts the no-denormalised-copies posture that
   #130 vindicated.

## Acceptance criteria

- [ ] AC-1: `PLANT_ZONE_OVERRIDE_SET`/`CLEARED` audit rows carry `{ prevFsmZoneId, newFsmZoneId,
      reason }` metadata, written in the same transaction (test-pinned; CLEARED records the zone it
      cleared from).
- [ ] AC-2: OH can, from the admin UI, pin a plant to a zone with a reason, see the reapply counts,
      and see the plant's current zone reflect the change; ZM/CSM/WM get no route and 403 at the API.
- [ ] AC-3: clearing an override (UI) reverts the plant to mapping/UNZONED resolution on reapply,
      audited.
- [ ] AC-4: the UI lists override state accurately: overridden plants badged with reason;
      non-overridden plants show their mapping-derived zone; UNZONED plants are filterable (the
      primary worklist — 191-plant residual per `docs/audits/v2UnzonnedPlants.md`).
- [ ] AC-5: sync survival re-pinned end-to-end at the UI seam: set an override via the new client
      path, run a master sync, assert zone + override + reason intact (the 2026-07-14 verification
      as a regression test).
- [ ] AC-6: a plant with live batch assignments today shows a mid-day-move warning before the
      override is applied (edge case above); the warning states that open tickets re-scope
      immediately and today's dispatched plan stays under the old zone.
- [ ] AC-7: UI matches the v2 reference layout/hierarchy per `docs/agents/workflow.md` UI-discovery
      steps (read `docs/ui/desktop/v2-reference/` before building — surfacing rule).

## Slice plan (TDD-first, #128/#130/#136 discipline)

- **S1 — backend audit metadata (small).** RED on the audit-row shape for SET (create + update
  paths — prev zone differs), CLEARED, and the mandatory-reason 400 (pending OQ-3). No schema
  change; `zone-mapping.service.ts` only.
- **S2 — engine consumption: explicitly N/A.** Zone is consumed transitively via `plants.zone_id`
  by every engine read (evidence above); reapply already performs the write. This slice is a
  one-paragraph verification note in the TDD report, not code — recorded so the slice numbering
  matches the #157 template.
- **S3 — admin UI (role-gated).** Read v2 reference first (hard gate). API client
  (`apps/admin/src/api/zoneMappings.ts` or extend `org.ts`), page/tab, set/clear flows chaining
  reapply, result-count surface, override badges, UNZONED filter; vitest selector-contract tests;
  OH RoleRoute.
- **S4 — audit verification + edge cases.** Mid-day-move warning (AC-6) with a probe test for the
  schedule-stays/tickets-move split; end-to-end sync-survival regression (AC-5); UNZONED → zone and
  zone → zone e2e walk-throughs on the dev DB documented in the TDD report; INDEX/SYSTEM-STATE
  updates.

## Open questions (HITL — sign-off required before S1)

- **OQ-1 (blocking): open tickets on zone change — accept auto-rescope (recommended) or require
  stay-under-old-zone?** Current behaviour is auto-rescope *by construction* (tickets have no zone
  column; every queue reads through the plant join). Stay-as-is would mean adding a zone snapshot
  to tickets — new machinery, new staleness class, against the #130 posture. If accepted, AC-6's
  warning is the mitigation for the only confusing case (mid-day move of a plant with dispatched
  work).
- **OQ-2: where does the surface live** — a tab in the OH Settings console (beside Plants) or a
  standalone page beside Plant Deactivations? Defaulting to whichever the v2 reference supports;
  flagging because it decides navigation.
- **OQ-3: make `reason` mandatory at the API** (recommended) or UI-only? API change is a breaking
  contract tweak for any existing curl usage.

## Cross-feature interaction notes (with #157 — company priority / plant ranking)

- **Under #157's recommended global model, zero interaction**: priorities are zone-independent, so
  a zone move changes which queues/dispatch runs see the plant but never which priority applies. No
  warning needed.
- **If #157's OQ-1 lands per-zone**, this UI must warn on zone change that zone-scoped priority
  rows for the plant/company exist under the old zone, and the pair of issues needs a joint
  decision (carry/clear/re-prompt). Sequencing: decide #157 OQ-1 **before** building #158 S3 so
  the warning is either built once or provably unnecessary.
- Shared posture: both features' engine reads stay on source-of-truth joins at run time; both rely
  on `audit_logs` (not history tables) as the trail; neither adds columns to any sync update set.
