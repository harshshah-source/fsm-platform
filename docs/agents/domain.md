# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring.
This file **owns the authority hierarchy** — every other doc (CLAUDE.md, issue-tracker.md,
workflow.md) references it rather than restating it.

Layout: **single-context.** The repo now carries both docs and code — `apps/backend`,
`apps/admin`, `apps/mobile`, and `packages/shared` exist alongside `docs/`.

## Authority hierarchy (read in this order)

When sources conflict, the higher entry wins.

1. `CONTEXT.md` (repo root) — grilled domain model + Decisions. **Highest authority.** Where it
   disagrees with the PRD, CONTEXT.md wins (e.g. it drops the PRD's `VERIFICATION_PENDING_COMPONENT`
   literal and renames `CUSTOMER_MASTER` → `COMPANY_MASTER`, Customer Tier → Company Tier).
2. `docs/PRD-fsm-admin-dashboard.md` — product requirements.
3. `docs/workflow/fsm-business-technical-workflow.md` — end-to-end business & technical workflow.
4. Backend design docs:
   - `docs/backend/fsm-backend-low-level-design.md`
   - `docs/backend/fsm-database-schema-blueprint.md`
   - `docs/backend/fsm-db-schema-table-wise.md`
5. `docs/adr/` — numbered ADRs. **Historical context only — never authority.**

## UI authority

For any work touching a dashboard, page, screen, form, table, drawer, queue, report, or
navigation, authoritative UI references live under `docs/ui/` and slot into the hierarchy
**between workflow and existing code**:

`CONTEXT.md` → PRD → workflow → **UI reference images** → existing UI code → ADRs.

- Desktop: `docs/ui/desktop/v2-reference/` (authoritative). `docs/ui/desktop/v1-legacy/` is superseded.
- Mobile: `docs/ui/mobile/`.

The pre-implementation review rules for UI live in `docs/agents/workflow.md`. If an image and the
PRD conflict, follow the PRD and document the discrepancy.

## ADRs may be outdated

`docs/adr/` contains numbered ADRs. **Treat them as historical context, not authority** — several
predate the current CONTEXT.md/PRD/workflow and may contradict them. Do **not** use an ADR to
override CONTEXT.md, the PRD, the workflow, or the backend design docs. If an ADR conflicts with
those, follow the docs above and note the ADR as stale rather than reopening it.

## Use the docs' vocabulary

When your output names a domain concept (issue title, refactor proposal, hypothesis, test name), use
the term as defined in CONTEXT.md and the PRD/workflow — and respect CONTEXT.md's "Language" section
and the PRD's "Terminology" table (Use vs Avoid), e.g. "Zonal Manager" not "Zone Head", "Company" not
"Customer", "Snapshot" not "sync/refresh", "SE Activity Ping" not "heartbeat". If a concept isn't in
the docs yet, that's a signal: either you're inventing language the project doesn't use (reconsider)
or there's a real gap (note it).
