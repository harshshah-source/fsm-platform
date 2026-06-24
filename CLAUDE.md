# CLAUDE.md

Project context for the FSM GPS Field Service Management platform (greenfield).
Two products — Admin Web Dashboard (React + TS + Vite) and SE Mobile App (React Native + Expo) —
over a NestJS modular-monolith backend (Postgres 16 + PostGIS + Prisma, Redis/BullMQ, S3).

## Agent skills

### Issue tracker

Issues live as local markdown under `.scratch/<feature>/`. The active backlog is
`.scratch/fsm-platform-v1/`; its `INDEX.md` is the live source of build order and issue set
(never assume a fixed count). Follow-up issues and the accepted-with-follow-up rule are documented
in `docs/agents/issue-tracker.md`.

### Triage labels

Canonical five-role vocabulary, used verbatim (`needs-triage`, `needs-info`, `ready-for-agent`,
`ready-for-human`, `wontfix`); recorded as a `Status:` line in each issue file.
See `docs/agents/triage-labels.md`.

### Domain docs

Single-context. Authority order is `CONTEXT.md` → PRD → workflow → backend design docs → ADRs
(ADRs are historical only). `docs/agents/domain.md` owns the full hierarchy, including UI authority.

### Workflow

Strategic HITL policy (AFK by default; stop only for architecture / business-rule conflict /
backlog-ownership / external-access / security events), the per-slice TDD report format, and the UI
reference rules live in `docs/agents/workflow.md`. The red-green-refactor protocol itself is the
`/tdd` skill — not restated in the docs. Authoritative UI references: `docs/ui/desktop/v2-reference/`
and `docs/ui/mobile/`.

## Surfacing rule (UI parity)

Backend and UI are **one vertical slice**, not two phases. An issue with UI/mobile acceptance criteria
is **not done** until those criteria are met *or* an explicit follow-up issue owns them (filed in
`.scratch/fsm-platform-v1/INDEX.md`). "Build the seam" applies to **external integrations**
(FCM/APNs/WhatsApp/SAP/AutoPlant) — **not** to admin pages or mobile screens that consume endpoints
already implemented in this repo.

**Before executing any issue that touches a dashboard, page, screen, form, table, drawer, queue,
report, or navigation:** read the authoritative reference image(s) under
`docs/ui/desktop/v2-reference/` (desktop) or `docs/ui/mobile/` (mobile — note the `.png.png`
extension) and follow the UI-discovery steps in `docs/agents/workflow.md`. Match layout, hierarchy,
role visibility, and navigation; do not redesign.

**Parity gate (hard stop before "done"):** an issue may not be marked done while leaving in-scope
UI/mobile ACs unbuilt unless (a) a follow-up issue is filed and linked in INDEX.md, **and** (b) the
deferral reason is an external-integration blocker — *not* "no app shell yet." A missing app shell is
a backlog gap to escalate (Strategic HITL: backlog-ownership), not a reason to defer silently.
