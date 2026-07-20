# 130 — Stale-code-write guard: version lock + migration-skew refusal + defensive writes + run attribution

Status: ready-for-agent
Type: AFK (design signed off 2026-07-20; all five open decisions taken — see "Decisions taken")

> Root incident: **2026-07-19 run 65** — a process holding pre-#128 code connected to the post-#128
> database, recomputed `device_states` without the departure exclusion, cleared `is_departed`
> fleet-wide, and the `isDeparted: false` gate in ticket creation opened for departed devices. The
> damage was silent because (a) nothing checks build identity at connect time
> (`prisma.service.ts:13-26` connects from `DATABASE_URL` with zero assertion), (b) the dangerous
> write trusted the denormalised flag (`ticket-creation.service.ts:41`), and (c) runs are
> unattributed (`master_sync_runs` / `snapshot_runs` / `dispatch_runs` record what happened, not
> which build did it). Bar set by the operator: stale writes must be **impossible in production,
> not merely unlikely**.

## Threat model (verified 2026-07-20)

- Write surface is **broader than the HTTP server**: `main.ts` boots the API, but
  `autoplant-sync.ts:41-42` (and `seed.ts`, `prisma/seed-mock-engineers.ts`) construct
  `PrismaService` by hand and write to the same DB without touching `main.ts`. Any guard living
  only in the HTTP bootstrap is bypassable — this is the load-bearing constraint.
- Prisma 7 over the driver adapter does **not** verify migrations at runtime; only the
  `prisma migrate deploy` CLI does, and `package.json` has no migrate/deploy step. Schema skew is
  currently unguarded at boot.
- Verified safe already: recommender re-reads `device_departures` directly
  (`recommender.service.ts:113`); recompute derives `is_departed` from the side table via EXISTS
  (`device-state.service.ts:66-69`). Verified unsafe: ticket creation gates on the derived flag
  (`ticket-creation.service.ts:41`).

## Decisions taken (2026-07-20, operator delegated)

1. **Monotonic key = git committer epoch** (`git show -s --format=%ct HEAD`). Newer commit ⇒ newer
   epoch across branches; no hand-editing; no CI needed. (Commit-count diverges on branches;
   hand-maintained integer violates the no-hand-edit requirement.)
2. **Unstamped-build policy confirmed as a feature** — a dist without a baked build-info refuses
   against a stamped (production) DB. Softened for legitimate dev tooling by the resolution order
   below: source-run tools inside the repo self-stamp from live git, so only a genuinely
   unattributable binary is refused.
3. **Enforcement is structural, not per-script**: the guard lives in `PrismaService.onModuleInit`
   (see L1). Every entrypoint — Nest app and hand-constructed scripts alike — already calls it
   (`autoplant-sync.ts:42`), so no future one-off script can forget the guard. Read-only tools
   (`autoplant:ping`, `autoplant:departure-dryrun`) construct PrismaService in `warnOnly` mode.
4. **Recompute invariant violation ⇒ rollback-and-throw** (not log-and-alert). A recompute that
   under-excludes fails atomically; the run ledger records FAILED.
5. **Issue number #130** (this file; #129 is the departure UI-parity fast-follow).

## Design refinements over the 07-19 draft (why, so the builder doesn't "simplify" them away)

- **R1 — build-info is a checked-in loader + baked JSON, not a gitignored generated `.ts`.**
  `apps/backend/src/generated/` is gitignored (.gitignore:38); a generated TS module there would
  break `vitest` (imports src directly), `tsc --noEmit`, and fresh clones. Instead:
  `src/build-info/build-info.ts` (checked in) resolves, in order:
  1. **Compiled run** (`!__filename.endsWith('.ts')`): read `dist/build-info.json` baked at build
     time — `"build": "tsc -p tsconfig.json && node scripts/stamp-build-info.mjs"`. Missing JSON ⇒
     `{ version: 0, fingerprint: 'unstamped' }`. **Never fall back to live git from dist** — a
     stale dist running inside the repo would misattribute itself as HEAD (this closes the exact
     July-19 process, which ran from the repo).
  2. **Source run** (ts-node / vitest / tsx): live git (`%ct` + `status --porcelain` dirty flag) ⇒
     correctly stamped dev tooling. Git unavailable ⇒ `{ 0, 'dev' }`.
- **R2 — guard placement in `PrismaService.onModuleInit`** (after `$connect`), with a
  `warnOnly` constructor option for read-only tools. The draft's "mandatory preamble in every
  write-capable script" was convention — the same failure class it set out to kill. `main.ts`
  additionally calls the assert explicitly right after `validateBootConfig()` for fail-fast
  before module init (belt and braces; the structural one is the guarantee).
- **R3 — same-version/different-fingerprint rule tuned for this box's dirty-worktree reality**
  (builds here are routinely made from dirty trees): refuse only when **both** fingerprints are
  clean SHAs that differ (true ambiguity — two different commits with an identical committer
  second). If either side is `-dirty`, take over the lock with a loud WARN — a dirty build at the
  same HEAD is never *older* than HEAD, and refusing would block routine local work.
- **R4 — L4 carve-outs**: skip-with-warn when `_prisma_migrations` does not exist (test DBs built
  via `db push` / from-zero harnesses); compare only rows with `finished_at IS NOT NULL AND
  rolled_back_at IS NULL` against the bundled `prisma/migrations/*` directory names.

## The four layers

| Layer | Guarantee | Fires | Catches |
|---|---|---|---|
| **L1 version lock** | A build older than the DB's high-water mark cannot start/write | `PrismaService.onModuleInit` (every entrypoint) | The exact July-19 process |
| **L4 migration-skew refusal** | App bundle and applied `_prisma_migrations` must match | Same preamble, before L1 | `migrate deploy` ran but app not upgraded (or vice-versa) — invisible to L1's integer |
| **L2 defensive writes** | Dangerous mutations re-read source-of-truth, not flags | Every write | A stale/racing writer that somehow got past L1 |
| **L3 ledger build-stamp + badge** | Every run attributed to a build; stale runs render a warning | Run creation + admin render | Detectability — any slip-through becomes loud after the fact |

## L1 — build-fingerprint version lock

- `runtime_lock` table, single enforced row (`CHECK (id = 1)`, raw migration):
  `id | version BIGINT | fingerprint TEXT | app_version TEXT | migration_head TEXT | boot_at
  TIMESTAMPTZ | pid INT | hostname TEXT | updated_at TIMESTAMPTZ`.
- `assertBuildNotStale(prisma, buildInfo)` runs in a transaction under
  `pg_advisory_xact_lock(hashtext('runtime_lock'))` — same serialization pattern as
  `master-sync-run.service.ts:54-55` — so concurrent boots serialize. Decision matrix:
  - no row → INSERT mine (own the lock)
  - mine.version > row → UPGRADE (normal deploy)
  - equal version, same fingerprint → refresh boot metadata (restart)
  - equal version, differing fingerprints, **both clean** → REFUSE (ambiguity)
  - equal version, either side dirty → WARN + takeover (R3)
  - mine.version < row → **REFUSE**, one fatal line:
    `FATAL stale-build refused: this process is build <sha>@v<version>, but database <db> requires
    ≥ v<N> (build <sha_N>, booted <t> by pid<p>@<host>). Deploy the current build or run
    'npm run runtime-lock:reset' to authorize a rollback.`
- `warnOnly` mode (read-only tools): evaluate, log the same line as WARN, never write the lock,
  never throw.
- **Downgrade CLI** `npm run runtime-lock:reset -- --to <version> --reason "<text>" --yes` — the
  only path that lowers the high-water mark. Writes an `audit_logs` row
  (`RUNTIME_LOCK_RESET`, metadata: from→to, reason, actor). Without `--yes`: print intended
  change, exit non-zero. The tool constructs PrismaService in `warnOnly` (it exists to repair
  lock state; it must not be blocked by it).

## L4 — refuse partial upgrades

Same preamble, ordered `validateBootConfig → L4 (schema) → L1 (version; records migration_head)
→ listen`. Compare bundled `prisma/migrations/*` dir names vs applied rows (R4 filters):
- DB has applied migration the app doesn't bundle → refuse (app older than schema).
- App bundles migration not applied → refuse (run `migrate deploy` first).
- Exact match → proceed. `_prisma_migrations` absent → warn + skip (test/dev DB).

## L2 — defensive writes (source-of-truth at write time)

- **Ticket creation (THE gap)**: replace `isDeparted: false` (`ticket-creation.service.ts:41`)
  with `device: { departures: { none: { restoredAt: null } } }` — the identical shape the
  recommender already uses (`recommender.service.ts:113`). Keep the `isInactive`/eligibility flag
  filters (they only ever *reduce* candidates; the departure re-read is the safety-critical one).
- **Recommender**: already safe — add a regression-lock test so the source-of-truth re-read can't
  silently regress to a flag.
- **Recompute invariant (decision 4)**: wrap the recompute UPDATE + assertion in one transaction —
  after the UPDATE, `COUNT(*)` of devices having an active `device_departures` row yet showing
  `is_departed = false OR is_inactive OR eligible_for_uptime OR sla_bucket IS NOT NULL` must be 0;
  nonzero → throw → rollback. (The machine-checkable form of the invariant hand-verified 07-19.)

## L3 — ledger build-stamp + transparency badge

- Additive nullable `build_version BIGINT` + `build_fingerprint TEXT` on `master_sync_runs`,
  `snapshot_runs`, `dispatch_runs`; stamped at run creation (`master-sync-run.service.ts:59`,
  snapshot equivalent, `dispatch-run.service.ts:~76`) from build-info.
- Surfaced via AutoPlant health service + dispatch transparency query; a run whose
  `build_version < runtime_lock.version` renders a **stale-build warning badge** ("ran under
  build v_x_, current v_y_"). Per the surfacing rule this slice **includes the admin UI**
  (integration-health page + dispatch run detail), not just the API.

## Rejected alternatives (for the record)

Restart-on-deploy discipline (July 19 *was* a discipline failure; can't cover scripts);
PID-file single-instance guard (detects concurrency, not version — run 65 was one process with
old code); health-endpoint check (a stale server answers its own /health with stale code green;
scripts serve no endpoint). Only the version lock checks *version*, before *any* write, on
*every* entrypoint.

## Acceptance criteria

- [ ] Full version-compare matrix tested (no row / upgrade / restart / clean-clean refuse /
      dirty takeover / stale refuse), incl. concurrent-boot race and the exact refuse message.
- [ ] Migration-skew refusal both directions + `_prisma_migrations`-absent skip.
- [ ] Old-dist simulation: build-info resolving to `{0,'unstamped'}` refuses against a stamped DB;
      source-run (vitest) self-stamps from git and boots a fresh test DB.
- [ ] `runtime-lock:reset` lowers the lock only with `--yes`, writes the audit row.
- [ ] **July-19 simulation regression test**: seed lock at N; assert build < N refuses; assert the
      exact corrupt state (active `device_departures` row + `is_departed=false`) yields **zero**
      tickets from `createForInactiveEligible` and a recompute-invariant throw.
- [ ] Ledger rows stamped; stale-run badge renders on integration-health + dispatch run detail.
- [ ] Read-only tools (`autoplant:ping`, `autoplant:departure-dryrun`) warn, never refuse.
- [ ] Scheduler flags and `eligibility_mode` untouched.

## Build plan (TDD, commit + push per slice, one INDEX session-log line per slice)

1. **Slice 1 — L1 + L4 (boot refusals).** build-info loader + stamp script + build-script chain,
   `runtime_lock` migration, `assertBuildNotStale` (version + skew), `PrismaService.onModuleInit`
   hook + `warnOnly`, main.ts early assert, reset CLI. Tests: matrix, race, messages, skew, CLI audit.
2. **Slice 2 — L3 (attribution).** Ledger columns + stamping + health/transparency exposure +
   admin badge UI (parity in-slice).
3. **Slice 3 — L2 (defensive writes).** Ticket-creation source-of-truth re-read, recompute
   invariant transaction, recommender regression-lock test.
4. **Slice 4 — July-19 simulation regression test** (cross-cutting L1+L2).
