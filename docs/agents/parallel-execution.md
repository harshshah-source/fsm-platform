# Running slices in parallel

How to run several implementation agents at once in this repo without corrupting the tree or the test
database. Written 2026-09-03 after a round of ten; the failures described here are ones that actually
happened, not hypotheticals.

Read with `docs/agents/workflow.md` (the per-slice rules) — this file only covers concurrency.

---

## 1. The one hard constraint: there is a single test database

`apps/backend/test/global-setup.ts` runs **once per vitest invocation** and does
`prisma migrate deploy` → **truncate** → seed org reference data → seed the auth fixture users.
The database it targets comes from `test/test-db-url.ts`: `TEST_DATABASE_URL` if set, else
`DATABASE_URL` with `_test` suffixed onto the database name.

**On this box the `fsm` Postgres role is not a superuser and cannot `CREATE DATABASE`** (verify with
`select usesuper, usecreatedb from pg_user where usename = current_user` — both false). So:

- **Two backend suites cannot run at the same time.** The second run's `globalSetup` truncates the
  first run's seeded users out from under it.
- **The symptom is not a clear error.** It is dozens of unrelated files failing with
  `expected 200 "OK", got 401 "Unauthorized"` at their `login()` helper — which looks exactly like a
  real auth regression. One session burned three full suite runs (~45 minutes) before recognising it.
- `TEST_DATABASE_URL` *would* give each agent its own database, if the role could create one.
- Per-**schema** isolation is half-possible — `CREATE SCHEMA` succeeds — but **PostGIS is installed in
  `public`**, so every geography migration would need search-path surgery. Not attempted; if you try
  it, prove `prisma migrate deploy` works into a non-public schema before relying on it.

**Admin tests are unaffected** (jsdom, no database) and can run freely in parallel.

So: parallelise *implementation*, serialise *backend verification*.

---

## 2. Git discipline: agents do not touch the index

Ten agents racing `git add`/`git commit` in one working tree will collide on `.git/index.lock` and
will cross-stage each other's files. The rule that worked:

> **Agents run no state-mutating git.** No `add`, `commit`, `checkout`, `stash`, `restore`, `reset`.
> Read-only git is fine. Each agent reports the exact list of paths it touched, and the **orchestrator
> commits each slice by explicit path** after inspecting its diff.

This also gives the orchestrator a real review gate per slice, which is where several premise
corrections were caught.

**Check each file's diff for a second author before staging.** Ownership assignment is necessary and
not sufficient — see §5.

---

## 3. The backend-test mutex

`mkdir` is atomic, so it is the lock. Recreate this at `.scratch/locks/backend-test.sh`
(`.scratch/locks/` is gitignored, so it does not survive a fresh clone) and `chmod +x` it:

```bash
#!/usr/bin/env bash
# Serialises backend e2e runs — see docs/agents/parallel-execution.md §1.
LOCK=/c/fsm-platform-backup/.scratch/locks/backend-test.lock
STALE_MIN=45
EMPTY_GRACE_SEC=60
empty_for=0

# The age check FAILS SAFE: break a lock only when we POSITIVELY know it is old.
lock_age_min() {
  local ts
  ts=$(cut -d' ' -f1 "$LOCK/epoch" 2>/dev/null)
  if ! [[ "$ts" =~ ^[0-9]+$ ]]; then ts=$(stat -c %Y "$LOCK" 2>/dev/null); fi
  if ! [[ "$ts" =~ ^[0-9]+$ ]]; then echo -1; return; fi   # unknown → treat as fresh
  echo $(( ( $(date +%s) - ts ) / 60 ))
}

while ! mkdir "$LOCK" 2>/dev/null; do
  # A lock with no owner and no epoch was abandoned between `mkdir` and its first write.
  if [ -d "$LOCK" ] && [ ! -e "$LOCK/epoch" ] && [ ! -e "$LOCK/owner" ]; then
    empty_for=$((empty_for+20))
    if [ "$empty_for" -ge "$EMPTY_GRACE_SEC" ]; then
      echo "[db-lock] clearing an abandoned lock (no owner, no epoch, ${empty_for}s)" >&2
      rmdir "$LOCK" 2>/dev/null || true; empty_for=0; continue
    fi
  else
    empty_for=0
  fi
  age=$(lock_age_min)
  if [ "$age" -ge 0 ] && [ "$age" -gt "$STALE_MIN" ]; then
    echo "[db-lock] breaking a lock that is positively ${age}m old" >&2
    rm -f "$LOCK/owner" "$LOCK/epoch" 2>/dev/null; rmdir "$LOCK" 2>/dev/null || true; continue
  fi
  sleep 20
done

date +%s > "$LOCK/epoch"
echo "$$ $(date -Iseconds)" > "$LOCK/owner"
cleanup() { rm -f "$LOCK/owner" "$LOCK/epoch" 2>/dev/null; rmdir "$LOCK" 2>/dev/null || true; }
trap cleanup EXIT INT TERM
cd /c/fsm-platform-backup/apps/backend
"$@"
```

Usage: `/c/fsm-platform-backup/.scratch/locks/backend-test.sh npx vitest run test/foo.e2e-spec.ts`

**Two bugs this script has already had. Do not reintroduce either:**

1. **Failing open.** The first version used `$(stat -c %Y "$LOCK" 2>/dev/null || echo 0)`. Any
   transient failure — including the holder `rmdir`-ing between the `-d` test and the `stat` — made a
   fresh lock look 56 years old, so **every waiter broke the lock it was waiting on**. Two suites then
   ran concurrently and destroyed each other. Break a lock only on a *positively known* age.
2. **Failing closed.** The fix above ("unknown age means fresh") deadlocked waiters for the full
   45 minutes on a lock abandoned before its first write. One agent sat 25 minutes behind an empty
   lock directory. Hence the `EMPTY_GRACE_SEC` arm.

**Tell agents to run their named specs, not the full suite** — a full run holds the lock ~15 minutes
against everyone. The orchestrator runs the full suite once, at the end, with nothing else going.

---

## 4. The agent brief

**A working template is tracked at `docs/agents/parallel-agent-brief.md`** — copy it to
`.scratch/PARALLEL-BRIEF.md` and adjust. Put the shared rules in one file and have every agent read it
first, so the per-agent prompt is just "read the brief, then build #N, you own these files". The brief
must carry:

- the project rules (`CLAUDE.md` reading order, red-first, the surfacing/UI-reference rule, AFK policy);
- **"verify the finding against the current code before building it"** — see §6, this pays constantly;
- the ownership rule: *you own only the listed files; if the slice needs another agent's file, stop
  and report rather than editing it*; other agents' edits appearing around you are expected and are
  **not yours to revert or clean up**;
- the git rule from §2 and the lock rule from §3;
- the deliverable: implementation + `docs/progress/<n>-<slug>.md` + issue ACs ticked and `Status:` set;
- **do not edit `INDEX.md` or `SYSTEM-STATE-2026-07.md`** — every agent would collide; the
  orchestrator writes both;
- a final-report format: what was built, where the premise was wrong, **the exact list of paths
  touched**, test results verbatim, decisions and defaults assumed, what was deliberately not built.

---

## 5. Building the disjointness matrix

**Do not trust wave numbers.** `IMPLEMENTATION-PLAN.md` §3 says "within a wave, slices are
file-disjoint unless a dependency is listed". That is **not true** — #346, #347 and #357 sit in
different waves and all three write `reports/reports.service.ts`.

Build the matrix from §4's per-slice **"Code areas"** plus a real `git grep`, then group so that no
two concurrent slices share a file. Where ownership is uncertain, serialise.

**Two things a plan-derived matrix reliably misses:**

- **Shared leaf files and module registration.** A new controller cannot be reached without editing
  `app.module.ts`; a nullable chart datum needs `components/charts/TrendChart.tsx`. These have no
  owner in the plan. Either assign them up front or accept small, disclosed edits outside the list.
- **Two slices can legitimately need one page.** #346 and #350 both needed `ManagerDashboard.tsx`, and
  #346's edit was swept into #350's commit because the orchestrator staged by path without checking
  for a second author's hunks.

---

## 6. Expect the issue to be wrong about the code

The standing operator instruction is *"verify every important finding against the current code before
creating work; do not blindly implement the report."* In a round of ten, **six slices found the issue
file or the plan wrong**, and four of those were material:

- an audit read had been silently dropping ~half its rows because one column is written three
  different ways;
- a "zero" that was actually rendering as **100%**, i.e. wrong in the flattering direction;
- a freshness badge with **no age threshold anywhere** — the value was computed and compared with
  nothing;
- a plan section made stale by an earlier slice in the same backlog.

Budget for this. An agent that reports "the premise was wrong and here is what is actually true" has
done the job correctly.
