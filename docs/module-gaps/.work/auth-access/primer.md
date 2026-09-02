# auth-access primer (first walker, 2026-09-02) — read with `_shared-primer.md`

Login: `POST http://localhost:3000/api/auth/login` `{email, password:"correct-password"}` → `{accessToken, refreshToken}`.
Claims are `{user_id, role, zone_id, iat, exp}`, ~15 min life. **No acting claim** — acting is a header.

Where the module lives: backend `apps/backend/src/auth/` + `apps/backend/src/roles/` +
`apps/backend/src/common/{manager-scope.ts,request-actor.ts,decorators/current-scope.decorator.ts}`;
admin `apps/admin/src/auth/AuthProvider.tsx`, `components/shell/{TopBar,AppShell,Sidebar}.tsx`.

**`api-walk.mjs` cannot send `X-Acting-As-Zone`.** Anything about acting needs a fetch that adds the
header after logging in — a ~25-line node script (mine lived in the session scratchpad, not the repo).

DB read (no `psql` on this box, no docker): import `pg` by absolute `file:///C:/fsm-platform-backup/apps/backend/node_modules/pg/lib/index.js`
and connect to `postgresql://fsm:test123@localhost:5433/fsm`. Table names are snake_case
(`audit_logs`, `role_unavailability`); Prisma model fields are NOT the column names.

Seeded state, measured:
- `role_unavailability` — **0 rows**. Every ZM is present, so any acting seen live is ungated.
- `audit_logs` — 34,758 rows; `acted_as_role` non-null on **1**; `acting_zone` non-null on 31, of
  which 30 are `BULK_UNASSIGN_ZONE` (that column means "target zone" there, not "acting zone").
- Zero rows for any LOGIN / LOGOUT / AUTH / SESSION / ACTING action.
- Zones 1 North, 2 South (ZM "Alla Lokesh"), 3 East, 4 West, 5 UNZONED.

Acting is honoured by five controllers only (`@CurrentScope`): dashboard, reports, batches,
dispatch-today, schedules. `GET /tickets`, `GET /dispatch-runs` and every write ignore it.
`GET /ops-explorer/meta` is the cheap **positive control** — OH only (CSM gets 403), and it writes a
correctly stamped acting audit row, so it proves the seam works when a fresh walk needs a baseline.

Records this walk changed: ticket `f1978011-8112-4ad1-a44f-fbd8669d1ce7` closed
`CLOSED_AUTO_RECOVERY` (audit `#34793`); one ops-explorer access row (`#34794`).
