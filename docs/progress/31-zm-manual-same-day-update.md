# Progress — Issue 31: ZM manual same-day update + ON_SITE conflict warning

> Build date: 2026-06-25 · Strict TDD (RED→GREEN→REFACTOR), AFK.
> Status: **ACCEPTED (core)** — ZM same-day add / remove / reorder + Intra-day Queue (backend + admin)
> complete. Mobile SE highlight / removed-label (AC#5) → follow-up **66** (blocked-by Mobile
> Foundation #54). Backend **+3 e2e files / +1 controller / +1 service**, admin **+1 page / +1 api /
> +1 test**. Backend **474/474** e2e + `tsc` clean; admin **74/74** + `tsc` clean. No new migration —
> the Intra-day Queue is a **view over AuditLog** (decision below).

## Acceptance criteria status

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 1 | ZM can add / remove / reorder Tickets on an SE's current Day Plan; applies immediately | 🟢 | `SameDayUpdateService.addTicket` (→ FORMALLY_ASSIGNED), `removeTicket` (→ UNASSIGNED, back to Shared Pool), `reorder`. Reuses the Issue 13 override engine. `same-day-update-service` (4) + `same-day-update-remove-reorder` (3). |
| 2 | No SE Acceptance required; SE receives "plan updated by [ZM]" push | 🟢 | No acceptance gate on the same-day path; `notifier.dayPlanOverridden` fires on every op. Push **delivery** is the notification seam (Issue 03). Admin queue shows "No acceptance required". |
| 3 | Removing an ON_SITE Ticket → conflict warning + mandatory reason code (audited) | 🟢 | The engine's ON_SITE gate flows through unchanged: `CONFLICT_ON_SITE` without `confirm`; on `confirm:true` an `OVERRIDE_AFTER_ON_SITE` audit row + the change commit. HTTP → 409 `UPDATE_ON_SITE_CONFLICT`. `same-day-update-remove-reorder` (3). |
| 4 | Intra-day Queue logs a `MANUAL_ZM_UPDATE` row (ZM, action, ticket, timestamp) | 🟢 | Every same-day op audits `action = MANUAL_ZM_UPDATE` with `metadata.updateType` (ADD/REMOVE/REORDER) + `seId`. `listIntradayUpdates` is the zone-scoped queue read. Admin **Intra-day Queue** page (`/intraday`, v2-reference/13). `intraday-updates-controller` (4) + `intraday-queue.test` (2). |
| 5 | SE app highlights added Tickets + shows a one-session "removed" label | 🟡 mobile | **Issue 66** (blocked-by Mobile Foundation #54). The backend signal (per-SE same-day adds/removes) is already queryable. |

## Slice-by-slice RED→GREEN report

- **Slice 1 — same-day ADD.** `SameDayUpdateService.addTicket` delegates to `override.assignTicket`
  with a new `auditAction` param (default `CRITICAL_ASSIGN` preserved) → tags the row `MANUAL_ZM_UPDATE`
  / `updateType: ADD`. `listIntradayUpdates` reads the AuditLog view, zone-scoped (ZM own-zone via the
  ticket's plant). RED = missing service module. `same-day-update-service.e2e-spec` (4) GREEN.
- **Slice 2 — same-day REMOVE + REORDER.** `removeTicket` / `reorder` delegate to `override.override`
  with the `auditAction` tag threaded through `removeTicket`/`reorder`/`auditEntry` (normalises
  `REMOVE_TICKET → REMOVE`). ON_SITE conflict gate preserved (confirm + reason). Batch-entity rows are
  zone-scoped via the batch's schedule. `same-day-update-remove-reorder.e2e-spec` (3) GREEN.
- **Slice 3 — HTTP.** `IntradayUpdatesController` (`/api/intraday-updates`): `GET` queue read
  (manager-roled, SE → 403), `POST add|remove|reorder` (400 on missing reason/ids, 404 unknown, 409
  `UPDATE_ON_SITE_CONFLICT`). `intraday-updates-controller.e2e-spec` (4) GREEN.
- **Slice 4 — admin UI.** `IntradayQueuePage` (`/intraday`, v2-reference/13-intraday-queue): update-type
  metric strip + table (Event / Ticket / SE / SE-Acceptance / By / At); RoleRoute-gated to manager
  roles; the existing "Intra-day" nav placeholder now links here. `intraday-updates.ts` api client.
  RED = missing page module. `intraday-queue.test.tsx` (2) GREEN.

## Deviations / decisions (read before extending)

1. **Intra-day Queue = view over AuditLog (HITL 2026-06-25).** No new model. Same-day updates audit
   `action = MANUAL_ZM_UPDATE` (`metadata.updateType` ∈ ADD/REMOVE/REORDER, `seId`). The decision keeps
   the Intra-day Queue substrate from pre-empting **Issue 29** (system CRITICAL insertion), which will
   write its own rows (with the SE-Acceptance lifecycle) into the **same** view. The admin page already
   carries an "SE Acceptance" column (showing "No acceptance required" for manual updates) so Issue 29's
   acceptance states slot in without a redesign.
2. **Reuse, don't fork, the override engine.** `assignTicket` / `override` gained one optional
   `auditAction` param (defaults preserve `CRITICAL_ASSIGN` / `BATCH_OVERRIDE_*`); same-day ops pass
   `MANUAL_ZM_UPDATE`. Existing override/critical-assign e2e specs unchanged and green — no behavioural
   regression. Only REMOVE_TICKET / REORDER honour the tag (the actions Issue 31 needs).
3. **ON_SITE conflict is the engine's, surfaced unchanged.** AC#3 needed no new code — the same-day
   remove inherits `CONFLICT_ON_SITE` + confirm + `OVERRIDE_AFTER_ON_SITE` audit. Proven via a
   conflict-port stub on the same-day path.
4. **Notifications seamed.** "plan updated by [ZM]" push is recorded via the notifier; external delivery
   (push/WhatsApp) is the notification spine (Issue 03, HITL).

## Parity-gate disposition (CLAUDE.md / workflow.md)

- **Admin surface built** in-issue: Intra-day Queue page (net-new, v2-reference/13-intraday-queue),
  manager-gated, nav-linked.
- **Mobile surface** (AC#5 SE highlight added Tickets + one-session "removed" label): **Issue 66**,
  `blocked-by #54` (Mobile Foundation). Tracked, not silently deferred.

## Follow-ups (filed)

- **Issue 66** — SE mobile Day Plan: highlight ZM-added Tickets + one-session "removed" label → 31, 54.

## How to run / verify

```
cd apps/backend && node node_modules/vitest/vitest.mjs run \
  test/same-day-update-service.e2e-spec.ts test/same-day-update-remove-reorder.e2e-spec.ts \
  test/intraday-updates-controller.e2e-spec.ts
cd apps/admin && node node_modules/vitest/vitest.mjs run test/intraday-queue.test.tsx
```
