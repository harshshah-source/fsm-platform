# Progress — Issue 46: Company Update API + UI

> Build date: 2026-06-25 · Strict TDD (RED→GREEN→REFACTOR), AFK.
> Status: **DONE** — `PATCH /api/org/companies/:id` (Ops-Head, audited) + editable admin Companies
> rows. Closes Issue 02 AC#3 ("Operations Head can override per-company"). Backend **+1 service method
> / +1 PATCH route / +1 e2e**; admin **+1 api fn / editable row / +1 test**. Backend `tsc` clean;
> admin **77/77** + `tsc` clean. No migration (`ops_override` pre-existed).

## Acceptance criteria status

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 1 | `PATCH /api/org/companies/:id` updates tier/rank/opsOverride; unknown id → 404; bad tier/rank → 400 | 🟢 | `CompaniesService.update` reuses the create-path tier-enum + single-letter-rank validation (now per-field, partial), `NotFoundException` for unknown id. `company-update.e2e` (3). |
| 2 | Every update writes one `COMPANY_UPDATED` audit row in the same transaction | 🟢 | `audit.withAudit({ action: 'COMPANY_UPDATED', entityType: 'company_master', entityId: name, metadata: { ...new, previous } }, tx => tx.company.update(...))`. |
| 3 | Admin Companies section edits tier/rank/override and reflects it on read | 🟢 | `CompanyRow` inline edit (tier `<select>` + rank input + ops-override checkbox + Save/Cancel) → `org.updateCompany` → row replaced from the PATCH response. `settings.test` (Issue 46 case). |
| 4 | e2e: create → update → list shows new values; non-Operations-Head → 403 | 🟢 | `company-update.e2e`: POST→PATCH→GET reflects PLATINUM/A/override; ZM PATCH → 403 (the `@Roles('OPERATIONS_HEAD')` class gate). |

## Slice-by-slice RED→GREEN report

- **Slice 1 — backend update.** `UpdateCompanyInput` (partial) + `CompaniesService.update(companyId,
  input, actor)` (validate provided fields, 404 unknown, audited `COMPANY_UPDATED` with `previous`
  snapshot) + `@Patch(':id')` on the Ops-Head-gated `CompaniesAdminController`. RED = no PATCH route
  (3 fail). `company-update.e2e-spec` (3) GREEN.
- **Slice 2 — admin editable row.** `org.updateCompany` api fn + `CompanyRow` component (inline edit
  with per-row aria-labelled tier/rank/override controls; optimistic row replace on save). RED = static
  read-only rows. `settings.test` Issue-46 case GREEN; the existing create/list/role-gate cases stay
  green.

## Deviations / decisions

1. **`opsOverride` is the manual-override mechanism.** Setting it `true` flags a company whose tier was
   hand-overridden away from CRM/SAP source; captured in the audit metadata alongside the `previous`
   classification for a full change trail.
2. **No uniqueness constraint added.** The spec's open question (unique `company_priority_rank` within
   a tier for deterministic Issue-10 tie-break) was left as-is — no schema change, matching the spec's
   "no schema change required" note. Flagged here rather than assumed.
3. **Validation reused, made per-field.** The same `TIERS` set + single-letter `RANK` regex as `create`
   apply only to fields actually present in the partial update.

## Parity-gate disposition

- **Both surfaces built in-issue:** backend PATCH endpoint + admin editable Companies rows. **Mobile:
  n/a.** No deferrals — Issue 46 fully closed.

## How to run / verify

```
cd apps/backend && node node_modules/vitest/vitest.mjs run test/company-update.e2e-spec.ts
cd apps/admin && node node_modules/vitest/vitest.mjs run test/settings.test.tsx
```
