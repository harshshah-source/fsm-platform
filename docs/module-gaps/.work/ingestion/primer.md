# ingestion primer — first walker, 2026-09-02. Read before any further ingestion walk.

**DO NOT FIRE A RUN.** No sync, pipeline or snapshot trigger. It rewrites device state and ticket
data under every parallel walker. Call trigger endpoints only as an unauthorised role, for the 403.

Login: `node .claude/skills/scope-module-gaps/scripts/api-walk.mjs <ROLE> <METHOD> <path-no-leading-slash>`
(script truncates output at 2500 chars — pipe through `sed -n` for tails of a big payload).

## Where the module lives
- backend `apps/backend/src/ingestion/` (+ `autoplant/`), `apps/backend/src/device-departure/`
- admin `apps/admin/src/api/{snapshots,integrationHealth}.ts`,
  `components/SnapshotBanner.tsx` (mounted above EVERY route at `AppRoutes.tsx:62`),
  `pages/admin/BuildHealthPage.tsx`

## Endpoints and role gates — all measured E4, do not re-walk
| endpoint | OH | ZM | CSM | WM | SE |
|---|---|---|---|---|---|
| `GET integration/health` | 200 | 403 | 403 | 403 | 403 |
| `GET snapshots/latest` | 200 | 200 | 200 | **403** | **403** |
| `GET snapshots/runs` | 200 | 403 | — | 403 | 403 |
| `POST snapshots/run` | *not called* | 403 | 403 | 403 | 403 |
| `POST integration/run-pipeline` · `sync-masters` | *not called* | 403 | 403 | — | — |

## Seeded state as of 2026-09-02
Last SUCCESS snapshot run 169: started 2026-09-01T11:55:01Z, dataAsOf 12:00:08Z — **~25 h stale**,
and the banner renders it as the calm grey healthy line. `snapshots/runs` holds 50 rows.
Live health payload: `reconciliation.reconciled false` (vehicles drift -15594), `lifecycle.healthy
false` (drift 71, missingFromSource 3376, quietRuns 0), 43 988 source vehicle rows, 15 recompute rows.

## Two traps
1. The running backend has **no `ingestion` key** in the health payload — #300 (`ingestion-alert.ts`)
   is uncommitted and untracked. Measure wedge-alert claims against source, not the live app.
2. Auto-recovery of INACTIVE→ACTIVE tickets lives in **`ticketing`** (`auto-recovery.service.ts`,
   status `CLOSED_AUTO_RECOVERY`), not here. Grepping only the `ingestion` tree reads it as absent.
