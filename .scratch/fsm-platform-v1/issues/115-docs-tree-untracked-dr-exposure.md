# 115 — `.gitignore` `docs/*` rule leaves the entire doc set untracked (single-disk DR exposure)
Status: ready-for-human
Type: HITL (policy decision — what is versioned vs deliberately kept out)

> Source: SYSTEM-STATE-2026-07 audit (2026-07-10). Surfaced when committing the system-state
> document: `git add docs/SYSTEM-STATE-2026-07.md` was rejected by `.gitignore:21 docs/*`.

## Evidence

- `.gitignore:20-22` — "keep out business docs and internal planning, except versioned governance +
  active backlog": `docs/*` with only `!docs/agents/` whitelisted.
- `git ls-files docs` returns **4 files** (docs/agents/*). Everything else — the PRD (836 lines),
  the business workflow (2,253 lines), all four audits, all architecture docs, all 49 progress/
  handoff reports, the UI reference imagery — exists **only on this one Windows disk**.
- Same rule family as #114 (`data/` shadowing admin source), which is already filed.

## Production impact

A disk failure or accidental `docs/` deletion loses the platform's entire requirements +
audit + handoff record unrecoverably. Every agent-workflow rule (CLAUDE.md points at
`docs/agents/workflow.md`, UI parity points at `docs/ui/...`) references files that a fresh clone
does not have — a new machine cannot even run the documented process.

## Fix directions (pick one, HITL)

1. Whitelist the durable set (`!docs/PRD-*.md`, `!docs/workflow/`, `!docs/audits/`,
   `!docs/architecture/`, `!docs/ui/`, `!docs/SYSTEM-STATE-*.md`), keep scratch out; or
2. Keep the policy but establish an external backup target for `docs/`; or
3. Move the authoritative docs into the tracked backlog dir (`.scratch/fsm-platform-v1/` is
   whitelisted already).

## Acceptance criteria

- [ ] A fresh clone contains (or a documented backup provides) the PRD, workflow, audits,
      architecture docs, and UI references.
- [ ] The chosen policy is recorded in CLAUDE.md or docs/agents/.
