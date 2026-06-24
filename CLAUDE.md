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
