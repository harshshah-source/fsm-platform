# intraday primer — first walker, 2026-09-02. Read before any further intraday walk.

Login: see `_shared-primer.md` (password `correct-password` for all six personas).
Instrument: `node .claude/skills/scope-module-gaps/scripts/api-walk.mjs <ROLE> <METHOD> <path> ['{json}']`.

Where the module lives:
- backend `apps/backend/src/intraday/` (`/api/intraday-insertions/*`) plus
  `apps/backend/src/scheduling/intraday-updates.controller.ts` (`/api/intraday-updates/*`).
- admin `apps/admin/src/pages/schedules/IntradayQueuePage.tsx` (+ `IntradayManualAssignModal.tsx`).
- same-day plan edits actually go through `POST /api/batches/:id/override`, not `/intraday-updates`.

Data density (measured, E4):

| read | rows |
|---|---|
| `GET /intraday-insertions` as `zm.north` | 552 (all zoneId 1) |
| same as `zm.south` | 159 (all zoneId 2) |
| same as `csm` / `ops.head` | 1936 (zones 1-5) |
| `GET /intraday-updates` as any manager | **0** — surface never exercised |

Status distribution across all 1936: `ASSIGNED_DIRECT` 1163, `ESCALATION_REQUIRED` 773, nothing else.
**No row is in `PENDING_ACCEPTANCE`, `DECLINED` or `TIMED_OUT`** — the retired states are schema-only.
`declineReasonCode` null, `retryCount` 0, `whatsappSent` false on every row.

Role gate (E4, do not re-walk): `se.north` and `wm` get **403** on all six intraday routes.
Zone clamp is server-side and holds on both read and write: `zm.south` `manual-assign` on a zone-1
row -> 404. `GET :id/available-ses` answers a foreign or missing id with `200 []`, not an error.

Standing law: the SE accept/decline/timeout/retry mechanic is RETIRED (CONTEXT.md §21, #268/#279).
Never file "SE cannot decline a stop". The PRD is stale here.
