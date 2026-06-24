# 46 — Company Update API + UI

Status: ready-for-agent
Type: AFK
Origin: Issue 02 deep review (2026-06-18) — closes the AC#3 "configurable" gap for companies.

## What to build

A way to **update** an existing company's commercial classification. `companies.service.ts` is
currently create-only, so `company_tier`, `company_priority_rank`, and `ops_override` are fixed at
creation — which makes CONTEXT.md's *"Operations Head can override per-company"* unsatisfiable and
leaves a mis-tiered company permanent.

- Add `PATCH /api/org/companies/:id` (Operations-Head-gated, audited `COMPANY_UPDATED` via
  `withAudit`) updating `companyTier`, `companyPriorityRank`, and `opsOverride`.
- Setting `opsOverride = true` is the mechanism for a manual override of CRM/SAP-sourced tier; record
  it in the audit metadata.
- Reuse the existing tier-enum + single-letter-rank validation from `create`.
- Admin: make the Companies table rows editable (tier dropdown + rank + override toggle) wired to the
  new endpoint.

## Acceptance criteria

- [ ] `PATCH /api/org/companies/:id` updates tier/rank/opsOverride; unknown id → 404; bad tier/rank → 400
- [ ] Every update writes one `COMPANY_UPDATED` audit row in the same transaction
- [ ] Admin Companies section can edit an existing company's tier/rank/override and reflects it on read
- [ ] e2e: create → update → list shows the new values; non-Operations-Head → 403

## Notes

- Consider whether `company_priority_rank` should be unique within a `(company_tier)` so the rank
  tie-break in Issue 10's canonical sort stays deterministic — raise during grilling, don't assume.
- No schema change required (`ops_override` column already exists).

## Blocked by

- #02
