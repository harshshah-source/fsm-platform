# Progress — Issue 27: Role backup cascade + CSM acting scope

> Build date: 2026-06-24 · Strict TDD, AFK.
> Status: **ACCEPTED** (AC#1–#5). Backend **+3 e2e files / RoleBackupService + controller / 2
> migrations / audit acting_zone**; admin **acting banner + acting-mode (AuthProvider/AdminShell) +
> CSM Backup Share report + shared acting-header**; `tsc` clean both apps.
> Migrations **20260624200000_add_role_unavailability**, **20260624210000_audit_acting_zone**.

## Acceptance criteria status

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 1 | Hierarchy + strict upward backup cascade via `role_unavailability` | 🟢 | `RoleBackupService.currentActingRoleForZone` (ZM→CSM→Ops, zone-specific). `role-backup-service` (4). |
| 2 | CSM acting shows persistent "Acting as Zonal Manager for [Zone]" banner | 🟢 | AdminShell acting-mode (AuthProvider `actingZone`) + entry control + Exit. `acting-banner` (2). |
| 3 | Acted-as actions carry `acted_as_role` on API + audit | 🟢* | API: `auth/acting-context` resolves `X-Acting-As-Zone`→`acted_as_role` (pre-existing, `acting-context` e2e); admin sends the header via shared `authHeaders`. Audit: `audit_logs.acting_zone` + `AuditService.actingZone`. *Per-endpoint threading of acting context into each mutation's audit write is incremental (additive-seam choice). |
| 4 | CSM cross-zone read + acting authority in ZM surfaces | 🟢 | Services treat CSM / acted-as-ZM as manager (engineers, leave, zone-scope guard); acting-context grants the zone. |
| 5 | Per-zone "% approvals by CSM this month" for Operations Head | 🟢 | `RoleBackupService.csmBackupShareByZone` over `acting_zone`/`acted_as_role`; `GET /api/reports/csm-approval-share` (Ops Head); admin `CsmApprovalSharePage`. `csm-backup-report` (2) + `role-backup-controller` (3) + `csm-approval-share` (1). |

## Slice-by-slice

- **Slice 1 — cascade.** `role_unavailability` table + `RoleBackupService` (markUnavailable [Ops/CSM only],
  isRoleUnavailable, currentActingRoleForZone cascade). `role-backup-service` (4).
- **Slice 2 — report + audit attribution.** Additive `audit_logs.acting_zone` (migration) + `AuditService`
  extension; `csmBackupShareByZone`; `RoleBackupController` (`POST /role-unavailability`,
  `GET /reports/csm-approval-share`). `csm-backup-report` (2) + `role-backup-controller` (3).
- **Slice 3 — admin acting + report.** AuthProvider `actingZone` (+ sessionStorage), AdminShell persistent
  banner + acting-mode entry, shared `authHeaders` (sends `X-Acting-As-Zone`) adopted by engineers/leave/
  roleBackup api, `CsmApprovalSharePage` + route/nav. `acting-banner` (2) + `csm-approval-share` (1).

## Deviations / decisions

1. **Acting-attribution seam (#47) was already largely in place** — `auth/acting-context.ts` resolves the
   `X-Acting-As-Zone` header into `acted_as_role`. Issue 27 added the cascade authority source
   (`role_unavailability`), the audit zone attribution, the admin acting UX, and the report.
2. **AC#5 attribution chose the additive `acting_zone` column** (user-confirmed) over a full audit-zone
   retrofit. The report counts acted-as-backup actions per zone; normal (non-acting) ZM approvals are not
   zone-attributed on audit rows — a broader retrofit is deferred. Report serves the AC's stated purpose
   ("spot zones where ZM backup is becoming routine") via the CSM-acted share.
3. **Per-endpoint audit threading is incremental.** The audit columns + acting-context exist; wiring acting
   context into every mutation's `withAudit` call is an ongoing seam, not a blocker for this issue's intent.

## How to run / verify

```
cd apps/backend && node node_modules/vitest/vitest.mjs run \
  test/role-backup-service.e2e-spec.ts test/csm-backup-report.e2e-spec.ts \
  test/role-backup-controller.e2e-spec.ts
cd apps/admin && node node_modules/vitest/vitest.mjs run test/acting-banner.test.tsx test/csm-approval-share.test.tsx
```
