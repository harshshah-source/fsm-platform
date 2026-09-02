> **CAVEAT (measured 2026-09-02):** the `audit` column follows only ONE delegation hop — it reports "no" whenever the audit write sits in a shared private helper. Verified false-positive rates: scheduling 11/11, tickets 8/10, cross-zone 6/6, vouchers 0/0, ingestion 0/3. Error is one-directional (under-detects, never invents), so "yes" is trustworthy and every "no" must be checked at `file:line`. The `guard` column can be off by one decorator. Never infer a UI facade from skeleton.md "no data hook" — admin pages use `useEffect` + `apps/admin/src/api/`, not react-query.

# static facts — Auth, Roles & Acting-Scope (auth-access)
columns: guard = @Roles/@Public on the handler · audit = withAudit/record/auditLog.create in the reached service · status = writes a *status/state* field · tx = $transaction

| endpoint | file:line | guard | audit | status-write | tx |
|---|---|---|---|---|---|
| `POST /api/auth/login` | apps/backend/src/auth/auth.controller.ts:21 | **PUBLIC** | no | no | no |
| `POST /api/auth/refresh` | apps/backend/src/auth/auth.controller.ts:34 | **none** | no | no | no |
| `POST /api/auth/logout` | apps/backend/src/auth/auth.controller.ts:43 | **none** | no | no | no |
| `POST /api/role-unavailability` | apps/backend/src/roles/role-backup.controller.ts:41 | 'OPERATIONS_HEAD','CENTRAL_SERVICE_MANAGER' | no | no | no |
| `GET /api/reports/csm-approval-share` | apps/backend/src/roles/role-backup.controller.ts:59 | 'OPERATIONS_HEAD' | no | no | no |
| `GET /api/me` | apps/backend/src/me/me.controller.ts:15 | **none** | no | no | no |

**totals:** 6 endpoints · 3 with no @Roles at handler or class · 1 @Public · 4 write-verb endpoints with no audit write in the reached method

## prisma models plausibly owned (name match on module keywords)
_no model name matched the slug — surveyor must map by hand_

## spine edges owned by this module
_SPINE.md exists but names no edge for this module_

## env flags referenced in this module
- `JWT_ACCESS_SECRET`
