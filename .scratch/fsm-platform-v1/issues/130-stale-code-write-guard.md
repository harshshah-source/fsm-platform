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

## Add-ups ruled 2026-07-20 (operator proposals 1–3, authority delegated)

1. **Status-authority documentation — ACCEPTED as the "Data-model authority" section below; two
   specifics REJECTED.** (a) No enum widening: `vehicles.status` is a nullable `String`
   (schema.prisma:1660) mirroring the source **verbatim**, and post-#128 a vehicle FSM already
   knows is upserted regardless of status, so the mirror already tells the truth
   (`master-sync.service.ts:256-257`). Pinning an enum would make the sync brittle to a new
   AutoPlant value — a novel status must be *observed as non-operational* (the current fail-safe
   via the `OPERATIONAL_DEPLOYMENT_STATUSES` allow-list, `master-mapping.ts:143-151`), not crash
   the mirror write. (b) No `NEVER_DEPLOYED` value: never-deployed devices have **no FSM row at
   all** by the #128 insert-scope pin (read ≠ create; `vehicles` would balloon ~21k→~48k) — a
   status value for rows that must not exist would silently reopen that decision. (c) The wording
   "`vehicles.status` IS the single source for status truth" is **inverted for safety-critical
   gates**: a mirror scalar is exactly the class of derived state run 65 corrupted; L2's whole
   point is that dangerous writes re-read the temporal ledger. The corrected hierarchy is below.
2. **Migration offline-safety — principle ACCEPTED (and made explicit below); mechanism
   REJECTED.** There is no "migration 023" (migrations are timestamp-named), and with `status`
   staying TEXT there is no enum migration at all. The valid core — **no migration ever performs
   network I/O or requires AutoPlant; data corrections are separate idempotent, dry-run-gated,
   rerunnable scripts** (the #128 backfill pattern) — is repo convention and is now stated as a
   hard rule in "Migration policy". "Infer the enum from distinct values already in the DB" is
   rejected outright: data-derived DDL makes the schema **environment-dependent** (dev/test/prod
   would diverge), which is precisely the skew L4 exists to refuse.
3. **Eligible-count canary — ACCEPTED, upgraded to L5.** Two corrections to the proposal:
   (a) alert on swings in **both directions**, not just drops — the run-65 signature was a *rise*
   (departed devices re-entering eligibility, ~15,799 → ~21k); the run-64 stub artifact was the
   drop (→ 0). (b) Store the baseline as a small **`device_state_recomputes` ledger** (one row
   per recompute: counts + build stamp), not a single previous-value cell — this simultaneously
   closes a real hole in L3: the recompute is the very write that caused the incident and was the
   only pipeline stage with **no run ledger** (`master_sync_runs`/`snapshot_runs`/`dispatch_runs`
   exist; recompute had nothing). Canary **warns, never blocks**: legitimate >5% swings exist
   (#119 deactivations departed 3,620; the #128 backfill 5,523) and hard-fail on true corruption
   already belongs to the L2 invariant.

## Data-model authority (design property — binding on all future status work)

Three tiers, from source-of-truth downward:

1. **`device_departures`** — FSM's lifecycle ledger; **the** authority for "is this device
   operationally departed", since when, why (`observed_status` verbatim, incl. the
   `MISSING_FROM_SOURCE` sentinel that no mirror scalar can represent), and what run did it.
   Safety-critical gates (ticket creation, recommender, recompute derivation) re-read it (L2).
2. **`vehicles.status`** — the verbatim last-observed AutoPlant `deployment_status` mirror for
   vehicles FSM knows (kept TEXT; already updated on every sync regardless of status,
   `master-sync.service.ts:256-257`). Authoritative for "what did AutoPlant last say", feeds the
   `all-deployed` eligibility base and display — **never** a safety gate by itself.
3. **`device_states.is_departed`** — derived cache of tier 1 for fast operational filtering
   (dashboards, cheap predicates); recomputed via EXISTS (`device-state.service.ts:66-69`);
   trusted only where being stale is harmless.

**Rule for future status work:** a new AutoPlant status value arrives as a *verbatim observation*
and defaults to non-operational; making it operational means updating
`OPERATIONAL_DEPLOYMENT_STATUSES` (`master-mapping.ts:143`) **and** its consumers (departure
gate + `all-deployed` eligibility base, `device-state.service.ts:73-75`) in the same change —
never one without the others.

## Migration policy (hard rule, restated from repo convention)

Migrations are offline-safe DDL only: no network I/O, no AutoPlant dependency, no data-derived
DDL, runnable in CI/test/offline dev from zero. Anything needing live data or the source system
is a separate idempotent, rerunnable, dry-run-gated script (#128 backfill pattern). #130's own
migrations (`runtime_lock`, ledger columns, `device_state_recomputes`) are all pure DDL.

## The five layers

| Layer | Guarantee | Fires | Catches |
|---|---|---|---|
| **L1 version lock** | A build older than the DB's high-water mark cannot start/write | `PrismaService.onModuleInit` (every entrypoint) | The exact July-19 process |
| **L4 migration-skew refusal** | App bundle and applied `_prisma_migrations` must match | Same preamble, before L1 | `migrate deploy` ran but app not upgraded (or vice-versa) — invisible to L1's integer |
| **L2 defensive writes** | Dangerous mutations re-read source-of-truth, not flags | Every write | A stale/racing writer that somehow got past L1 |
| **L3 ledger build-stamp + badge** | Every run attributed to a build; stale runs render a warning | Run creation + admin render | Detectability — any slip-through becomes loud after the fact |
| **L5 semantic canary** | An eligible-count swing > threshold between recomputes is loud | Every recompute + health page | Semantic corruption from *any* cause — stale code, env-mismatch, wrong `DATABASE_URL`, bad config — that no version check can see |

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

## L5 — semantic canary + recompute ledger

- New table `device_state_recomputes` (pure DDL): `recompute_id BIGSERIAL PK | computed_at
  TIMESTAMPTZ | eligible_count INT | inactive_count INT | departed_count INT | total_count INT |
  build_version BIGINT | build_fingerprint TEXT | trigger TEXT` (trigger: `api` / `cron` /
  `autoplant-sync` / `test`). `DeviceStateService.recompute` appends one row per run — this is
  also the missing L3 attribution for the exact write class that caused the incident.
- After appending, compare `eligible_count` against the previous row: relative change
  > threshold (setting `recompute_canary_threshold_pct`, default **5**, both directions; skipped
  when the previous baseline is 0/absent) → one LOUD warn-level log line naming both counts, both
  build fingerprints, and the delta — **never a throw/block** (hard-fail on true corruption is
  L2's invariant; legitimate mass events like #119/#128 must not halt the pipeline).
- Surfaced on the integration-health page (same slice as the L3 badge): last-N recompute history
  with counts + build, swing rows highlighted with the warning.

## Rejected alternatives (for the record)

Restart-on-deploy discipline (July 19 *was* a discipline failure; can't cover scripts);
PID-file single-instance guard (detects concurrency, not version — run 65 was one process with
old code); health-endpoint check (a stale server answers its own /health with stale code green;
scripts serve no endpoint). Only the version lock checks *version*, before *any* write, on
*every* entrypoint.

## Acceptance criteria

- [x] Full version-compare matrix tested (no row / upgrade / restart / clean-clean refuse /
      dirty takeover / stale refuse), incl. concurrent-boot race and the exact refuse message. _(Slice 1)_
- [x] Migration-skew refusal both directions + `_prisma_migrations`-absent skip. _(Slice 1)_
- [x] Old-dist simulation: build-info resolving to `{0,'unstamped'}` refuses against a stamped DB;
      source-run (vitest) self-stamps from git and boots a fresh test DB. _(Slice 1 — verified end-to-end via `npm run build` + compiled `require`)_
- [x] `runtime-lock:reset` lowers the lock only with `--yes`, writes the audit row. _(Slice 1)_
- [ ] **July-19 simulation regression test**: seed lock at N; assert build < N refuses; assert the
      exact corrupt state (active `device_departures` row + `is_departed=false`) yields **zero**
      tickets from `createForInactiveEligible` and a recompute-invariant throw.
- [x] Ledger rows stamped (all 3 run tables); stale-run flag exposed on `/api/integration/health`
      (`staleBuild` per freshness + per recompute). _(Slice 2 — API done; the routed **integration-health
      page** table + **dispatch-run-detail** badge render deferred to [#131](./131-build-health-ui-parity.md),
      entangled 07-17 WIP, not an external-integration blocker. A minimal OpsHead alert
      (`BuildHealthNotice`) ships in-slice on the global banner.)_
- [x] L5: every recompute appends a `device_state_recomputes` row (counts + build stamp); a
      > threshold swing in either direction logs the loud warning and highlights on the health
      page; a legitimate mass event warns but never blocks; threshold read from settings.
      _(Slice 2 — warn line + ledger done; "highlights on the health page" table is [#131](./131-build-health-ui-parity.md),
      API already returns `swing`/`swingPct` per row.)_
- [x] Read-only tools (`autoplant:ping`, `autoplant:departure-dryrun`) warn, never refuse. _(Slice 1 — dryrun now warnOnly; `autoplant:ping` never constructs PrismaService)_
- [x] Scheduler flags and `eligibility_mode` untouched. _(Slice 1 — verified: no edits to either)_

## Build plan (TDD, commit + push per slice, one INDEX session-log line per slice)

1. **✅ Slice 1 — L1 + L4 (boot refusals). DONE 2026-07-20.** build-info loader + stamp script +
   build-script chain, `runtime_lock` migration (`20260720120000`), `assertBuildNotStale` (version +
   skew) under `pg_advisory_xact_lock`, `PrismaService.onModuleInit` hook + `@Optional() warnOnly`,
   `main.ts` early assert, `runtime-lock:reset` CLI, `autoplant:departure-dryrun` switched to warnOnly.
   36/36 targeted tests green (5 specs); `npm run build` chain + `tsc --noEmit` clean; guard validated
   against sample full-AppModule e2e boots. Compiled-run `{0,'unstamped'}` (no git fallback) verified
   end-to-end. Commit + push per the plan; INDEX session-log line added.
2. **✅ Slice 2 — L3 + L5 (attribution + canary). DONE 2026-07-20.** `build_version`/`build_fingerprint`
   columns on `master_sync_runs`/`snapshot_runs`/`dispatch_runs` + stamped at creation from build-info;
   `device_state_recomputes` ledger (migration `20260720130000`) appended on every recompute (counts +
   build + `trigger`: api/cron/autoplant-sync/test, correctly threaded through the real callers);
   `evaluateRecomputeCanary` pure decision (>`recompute_canary_threshold_pct` setting, default 5, both
   directions, skips on absent/0 baseline) wired into `DeviceStateService.recompute` — LOUD warn, never
   throws. `GET /api/integration/health` exposes `runtimeLock`, per-freshness `build.staleBuild`, and
   `recomputes[]` (last-10, swing-flagged). Admin: OpsHead-gated `BuildHealthNotice` on the global
   banner (new/clean file — zero edits to the uncommitted 07-17 working tree). **UI parity partial by
   operator decision**: the full recompute-history table + dispatch-run-detail badge need files
   entangled in that unrelated uncommitted WIP → split to [#131](./131-build-health-ui-parity.md).
   68 new/regression targeted tests green; Slice 1's 36 re-verified green (no regression); both apps
   `tsc --noEmit` clean; full backend `build` chain clean.
3. **Slice 3 — L2 (defensive writes).** Ticket-creation source-of-truth re-read, recompute
   invariant transaction, recommender regression-lock test.
4. **Slice 4 — July-19 simulation regression test** (cross-cutting L1+L2; assert the L5 row for
   the simulated stale recompute carries the stale build stamp and trips the canary).
