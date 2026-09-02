# Shared primer — read before any S3 walk (L5). Measured 2026-09-02.

Running app verified: admin `http://localhost:5173` · backend `http://localhost:3000/api` ·
db `postgres://fsm@localhost:5433/fsm`. Backend build fingerprint `beea7d2-dirty` **== git HEAD**,
so evidence from the running app is evidence about current source.

Logins, password `correct-password` for all:
`zm.north@fsm.test` ZM zone1 · `zm.south@fsm.test` ZM zone2 · `csm@fsm.test` CSM ·
`ops.head@fsm.test` OH · `wm@fsm.test` WM · `se.north@fsm.test` SE

Cheap instrument (~2k TEQ vs ~708k for a browser walk):
```
node .claude/skills/scope-module-gaps/scripts/api-walk.mjs <ZM|ZM_SOUTH|CSM|OH|WM|SE> <METHOD> <path-without-leading-slash> ['{json}']
```
Git-Bash rewrites a leading `/` into the Git install path — pass `tickets`, not `/tickets`.

## Data density — what a walk can and cannot reach

| surface | rows | consequence for S3 |
|---|---|---|
| `GET /tickets` (ZM/CSM/OH) | **100** | walkable |
| `GET /dispatch-runs` (ZM) | **30** | walkable |
| `GET /engineers` (ZM) | **15** | walkable |
| `GET /schedules` (ZM) | **7** | walkable |
| `GET /verification/review` (ZM) | **0** | must create, or `UNTESTABLE` |
| `GET /vouchers` (ZM) | **0** | must create, or `UNTESTABLE` |
| `GET /warehouse/requests` (WM) | **0** | must create, or `UNTESTABLE` |
| `GET /cross-zone` (CSM) | **0** | must create, or `UNTESTABLE` |
| `GET /component-blocked` (ZM) | **0** | must create, or `UNTESTABLE` |
| `GET /me/tickets` (SE) | **0** | the SE persona has no day plan seeded — the SE half of every hand-off is `UNTESTABLE` until one is created |

**Never infer a pass from an empty list.** An empty queue proves nothing about its carrier: it is
equally consistent with "nothing qualified today" and "the carrier has never fired". Where a queue is
empty, either drive a real item into it through the app (≤3 records) or return `UNTESTABLE` naming the
fixture that would settle it (policy P19 — that seeds the next run).

## Already settled, free — do not re-walk these
- `GET /tickets` as WM ⇒ **403**; as SE ⇒ **403**. Role gating on the ticket list is real. `E4`.
- `POST /api/auth/login` with each of the six seeded accounts ⇒ 200 + a JWT carrying `role` and
  `zone_id` (ZM north = zone 1). `E4`.
- `GET /api/health` ⇒ `{"status":"ok"}`. `E4`.

## Static red flags already counted by `inventory-static.mjs` — confirm, don't rediscover
`auth-access` 3 endpoints with no `@Roles` + 1 `@Public` · `admin-config` 4 unguarded ·
`notifications` 3 unguarded. 248 endpoints inventoried across 14 modules.
Unguarded here means "no `@Roles` at handler or class" — the global `APP_GUARD` may still require a
valid JWT, so the finding is **role** scope, not necessarily anonymous access. Settle it by calling
the endpoint as the wrong role with `api-walk`, never by reading the decorator (policy P5).
- **Zone clamp is real.** `GET /tickets` as `zm.north` returns only `zoneId:1 / North`; as `zm.south`
  only `zoneId:2 / South`. Server-side, from the JWT's `zone_id`. `E4`, measured 2026-09-02.
  Do not re-walk the clamp on the ticket list; DO re-check it per module on any surface that joins
  across zones (reports, cross-zone, dispatch runs, ops-explorer).
