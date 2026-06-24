# Agent Workflow

How an agent should execute work on this repo: when to keep going vs. stop (HITL), how to report
TDD slices, and how to treat the UI references. This file **owns** these three policies; `CLAUDE.md`
points here rather than restating them.

- Authority hierarchy and UI authority order: `docs/agents/domain.md`.
- Backlog, follow-ups, accepted-with-follow-up: `docs/agents/issue-tracker.md`.
- Triage label strings: `docs/agents/triage-labels.md`.
- The red-green-refactor protocol itself: the `/tdd` skill (`.claude/skills/tdd/`). Do not duplicate it.

## Strategic HITL policy

**Default mode is AFK — keep going.** "HITL" on an issue here means *blocked on a human-only input*
(external access, a genuine decision), **not** "needs per-step approval." An issue can be labelled
HITL and still be implemented by an agent; the label flags the blocker, not the author.

**Continue autonomously — do not stop for:** naming, DTO design, endpoint structure, component
organization, test strategy, validation details, or unavailable local infrastructure
(Redis, SMTP, FCM, APNs, WhatsApp). Build the seam: interfaces, adapters, mocks, placeholders, and
TODO integration points. Document assumptions inline and keep going. Do not ask permission between
slices.

**Scope of "build the seam":** it covers *unavailable external infrastructure only* (Redis, SMTP,
FCM, APNs, WhatsApp, SAP, AutoPlant). It does **not** cover an admin page or mobile screen whose
backend endpoint already exists in this repo — those are buildable surfaces, and deferring them
requires a tracked follow-up issue (see the Parity gate under "UI reference system"), not a seam.

**Stop only for a Strategic HITL event:**

- **Architecture decision** — a choice that would materially alter system architecture, service
  boundaries, aggregate ownership, the event model, or database ownership.
- **Business-rule conflict** — authoritative docs disagree (CONTEXT.md / PRD / workflow / issue
  definition). Document the conflict and stop.
- **Backlog-ownership change** — work requires moving ownership between issues, splitting, merging,
  or resequencing the roadmap. Recommend a solution and stop.
- **External access required** — credentials, production access, vendor provisioning, or
  infrastructure provisioning. **Complete all code possible first** (build to the seam); stop only
  at the final integration boundary.
- **Security decision** — changes to the auth model, authorization model, encryption, secrets
  handling, or production-data access. Stop for review.

The two HITL slices are `01` (foundation/infra: CI needs a git remote, PostGIS install, dep installs
behind FortiGate) and `03` (notifications: FCM/APNs/WhatsApp accounts + template approval). Keep both
marked HITL in `INDEX.md`. Everything else is AFK (`ready-for-agent`).

## TDD execution and per-slice report

All implementation is strict TDD via the `/tdd` skill — vertical tracer-bullet slices,
RED → GREEN → REFACTOR, one test at a time. **Never refactor while RED. Do not skip RED.**

After each slice, report:

- **AC targeted** — which acceptance criterion this slice advances.
- **RED** — the failing test and its failure.
- **GREEN** — the minimal implementation that passed it.
- **REFACTOR** — what was cleaned up (or "none").
- **Tests / typecheck** — counts and result for each affected package.
- **Remaining work** — what's left on the AC.

If RED was skipped, stop and redo the slice test-first.

## UI reference system

For any issue touching a dashboard, page, screen, form, table, drawer, queue, report, navigation, or
workflow UX, the reference images are **authoritative inputs** (authority order in
`docs/agents/domain.md`):

- Desktop: `docs/ui/desktop/v2-reference/` (authoritative). `docs/ui/desktop/v1-legacy/` is superseded.
- Mobile: `docs/ui/mobile/`.

**File-name robustness:** mobile reference files carry a **double `.png.png` extension** (e.g.
`home-dashboard.png.png`, `verification.png.png`). Reference and open them by their on-disk name —
do not assume a single `.png`.

### UI discovery (before any UI implementation)

1. Identify the relevant reference image(s).
2. Analyze the image structure (layout, sections, hierarchy).
3. Map image sections to the issue's acceptance criteria.
4. Identify reusable components already in `apps/admin` / `apps/mobile`.
5. Produce an implementation plan.
6. Begin TDD.

When images exist, match layout, information hierarchy, page composition, role visibility, and
navigation behavior. **Do not redesign pages** unless explicitly instructed. If an image and the PRD
conflict, follow the PRD and document the discrepancy.

### UI regression (when modifying an existing page)

Preserve layout, navigation, role visibility, and terminology. No opportunistic redesigns —
feature implementation and redesign are separate activities.

### Parity gate (per-issue, not a phase switch)

An issue carrying in-scope UI or mobile acceptance criteria cannot be marked done with those ACs
deferred unless **both**: (a) a follow-up issue owning them is filed and linked in `INDEX.md`, and
(b) the blocker is a true external integration. "No app shell yet" is not a valid deferral reason —
it is a backlog-ownership Strategic HITL event. Record the disposition in the issue's progress doc.

This is a **per-issue gate, not a phase switch**: backend-led TDD continues unchanged. The gate only
prevents an implemented backend slice from shipping with its admin/mobile surface silently dropped.
