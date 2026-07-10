# 115 — `.gitignore` `docs/*` rule leaves the entire doc set untracked (single-disk DR exposure)
Status: done
Type: HITL (policy decision — what is versioned vs deliberately kept out)

> **Resolved 2026-07-10** (commit `f5a7f90`), decision taken by the activation session under explicit
> owner authorization. **Chosen: fix-direction 1 — version the whole `docs/` tree.** The blanket
> `docs/*` ignore + `!docs/agents/` exception were removed; a fresh clone now contains the PRD, business
> workflow, all audits, architecture docs, ADRs, UI reference imagery (`docs/ui/**`, ~37 MB), the 49
> progress/handoff reports, and `SYSTEM-STATE-2026-07.md` — 155 doc files now tracked (was 4). Secrets
> remain excluded by the unanchored `.env` / `.env.*` rules (matched at any depth; no credentials live
> under `docs/`). Policy is recorded inline in `.gitignore` (the block replacing `docs/*`) and in
> `docs/agents/workflow.md` (Repo hygiene note).

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

- [x] A fresh clone contains (or a documented backup provides) the PRD, workflow, audits,
      architecture docs, and UI references. *All now tracked (155 doc files); pushed to origin.*
- [x] The chosen policy is recorded in CLAUDE.md or docs/agents/. *Recorded in `docs/agents/workflow.md`
      (Repo hygiene note) + inline in `.gitignore`.*
