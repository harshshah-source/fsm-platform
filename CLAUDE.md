# CLAUDE.md

Project context for the FSM GPS Field Service Management platform (greenfield).
Two products — Admin Web Dashboard (React + TS + Vite) and SE Mobile App (React Native + Expo;
auth shell only so far) — over a NestJS modular-monolith backend (Postgres 16 + PostGIS + Prisma;
in-process `@nestjs/schedule` cron — no Redis/BullMQ/S3 in the current stack).
Current-state source of truth: `docs/SYSTEM-STATE-2026-07.md`.

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

### Parallel rounds

Several slices can be built at once by one agent each. `docs/agents/parallel-execution.md` owns the
rules — above all that **backend e2e runs cannot be parallelised on this box** (one `fsm_test`
database, a role that cannot `CREATE DATABASE`), so implementation is concurrent and verification is
serialised behind a mutex. `docs/agents/parallel-agent-brief.md` is the per-agent brief template.

### Workflow

Strategic HITL policy (AFK by default; stop only for architecture / business-rule conflict /
backlog-ownership / external-access / security events), the per-slice TDD report format, and the UI
reference rules live in `docs/agents/workflow.md`. The red-green-refactor protocol itself is the
`/tdd` skill — not restated in the docs. Authoritative UI references: `docs/ui/desktop/v2-reference/`,
`docs/ui/desktop/approved-designs/` (operator-approved directions for screens the v2 set never drew)
and `docs/ui/mobile/`.

## Progress & state convention (mandatory)

**Two living documents, no forks.** `docs/SYSTEM-STATE-2026-07.md` is the only current-state
document — when reality changes, edit its sections **in place**; never create a new
"current state" / "progress" / "status" doc. `.scratch/fsm-platform-v1/INDEX.md` is the only
work tracker — every session updates the issue statuses it touched **and appends one line to
the "Session log" table** in INDEX.md (date · what landed · commit hashes).

**Reading order for a new session:** `CLAUDE.md` → `docs/SYSTEM-STATE-2026-07.md` →
`.scratch/fsm-platform-v1/INDEX.md` → the issue file being worked.

**Handoff files** carry work across a session boundary. The live one is always
`docs/audits/handoffs/HANDOFF-ACTIVE.md` (there is only ever one), written from
`HANDOFF-TEMPLATE.md` beside it and refreshed as the slice progresses — not composed at the
last moment. That folder is also the audit trail: finished handoffs are renamed
`HANDOFF-<issue>-<date>.md` and stay in place rather than moving to `docs/archive/`. Opt in for a long slice with `/autohandoff on`: a `SessionStart` hook then
injects the handoff into every new session, so `/clear` mid-slice is safe, and a `PostToolUse`
hook forces the handoff once context passes 50%. Off by default. Both are described in
`docs/agents/workflow.md` ("Context budget and rolling handoff") and configured in
`.claude/context-budget.json`. `docs/archive/` is write-once history:
nothing in it is current; nothing in it gets updated. Per-issue TDD completion reports remain
`docs/progress/<issue>.md` — frozen once written; corrections go to INDEX/SYSTEM-STATE, not there.

## Surfacing rule (UI parity)

Backend and UI are **one vertical slice**, not two phases. An issue with UI/mobile acceptance criteria
is **not done** until those criteria are met *or* an explicit follow-up issue owns them (filed in
`.scratch/fsm-platform-v1/INDEX.md`). "Build the seam" applies to **external integrations**
(FCM/APNs/WhatsApp/SAP/AutoPlant) — **not** to admin pages or mobile screens that consume endpoints
already implemented in this repo.

**Before executing any issue that touches a dashboard, page, screen, form, table, drawer, queue,
report, or navigation:** read the authoritative reference image(s) under
`docs/ui/desktop/v2-reference/` then `docs/ui/desktop/approved-designs/` (desktop) or
`docs/ui/mobile/` (mobile — plain single `.png` extension) and follow the UI-discovery steps in
`docs/agents/workflow.md`. Match layout, hierarchy, role visibility, and navigation; do not redesign.

**Parity gate (hard stop before "done"):** an issue may not be marked done while leaving in-scope
UI/mobile ACs unbuilt unless (a) a follow-up issue is filed and linked in INDEX.md, **and** (b) the
deferral reason is an external-integration blocker — *not* "no app shell yet." A missing app shell is
a backlog gap to escalate (Strategic HITL: backlog-ownership), not a reason to defer silently.
