# engineers — walker primer (first walker, 2026-09-02). Read with `_shared-primer.md`.

**Where it lives.** Backend `apps/backend/src/engineers/` (+ `apps/backend/src/planner/` — the SE
Planner is engineers', not scheduling's; standing rule). Admin `apps/admin/src/pages/engineers/`
(`SeManagementPage`, `SeManagementDirectoryPage`, `LeaveRequestsPage`) and `pages/planner/`.
Mobile `apps/mobile/src/navigation/screens/{Availability,LeaveRequest,Profile}Screen.tsx`.

**Routes that matter.** `GET/POST/PATCH /engineers`, `GET /engineers/directory`, `GET /engineers/:seId`,
`POST /engineers/:seId/{availability,status,coverage}`, `GET /me/availability`,
`GET/POST /leave-requests`, `POST /leave-requests/:id/{approve,reject}`, `GET /me/leave-requests`,
`GET/POST/DELETE /planner`, `GET /planner/plants`.

**Personas.** `zm.north` = user `1111…1111` zone 1; `zm.south` = `1111…1112` zone 2;
`se.north` = `2222…2222`. **`se.north` is NOT an engineer_master row** — every SE-self path 404s
(ENG-G7). 15 engineers per zone; zone 1 ids start `11ad3b24` (Rahul Verma, 25 active tickets) and
`459b5409` (Sumit Chopra, 0 active tickets — the safe test subject); zone 2 starts `0bbe6100`.

**Check 6 is settled and CLEAN — do not re-walk it.** Every cross-zone and wrong-role probe was
refused server-side: out-of-zone engineer detail / PATCH / status → 404 `SE_NOT_FOUND`; out-of-zone
`POST availability` → 403; out-of-zone leave approve → 403 and the list is empty; out-of-zone planner
DELETE → 403; SE → another SE's availability 403; SE → `GET /engineers` 403; WM → `GET /engineers`
403; OH → leave approve 403 (OH reads all zones but is not a decision-maker, by design).

**Reading audit_logs.** There is no generic audit API — `/api/audit-trail` has exactly one route,
`tickets/:ticketId`. Query Postgres directly, read-only:
`postgresql://fsm:test123@localhost:5433/fsm` (`pg` lives in `apps/backend/node_modules`).
Baseline for this walk was `max(id) 34794`, 34,764 rows.

**Data I left behind (dev DB, deliberately dated 2026-10-05 → 10-08 so it cannot touch a live run):**
`leave_requests` 1 REJECTED / 2 APPROVED / 3 APPROVED and `se_availability` 1 WEEKLY_OFF /
2 ON_LEAVE / 3 AVAILABLE, all on Sumit Chopra `459b5409`. They were empty tables before. **These rows
are themselves the ENG-G4/ENG-G6 evidence** — leave them, and expect them in any future count.
`se_planner` was returned to its prior state (row 6 created then deleted).
