# 114 — `.gitignore` `data/` rule shadows the admin core UI source dir (`apps/admin/src/components/data/`)
Status: ready-for-agent
Type: AFK

> Source: 2026-07-08, surfaced while committing the admin "Run Ingestion Now" + rolling-KPI feature.
> A new file (`components/data/RollingNumber.tsx`) and edits to `components/data/Toast.tsx` /
> `index.ts` were invisible to `git status`; the feature could only be committed by force-adding those
> paths. This is almost certainly the root cause of the standing **"branch tip doesn't build alone"**
> handoff/memory note for `feat/autoplant-integration` — an entire directory of core admin components
> is untracked, so a clean checkout is missing them.

## Evidence

The `.gitignore` `data/` rule (a broad, unanchored pattern intended for an artifact/data directory)
also matches the admin source dir `apps/admin/src/components/data/`:

```
$ git check-ignore -v apps/admin/src/components/data/index.ts
.gitignore:26:data/	apps/admin/src/components/data/index.ts
```

`.gitignore` around line 26:

```
.claude/
data/
backups/
```

The whole component directory is consequently untracked — `git ls-files` returns nothing for it, even
though it holds core, app-wide UI (`MetricStrip`, `Toast`, `DataTable`, `PageHeader`, `DateRangeChips`,
`FilterBar`, `feedback`, `index.ts`, and now `RollingNumber`):

```
$ git ls-files apps/admin/src/components/data/
（empty）
```

Because `App.tsx` mounts `ToastProvider` from this dir and virtually every page imports `MetricStrip`/
`PageHeader`/`DataTable` from it, a fresh clone of the branch tip **cannot build the admin app** — which
matches the known **"branch tip doesn't build alone"** note carried in the handoff/memory for this
branch. The ignored `data/` dir is the likely root cause of that note, not a separate quirk.

`backups/` on the next line is the same class of unanchored pattern and should be audited for the same
shadowing (no `apps/**/backups/` source dir exists today, but the pattern is equally broad).

**Candidate cleanup (fold-in):** the admin vitest run emits two pre-existing *unhandled* errors
(`TypeError: zones.reduce is not a function` at `apps/admin/src/pages/dashboard/ZmDashboard.tsx:45`),
raised by the route-gating tests `test/cross-zone.test.tsx` and `test/zm-scorecard.test.tsx` when they
mount the dashboard with a fetch stub that yields a non-array for `zone-overview`. The tests still
pass, but the KPI `useMemo` in `ZmDashboard`/`OpsHeadDashboard` assumes `zones`/`critical` are always
arrays. Trivial to fix at the data boundary (default to `[]` / `Array.isArray` guard, or correct the
two stubs) — folded here rather than filed separately.

## Root cause

The `data/` line has no leading `/` and no path anchor, so Git treats it as "ignore any directory named
`data` at any depth" — which sweeps up `apps/admin/src/components/data/`. The pattern was meant for a
top-level artifact/data directory, not a source path that happens to be named `data`.

## What to build

1. Re-scope the ignore rule so it stops matching source paths — anchor it to the intended location
   (e.g. `/data/` at the repo root, or the specific artifact path), and audit `backups/` the same way.
2. Once un-ignored, `git add` the previously-untracked `apps/admin/src/components/data/` source files
   so the admin app builds from a clean checkout — this is the concrete close-out of the
   "tip doesn't build alone" note.
3. Sweep for any other source directory shadowed by an unanchored pattern (`git check-ignore` over the
   `apps/**` and `packages/**` trees) and re-scope those too.
4. Fold-in cleanup: make the dashboard KPI derivations tolerate a non-array data source (or fix the two
   route-gating test stubs) so the two `zones.reduce` unhandled errors disappear from the vitest run.

## Acceptance criteria

- [ ] `git check-ignore apps/admin/src/components/data/index.ts` returns nothing (path no longer ignored).
- [ ] `git ls-files apps/admin/src/components/data/` lists every component source in the dir.
- [ ] A fresh checkout of the branch installs and builds the admin app with no missing-module errors, and `apps/admin` `tsc`/`vitest` pass — i.e. the tip builds alone (closes the handoff/memory note).
- [ ] No unanchored ignore pattern matches any tracked-intent source dir under `apps/**` or `packages/**` (verified via `git check-ignore`).
- [ ] The two `zones.reduce is not a function` unhandled errors no longer appear in the `apps/admin` vitest output; the admin suite stays green.

## UI surfaces
n/a (repo tooling + a defensive guard in existing dashboard code; no visual change)

## Reference
n/a

## Blocked by
None. **Session constraint:** the `.gitignore` edit was deliberately deferred by the filing session
(the "Run Ingestion Now" feature commit only force-added its own `data/` files; `.gitignore` was left
untouched). The agent picking this up owns the actual rule change and the bulk `git add`.
