# admin-config primer — first walker, 2026-09-02 (read `_shared-primer.md` first)

**Where the module lives.** Admin: `apps/admin/src/pages/settings/` (SettingsPage + sections.tsx tabs),
plus `pages/admin/PlantZonesPage.tsx`, `TierOverridesPage.tsx`, `AssignmentThresholdPage.tsx`,
`BuildHealthPage.tsx`, `pages/ops-explorer/`. Backend: `apps/backend/src/org/`, `settings/`,
`plant-deactivation/`, `ops-explorer/`, `audit/`.

**Log in** with the six seeded accounts in `_shared-primer.md`, password `correct-password`.
Nearly everything here is **OPERATIONS_HEAD only** — walk as `OH` to see anything, and as
`ZM`/`CSM`/`WM` to prove the fence. `ops.head@fsm.test` is the module's persona.

**Live values on this box (2026-09-02, do not assume they are still these):**
- `GET /api/settings` as OH returns 12 keys; `se_assignment_threshold_hours` = **48**, not locked,
  `eligibility_mode` = `all-deployed`, `dispatch_cron` = `0 5 * * *`.
- `GET /api/org/users` as OH → ~90 rows (5 mock ZMs, 75 mock SEs, the 6 fixtures) **plus one
  disposable row I created and disabled**: `surveyor.disposable.20260902@fsm.invalid`,
  `ZZ Surveyor Disposable DELETE ME`, WAREHOUSE_MANAGER, DISABLED. Ignore it; there is no DELETE
  verb and no `psql`/`docker` on this box to remove it.
- `GET /api/plants/deactivations` as OH → **6 rows**, all still deactivated (none reactivated).
- `GET /api/ops-explorer/meta` as OH → `enabled: true, developerMode: true, roles:[OPERATIONS_HEAD]`.
  The Ops Explorer is ON here, so the `auditLogs` dataset is queryable — the only audit lens in the app.
- `GET /api/dispatch-runs` as OH → 30 runs; run 36 (MANUAL, 2026-09-02) has a full `configSnapshot`.

**Reading the audit trail** (the only way, and OH only):
`api-walk.mjs OH POST ops-explorer/datasets/auditLogs/query '{"search":"SETTING","pageSize":5}'`.
It returns action/entityType/entityId/actorId/actorRole/createdAt — **never the old or new value**.

**Do not** deactivate a plant, move the assignment threshold, or change SLA/tier rules while other
walkers are live. To probe a write permission safely, send an **empty body**: a 403 proves the guard,
a 400 proves the role got through — and neither mutates anything.
