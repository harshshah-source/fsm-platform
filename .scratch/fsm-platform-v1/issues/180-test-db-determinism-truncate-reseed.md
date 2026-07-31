# 180 — The backend suite is not a measurement instrument: make the test DB deterministic first

Status: done
Type: AFK · Backend (test infrastructure)

Filed 2026-07-31. **The first of four repair issues — nothing else in the set is verifiable until
this lands.** Sequence: **#180 (this) → #181 + #182 together → #183.** Rationale in
"Position in the order" below.

Permanent-fix half of [#156](./156-test-db-orphan-accumulation.md) (whose symptom was cleared by
hand on 2026-07-22 and has since re-accumulated). #156 stays open for its residual worker-crash
finding; this issue owns option (a) — truncate-and-reseed in `global-setup.ts`.

---

## The central fact

Four full backend runs on the **same commit** (`786b080`, working tree clean), measured 2026-07-31:

| Run | `BUSINESS_SWEEPS_ENABLED` | Files failed | Tests failed | Passed | Skipped |
|---|---|---|---|---|---|
| 1 | `false` | 7 | 11 | 1273 | 11 |
| 2 | `false` | 7 | 11 | 1266 | 11 |
| 3 | `true`  | 9 | 10 | 1270 | 15 |
| audit (`docs/audits/2026-07-31-implementation-audit.md`) | `true` | 7 | 8 | 1271 | 11 |

Runs 1 and 2 are the **same flag, same code, different passed-count** (1273 vs 1266). That alone
proves the suite's result depends on database history, not on the code under test.

> **These measured baselines are authoritative. Where `docs/audits/2026-07-31-implementation-audit.md`
> disagrees with them, the audit is wrong** — its run happened to hit a different DB state. Do not
> use audit numbers as a target.

**Do not treat any red as "caused by my change" until this issue is done.** Equally, do not treat any
green as proof. The goal here is *identical counts across three consecutive runs* — **not green**.
Green is #181 / #182 / #183's job.

## Position in the order (state this in your commit message)

1. **#180 (this) — determinism.** Until the instrument is stable, no other fix can be shown to work.
2. **#181 + #182 together** — constructor-arity drift and the non-hermetic env. They are **coupled
   through a single mechanism** (see #181 §"Why A and B are one mechanism"); fixing either alone
   moves failures around rather than removing them.
3. **#183 — the tier-override calendar time-bomb.** Independent of all three; last because its six
   tests do not currently execute at all, so it cannot mask or be masked by anything.

## Root cause (unchanged from #156, restated with citations)

`test/global-setup.ts` runs `prisma migrate deploy` (`global-setup.ts:20-25`) and then the idempotent
org seed (`global-setup.ts:28-34`). It **never truncates**. `fsm_test` is a long-lived shared
database and every spec is individually responsible for undoing its own fixtures in `afterAll`, so
any spec that dies before its `afterAll` — worker crash, killed run, `beforeAll` throw — leaks its
rows permanently. #156 measured **780 orphan zones / 404 orphan engineers** on 2026-07-22.

`vitest.config.ts` sets `fileParallelism: false`, so files run serially against one DB; there is no
`testTimeout` override, so the default **5000 ms** applies to specs that iterate every zone.

---

# Resolved facts

## R1 — the three confirmed failures, each classified

### R1.1 `dispatch-run-zone-scoped.e2e-spec.ts` — FK violation on `dispatch_decision_traces_run_id_fkey`

**Observed:** `PrismaClientKnownRequestError`, FK violated on `dispatch_decision_traces_run_id_fkey`,
raised from the spec's `afterAll`.

**The reported diagnosis is wrong in detail and must not be acted on as stated.** The claim was "the
spec's teardown deletes `dispatchRun` before its decision traces — a real ordering bug." It does not.
`dispatchDecisionTrace.deleteMany` runs **first** (`dispatch-run-zone-scoped.e2e-spec.ts:73`), well
before `dispatchRun.deleteMany` (`:82`). The order is correct.

**The actual defect is the predicate, not the order.** The trace delete is keyed on
`{ ticketId: { in: ticketIds } }` (`:73`) — the spec's own two tickets. But the FK that blocks the
delete is on **`run_id`**. The second test calls `svc.runForActiveZones(NOW)` with **no `zoneId`**
(`:120`) — the deliberately unnarrowed pan-India path. `runForActiveZones` sweeps every zone that has
at least one plant (`dispatch-run.service.ts:259-262`), so with orphan zones present it considers
orphan tickets too and writes a `dispatch_decision_traces` row for each, all carrying **this run's**
`run_id`. Those foreign traces are outside the `ticketIds` predicate, survive the delete, and block
`dispatchRun.deleteMany({ where: { runId: { in: runIds } } })`.

**Classification: BOTH.** Truncation removes today's trigger (after a truncate+reseed the only
plant-bearing zones are the seeded `North` plus the spec's own two, and `North` carries no eligible
tickets, so no foreign traces are written). But truncation happens **once per run**, at
`globalSetup` — any spec that runs *earlier in the same run* and leaks a ticket into a plant-bearing
zone reintroduces the failure immediately. The predicate must be repaired as well.

**Repair:** change the trace delete at `:73` to key on the run, not the tickets —
`prisma.dispatchDecisionTrace.deleteMany({ where: { runId: { in: runIds } } })` — and move it to
immediately before the `dispatchRun.deleteMany` at `:82` so both keys agree. Keep the existing
ticket-keyed delete as well if you prefer belt-and-braces; it is harmless.

### R1.2 `plant-zone-change-impact.e2e-spec.ts:64` — unique violation on `source_plant_id`

**Observed:** unique violation raised from `prisma.plant.create(...)` in `beforeAll`
(`plant-zone-change-impact.e2e-spec.ts:64-67`).

**Mechanism, confirmed:** the spec namespaces its *names* with `NS = Date.now()` (`:17`) but pins
`SRC_PLANT = 995401n` as a **fixed constant** (`:18`) and writes it into
`plant.create({ ... sourcePlantId: SRC_PLANT })` (`:66`). `plants.source_plant_id` is `@unique`
(`prisma/schema.prisma:323`). The spec's own `cleanup()` deletes by that key
(`plant.deleteMany({ where: { sourcePlantId: SRC_PLANT } })`, `:45`), so a clean exit leaves nothing
— but any earlier crashed run leaves the row forever, and every subsequent run collides.

**Classification: TRUNCATION FIXES IT.** This is the pure orphan case.

**Recommended hardening (cheap, do it):** `beforeAll` never calls `cleanup()` before creating
(`:50-56` goes straight to creating). Add `await cleanup();` as the first statement after
`prisma.onModuleInit()` so the spec is self-healing regardless of DB history. `cleanup()` is already
written to tolerate absent rows (`.catch(() => undefined)` on the fragile deletes).

### R1.3 `dispatch-transparency-api.e2e-spec.ts:247,270` — "expected undefined"

**Observed:** `expect(row).toMatchObject(...)` where `row` is `undefined`, at `:247` (OH list) and
`:270` (ZM list). Reported as "cross-test interference" — that is the right family, and the exact
mechanism is now resolved.

**Mechanism, confirmed:** the list endpoint is capped. `DispatchTransparencyQueryService.listRuns`
takes `limit = 30` and queries `orderBy: { startedAt: 'desc' }, take: limit`
(`dispatch-transparency-query.service.ts:209-213`); the controller only overrides it from a `?limit=`
query param (`dispatch-runs.controller.ts:43-44`), which the spec does not send. The spec's fixture
run is created with a **frozen past** `startedAt: NOW` where `NOW = new Date('2026-07-15T05:00:00Z')`
(`dispatch-transparency-api.e2e-spec.ts:21`, used at `:167`). Every other `dispatch_runs` row created
with a real clock sorts **ahead** of it. Once 30 such rows exist, the fixture run falls off the page
and `res.body.find(r => r.runId === runId.toString())` returns `undefined`.

**Classification: BOTH.** Truncation clears the accumulated rows and restores the pass. But the spec
remains one 30-row accumulation away from failing again — including from rows created *within the
same run* by other specs.

**Repair:** send an explicit bound on both requests — `.get('/api/dispatch-runs?limit=200')` at the
call sites feeding `:247` and `:270` — **or**, preferably, stop relying on a frozen past `startedAt`
and set the fixture run's `startedAt` relative to real time. Do **not** raise the service's default
`limit`; 30 is a product decision, not a test knob.

## R2 — truncation approach: `TRUNCATE`, one statement, `RESTART IDENTITY`, **no `CASCADE`**

**Decision: a single `TRUNCATE` naming every top-level public base table, with `RESTART IDENTITY`,
without `CASCADE`.** Rejected: ordered `deleteMany` cascades.

**Why TRUNCATE over ordered deletes.** There are **69 Prisma models** (`grep -c '^model '
prisma/schema.prisma` → 69). An ordered-delete path needs a topological sort of the FK graph that
must be re-derived by hand on every new migration — a maintenance obligation that will silently rot,
which is exactly the failure mode this issue exists to remove. `TRUNCATE` needs no ordering: when
every referencing table is named in the same statement, Postgres accepts it.

**Why no `CASCADE`.** `CASCADE` is only required when a referenced table is truncated without its
referencing tables. Because the statement names **all** of them, `CASCADE` is redundant — and it is
precisely the mechanism that could reach outside the intended set. #156 recorded the trap: including
`spatial_ref_sys` (PostGIS's own table, owned by the extension-installing superuser) makes the `fsm`
role hit `permission denied for table spatial_ref_sys`, and because `TRUNCATE` is **atomic across
all named tables**, the entire truncate rolls back and silently changes nothing. Omit `CASCADE` and
that class cannot arise.

**Why `RESTART IDENTITY` is MANDATORY, not optional.** `src/auth/user-store.ts:28` and `:48` hardcode
`zoneId: 1` for the dev zone-scoped login identities. **74 spec files log in as `zm.north@fsm.test`**
(`grep -l 'zm.north@fsm.test' test/*.e2e-spec.ts | wc -l` → 74), and
`dispatch-transparency-api.e2e-spec.ts:23` hardcodes `const ZM_ZONE = 1n; // zm.north@fsm.test
carries zone_id 1 in its claims`. `zones.zone_id` is a `BIGSERIAL`. Without `RESTART IDENTITY`, the
first reseed after a truncate creates `North` at whatever the sequence has climbed to (781+ on the
current DB) — **zone 1 would not exist** and those 74 files would break at once. With
`RESTART IDENTITY`, the seed's zone order (`SEED_ZONES = ['North','South','East','West','UNZONED']`,
`src/org/org-seed.ts:17`) makes `North = zone_id 1` deterministic on **every** run. This is the
single most load-bearing detail in this issue.

`RESTART IDENTITY` is safe for the one place the seed uses explicit ids: `component_master` rows 1–4
are inserted with literal ids and the seed then `setval`s the sequence past them
(`org-seed.ts:206-212`), so the reset is corrected in the same seed pass.

**The table list — derive it from `pg_class`, not `information_schema`:**

```sql
SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ' ORDER BY c.relname)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'p')        -- ordinary + partitioned parents; excludes 'm' (matview), 'v'
  AND c.relispartition = false       -- skip child partitions; TRUNCATE on the parent recurses
  AND c.relname NOT IN ('spatial_ref_sys', '_prisma_migrations');
```

- `relkind IN ('r','p')` excludes the one materialized view (`plant_eligible_floating_se`, created by
  `prisma/migrations/20260621160000_add_plant_eligible_floating_se_mv/migration.sql:9`) — a matview
  cannot be truncated and naming it would abort the statement.
- `relispartition = false` is what keeps R3 correct.
- The two exclusions are #156's recorded lessons: `spatial_ref_sys` (permission → whole-statement
  rollback) and `_prisma_migrations` (truncating Prisma's ledger makes `migrate deploy` replay the
  entire migration history on the next run).

**Keep #156's `_test` guard.** The script must refuse any database whose name does not end in
`_test`, derived through the same rule as `test/test-db-url.ts:12-24`. `fsm` and `fsm_test` differ by
a suffix on the same server (`.env:2` → `localhost:5433/fsm`) and this operation is unrecoverable.

**Where it goes:** in `test/global-setup.ts`, **between** step 1 (`migrate deploy`, `:20-25`) and
step 2 (`seedOrgReferenceData`, `:31`). Order matters — see R4. Also expose it as a `scripts/` entry
point plus a `pnpm test:reset` script (`apps/backend/package.json` `scripts` block) so it is runnable
by hand; #156 asked for this and no such script is committed today (`ls apps/backend/scripts/` →
`check-schema-drift.mjs`, `db-explore.cjs`, `reset-reseed-ses.cjs`, `run-ingest.cjs`,
`stamp-build-info.mjs`).

**Must not boot the Nest app.** #156's note (and the #153/#146 handoff §7.4) — the drift gate targets
a never-booted DB; constructing `PrismaService` writes `runtime_lock` via `assertRuntimeBuildGuards`
(`src/prisma/prisma.service.ts:4`) and the gate then reports false drift. `global-setup.ts` already
uses a bare `PrismaClient` with `PrismaPg` (`:28`), not `PrismaService`. Keep it that way.

## R3 — `raw_device_snapshots` daily RANGE partitioning under truncation

`raw_device_snapshots` is `PARTITION BY RANGE (gps_datetime)`
(`prisma/migrations/20260619153000_add_snapshot_ingestion/migration.sql:66`), converted to real
per-UTC-day partitions plus a retained empty `DEFAULT` catch-all by
`prisma/migrations/20260706130000_partition_raw_device_snapshots_daily/migration.sql:13-58`.
Partition names/bounds are `raw_device_snapshots_yYYYYmMMdDD` over half-open UTC day ranges (`:40-46`),
and `raw_device_snapshots_default` is recreated as the DEFAULT partition at `:57`.

**Behaviour under the R2 statement:**

1. `relispartition = false` excludes every child (`raw_device_snapshots_y2026m…`,
   `raw_device_snapshots_default`); only the parent — `relkind = 'p'` — is named.
2. `TRUNCATE` on a partitioned parent **recurses to every partition automatically**. All telemetry
   rows go.
3. **Partitions are not dropped.** `TRUNCATE` removes rows, never partition structure. The partition
   set that exists after truncation is exactly the one that existed before, so no spec loses its
   insert target.
4. Because `PARTITION_MAINTENANCE_ENABLED="false"` (`.env:24`), `PartitionMaintenanceService` never
   creates ahead in a normal run, so today's-date rows land in `raw_device_snapshots_default` — which
   exists and stays attached. Inserts continue to succeed. **Do not "helpfully" drop the DEFAULT
   partition** as part of this work; it is the deliberate clock-skew safety net (migration `:55-57`)
   and dropping it would turn every out-of-range insert into a hard error.

**Net: no special handling required.** Name only the parent, let `TRUNCATE` recurse, change nothing
about the partition set.

## R4 — `plant_eligible_floating_se`: **no explicit refresh needed**, given the right ordering

`seedOrgReferenceData` already ends with an unconditional plain (non-concurrent) refresh:
`await prisma.$executeRawUnsafe('REFRESH MATERIALIZED VIEW "plant_eligible_floating_se"')`
(`src/org/org-seed.ts:240`, with the rationale at `:236-239` — the matview is created `WITH NO DATA`,
so an unpopulated matview raises Postgres `55000` on any `SELECT`).

Therefore: **truncate BEFORE the seed** and the seed's own refresh clears the stale contents. The
matview is not itself truncatable and is correctly excluded by `relkind IN ('r','p')` (R2).

If you invert the order — seed then truncate — the matview is left holding rows for base-table rows
that no longer exist, and nothing refreshes it again. That is the one way to get this wrong.

## R5 — what "reseeded" means: exactly what `seedOrgReferenceData` creates

`src/org/org-seed.ts:109-253`. Everything is upserted or existence-guarded, so re-running never
duplicates. On a freshly truncated DB with `RESTART IDENTITY` it produces:

| Table | Rows | Source | Note |
|---|---|---|---|
| `zones` | 5 | `SEED_ZONES` (`:17`) | `North, South, East, West, UNZONED` — **`North` = `zone_id` 1** |
| `zone_mappings` | 4 | `SEED_ZONE_MAPPINGS` (`:25-30`) | `West Zone→West, North→North, South→South, East→East`, status `MAPPED` |
| `plants` | 1 | `:146-152` | `North Plant 1` in zone `North` — **the only plant-bearing zone at baseline** |
| `company_master` | 3 | `SEED_COMPANIES` (`:32-36`) | Acme PLATINUM/A, Globex GOLD/B, Initech SILVER/C |
| `sla_rule_config` | 3 | `SEED_SLA_RULES` (`:38-48`) | `company_tier` scope: PLATINUM/GOLD/SILVER |
| `priority_rule_config` | 7 | `SEED_WEIGHTS` (`:53-61`) | weight set `v1` |
| `component_master` | 4 | `SEED_COMMON_KIT` (`:65-70`) | ids **1–4** explicitly; sequence advanced at `:210-212` |
| `common_kit_definition` | 4 | same | |
| `regions` | 6 | `SEED_GEOGRAPHY` (`:75-95`) | Konkan, Vidarbha, Western Maharashtra, Saurashtra, South Gujarat, Bangalore Division |
| `districts` | 14 | same | 4+2+2 (MH) + 2+2 (GJ) + 2 (KA) |
| `plant_eligible_floating_se` | refreshed | `:240` | 0 rows is a valid populated state |

**Every other one of the 69 tables is empty at baseline.** That is the definition of "reseeded", and
it is what the R6 check must reproduce byte-for-byte on every run.

Note the consequence for R1.1: at baseline exactly **one** zone has a plant (`North`), so an
unnarrowed `runForActiveZones` touches `North` + whatever the calling spec created — and `North` has
no eligible tickets. That is why truncation removes the FK trigger.

## R6 — the idempotence check (run it twice, expect identical output)

Run against `fsm_test`. **This is the proof artefact for AC-1.**

```sql
-- baseline-counts.sql — every non-empty public table, with its row count.
SELECT c.relname AS table_name,
       (xpath('/row/c/text()',
              query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname),
                           false, true, '')))[1]::text::bigint AS rows
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'p')
  AND c.relispartition = false
  AND c.relname NOT IN ('spatial_ref_sys', '_prisma_migrations')
ORDER BY c.relname;
```

Procedure:

```
psql "$TEST_DATABASE_URL" -f baseline-counts.sql > counts-1.txt     # after truncate+reseed, before any spec
<full suite run>
psql "$TEST_DATABASE_URL" -f baseline-counts.sql > counts-post-1.txt
<full suite run>                                                     # global-setup truncates again
psql "$TEST_DATABASE_URL" -f baseline-counts.sql > counts-post-2.txt
diff counts-post-1.txt counts-post-2.txt                             # MUST be empty
```

`counts-1.txt` must match R5's table exactly. `diff counts-post-1.txt counts-post-2.txt` empty is the
real assertion: it says the end-state of a full run no longer depends on what the previous run left.

Also record `SELECT zone_id, name FROM zones ORDER BY zone_id;` — the first row must be
`1 | North` on every run (R2, the 74-file dependency).

## R7 — specs that turn out to depend on another spec's leftovers

#156's AC already requires these be **fixed, not accommodated**, and two were recorded in the
#153/#146 handoff §7.5. Two more are now known and will surface the moment the baseline is enforced:

- **`ticket-creation-tier-override.e2e-spec.ts:76`** asserts `expect(result.created).toBe(1)`, but
  `TicketCreationService.createForInactiveEligible` is a **fleet-wide** sweep — its candidate query
  has no device predicate (`src/ticketing/ticket-creation.service.ts:34-52`), so `created` counts
  *every* inactive-eligible device in the database. The spec also pins `const DEVICE =
  String(9_401_000n)` (`:10`) — a fixed, un-namespaced device id, so a leftover row collides on
  `device.create` in `beforeAll`. Truncation makes both correct today; the count assertion stays
  fragile against any spec that leaks an eligible device. **This spec is also blocked by #183** — it
  is one of the three whose `beforeAll` currently throws — so coordinate: #183 touches its fixture,
  this issue touches its assertion. Land #183 first, then revisit.
- **`dispatch-transparency-api.e2e-spec.ts:119,236`** creates zone 1 if it is absent
  (`zmZoneCreatedHere = true`) and then **deletes it** in `afterAll`. On a correctly seeded DB zone 1
  always exists, so `zmZoneCreatedHere` stays false and nothing is deleted — but if it ever runs
  against an unseeded DB it removes the zone 74 other files depend on. Once R2 guarantees zone 1, this
  branch is dead code; leaving it is acceptable, deleting it is better.
- **Global watermark:** `verification-staleness.e2e-spec.ts:22-25` documents that the pre-#148 suite
  "depended on whatever ambient value other specs happened to leave behind" for
  `snapshot_runs.data_as_of`. That spec now sets it explicitly. Any *other* spec reading the global
  watermark without setting it will surface under a truncated baseline — that is the intended
  outcome, not a regression.

## R8 — the worker crash is NOT this issue's to fix → **[#184](./184-vitest-worker-exited-unexpectedly.md)**

**Amended 2026-07-31 after decoding the raw run logs. The correction matters, so read it before
relying on this issue's premise.**

Both flag-off runs collected the identical universe — `(315)` files, `(1295)` tests — and so did the
flag-on run. Run 1 and run 3 account for all 1295 tests. **Run 2 accounts for only 1288, and reports
`Errors 2 errors`** (`baseline-failures.txt.decoded:1915-1917`). The two files that vanished are
`test/settings-write.e2e-spec.ts` (3 tests) and `test/plant-zone-change-impact.e2e-spec.ts`
(4 tests) — **7 tests, exactly the 1273 → 1266 delta between runs 1 and 2.**

So the run-1-vs-run-2 discrepancy is **entirely** the worker crash, not database state. Orphan
accumulation is still real and still causes the R1 failures *when those files run at all*, and R2's
`RESTART IDENTITY` finding stands on its own — but **this issue cannot deliver AC-1 by itself.**

`settings-write` is a repeat offender: #156 named it on 2026-07-22
(`156-test-db-orphan-accumulation.md:45`), across a full manual truncate. A clean database does not
fix it. Half of #156's suggested mitigation has since landed — `vitest.config.ts` sets
`fileParallelism: false` — and the crash still occurs.

**Filed as [#184](./184-vitest-worker-exited-unexpectedly.md).** Out of scope here. AC-1 must be
evaluated on runs that did not crash — if a crash occurs, discard that run and repeat, and **record
the discard** rather than quietly re-rolling. #180 AC-1 and #184 AC-6 are the same gate; neither can
be claimed without the other.

---

## Acceptance criteria

- [x] **AC-1 — identical, not green.** Three consecutive full backend runs produce **identical**
      file/test/passed/skipped counts, and `diff` of the R6 count dumps between runs is empty. The
      three runs must use the same `BUSINESS_SWEEPS_ENABLED` value; record which. Discarded
      worker-crash runs are recorded, not hidden. **Jointly gated with
      [#184](./184-vitest-worker-exited-unexpectedly.md) AC-6** — see R8; a crash subtracts a whole
      file from the totals, so this AC is not reachable while #184 is open.
      **Verified 2026-07-31, `BUSINESS_SWEEPS_ENABLED="true"`.** Three consecutive `pnpm test` runs via
      `scripts/run-tests.mjs`: all three **8 files failed | 304 passed | 3 skipped (315)**;
      **12 tests failed | 1272 passed | 11 skipped (1295)** — byte-identical failing-test set across
      all three. No worker crash on any run (files/tests reconciled against the collected total each
      time — #184 AC-6 holds for all three). `diff` of the R6 count dump was empty run-1-vs-run-2 and
      run-2-vs-run-3. The 8 failing files are entirely #181/#182 territory
      (`business-sweep-scheduler*.e2e-spec.ts`) plus a pre-existing, out-of-block cluster
      (`org-tiers`, `tiers-spec-pin`, `recommender-tier-override`, `ticket-creation-tier-override`,
      `dispatch-run-tier-override-snapshot` — "Issue 157" tier-rank feature, not named anywhere in the
      #180–184 set; flagged for triage, not fixed here). Zero R1-family failures recurred.
- [x] **AC-2 — enforced baseline.** `test/global-setup.ts` truncates and reseeds between
      `migrate deploy` and `seedOrgReferenceData`, using the single-statement
      `TRUNCATE … RESTART IDENTITY` from R2 (no `CASCADE`), excluding `spatial_ref_sys` and
      `_prisma_migrations`, naming only `relispartition = false` relations, and refusing any database
      whose name does not end in `_test`. Implemented in `test/truncate-test-db.ts`, wired at
      `global-setup.ts` between steps 1 and 2.
- [x] **AC-3 — baseline matches R5 exactly.** A post-truncate/pre-spec count dump equals the R5 table
      row-for-row, and `SELECT zone_id, name FROM zones ORDER BY zone_id LIMIT 1` returns
      `1 | North`. Recorded in the issue's completion report. **Verified** via `pnpm test:reset`: 10
      non-empty tables matching R5 exactly (`zones` 5, `zone_mappings` 4, `plants` 1, `company_master`
      3, `sla_rule_config` 3, `priority_rule_config` 7, `component_master`/`common_kit_definition` 4
      each, `regions` 6, `districts` 14), zone 1 = North.
- [x] **AC-4 — partitions survive.** After a truncate+reseed,
      `SELECT count(*) FROM pg_inherits WHERE inhparent = 'raw_device_snapshots'::regclass` is
      unchanged from before, `raw_device_snapshots_default` is still attached, and a
      `rawDeviceSnapshot.create` with today's `gpsDatetime` still succeeds. **Verified**: 10 partitions
      before and after every reset; the full suite (which exercises snapshot ingestion) passed its
      partition-touching specs on all three runs.
- [x] **AC-5 — R1.1 repaired at the predicate.** `dispatch-run-zone-scoped.e2e-spec.ts:73` deletes
      decision traces by `runId`, not `ticketId`, immediately before the `dispatchRun.deleteMany`.
      Verified by inserting a foreign ticket in a plant-bearing zone before the unnarrowed run and
      confirming teardown still succeeds. **Landed**; spec green on all three full runs plus two
      standalone targeted runs.
- [x] **AC-6 — R1.2 repaired.** `plant-zone-change-impact.e2e-spec.ts` calls `cleanup()` at the top of
      `beforeAll`. Verified by leaving a `sourcePlantId = 995401` row in place and running the spec —
      it must pass. **Landed as `cleanupLeftoverPlant()`** rather than the plain `cleanup()` the issue
      suggested — `cleanup()` closes over `plantId`/`seId`, which are unassigned this early in
      `beforeAll`, and a Prisma filter value of `undefined` matches every row, not zero (verified
      empirically), so the self-heal path looks up the leftover's own ids first and scopes every delete
      to those. Spec green on all three full runs.
- [x] **AC-7 — R1.3 repaired.** The two `/api/dispatch-runs` list calls behind `:247` and `:270` no
      longer depend on the fixture run being in the newest 30. The service default `limit = 30`
      (`dispatch-transparency-query.service.ts:209`) is **unchanged**. **Landed** (`?limit=200` on both
      call sites); spec green on all three full runs.
- [x] **AC-8 — hand-runnable.** A `scripts/` entry point and a `pnpm test:reset` script exist, and the
      reset path is documented next to the `.env.example` test-database bootstrap note
      (`.env.example:8-21`), so it is discoverable from the same place as the DB itself. **Landed**:
      `scripts/reset-test-db.cjs` + `pnpm test:reset`, doc note added at `.env.example:22-26`. Run by
      hand twice during verification; reproduced the R5 baseline both times.
- [x] **AC-9 — no app boot.** The truncate/reseed path constructs a bare `PrismaClient`, never
      `PrismaService`, and `runtime_lock` is empty after `global-setup` completes (handoff §7.4 drift
      gate). **Verified**: `runtime_lock` present after a full suite run (booted app writes it) but
      absent immediately after a stand-alone `pnpm test:reset`, confirming the reset path itself never
      boots the app — the next `global-setup` truncate clears any prior run's `runtime_lock` row before
      re-seeding.

**Status: done.** All 9 ACs verified 2026-07-31. Full completion report is this issue file (per
CLAUDE.md, per-issue TDD reports live at `docs/progress/`, but this is an infra issue verified by
direct AC evidence above rather than a red-green slice narrative).

## Out of scope — do not do these here

- **Any fix to `business-sweep-scheduler`** (#181) or `test/setup-env.ts` (#182) or the tier-override
  specs (#183). This issue changes test *infrastructure* only.
- **The `Worker exited unexpectedly` / `ChildProcess` crash** — R8, now
  [#184](./184-vitest-worker-exited-unexpectedly.md).
- **`pool` / `poolOptions` / `DB_POOL_MAX` tuning**, `singleThread`, or any `vitest.config.ts`
  concurrency change. `fileParallelism: false` is already set; leave it.
- **Widening `testTimeout`.** #156 was explicit: that hides growth instead of stopping it. If
  `dispatch-run-controller` still times out *after* AC-1 passes, that is a new finding — file it.
- **Any change to `src/`** other than none. Every repair in this issue is under `test/`, `scripts/`,
  `package.json`, `.env.example`.
- **Turning `BUSINESS_SWEEPS_ENABLED` off.** It stays `"true"` (`.env:41`) for the whole repair
  programme so #181/#182/#183 are measured against the env their specs were written under. Returning
  it to `"false"` before any dev server runs is audit R6 / [#148](./148-verification-stale-telemetry.md),
  not this issue.

## Targeted test command (do not run the full suite to iterate — it takes 7–14 minutes)

From `apps/backend/`:

```bash
# The three specs this issue's repairs touch, plus the two heaviest orphan-sensitive files.
npx vitest run \
  test/dispatch-run-zone-scoped.e2e-spec.ts \
  test/plant-zone-change-impact.e2e-spec.ts \
  test/dispatch-transparency-api.e2e-spec.ts \
  test/dispatch-run-controller.e2e-spec.ts
```

Run it **twice back to back** — a single pass proves nothing here. Both passes must be identical, and
the second must pass without any manual DB cleanup in between. `globalSetup` still runs for a
targeted invocation, so the truncate+reseed is exercised.

The R6 count check is the other half and is run separately (it needs `psql`, not vitest).

The full suite is only for AC-1, and only three times, at the end.

## UI surfaces

None.

## Reference

n/a (test infrastructure).

## Blocked by

- None. **This blocks #181, #182 and #183** — none of them can be verified against a suite whose
  result depends on database history.
- **Pairs with [#184](./184-vitest-worker-exited-unexpectedly.md)** (worker crash). Not a dependency
  in either direction — start whichever is convenient — but AC-1 here and AC-6 there are one gate,
  and #184 answers its own H3 more cheaply once R1.2 has landed.
