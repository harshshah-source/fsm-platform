# HANDOFF — commissioning capture (`first_reported_at` + `device_commissioning`)

**Live handoff. Opened 2026-08-09.** Uncommitted working-tree state a next session must recover.
Archive it to `docs/archive/` with an ARCHIVED banner the moment it is consumed (CLAUDE.md).

Owning context: `audit/commissioning-view-feasibility.md` §7.2/§7.3 ·
[#223](./issues/223-ndd-counted-healthy.md) (its MVP step 1 is the same AutoPlant read) ·
[#222](./issues/222-telemetry-staleness.md) (owns the offset this code deliberately does not inherit) ·
[#228](./issues/228-guard-pattern-remediation.md) (the missing-test findings below are its specimen class)

## Why this is parked and not committed

The work is **two halves, and only one of them is finished.** Committing it as it stands would
publish a 220-line spec that cannot pass and a table nothing writes to, which is precisely the
"looks finished, isn't" shape this backlog has been correcting all week (#190, #184, #99, #176, #91).
Committing it also is not free: it is easier to finish the writer than to explain the gap forever.

**The database side has been applied anyway**, because leaving it unapplied was actively breaking the
tree — see the divergence note below.

## State of the tree

| Path | State |
|---|---|
| `apps/backend/prisma/migrations/20260809120000_device_commissioning/` | **untracked; APPLIED to `localhost:5433`** |
| `apps/backend/prisma/schema.prisma` | uncommitted — `DeviceCommissioning` model + 2 `DeviceState` columns |
| `apps/backend/src/ingestion/normalize.ts` | uncommitted — `TRUE_SOURCE_UTC_OFFSET_MIN = 0`, `gpsDatetimeUtc` |
| `apps/backend/src/ingestion/source-reader.ts` | uncommitted — optional `gpsDatetimeUtc` on `SourceSnapshotRow` |
| `apps/backend/src/ingestion/snapshot-ingestion.service.ts` | uncommitted — chunk-min in true UTC, `COALESCE` write-once |
| `apps/backend/test/device-commissioning.e2e-spec.ts` | untracked — **red by construction** |

### ⚠ Deliberate divergence: the migration is applied but its file is uncommitted

Recorded here rather than left to be discovered. `prisma migrate deploy` was run against
`localhost:5433` on 2026-08-09 (PG 16.14; the migration's PG-15 guard passes). Verified after
applying: both `device_states` columns exist, `device_commissioning` exists, and
`device_commissioning_device_id_vehicle_id_installed_at_key` carries
`pg_index.indnullsnotdistinct = true` — the modifier Prisma 7.8 cannot express and whose loss would
mean unbounded duplication on a daily cron.

**It was applied because not applying it was the more dangerous state**: the uncommitted ingestion
code writes `first_reported_at`, so with the migration pending the next snapshot ingest would have
thrown on a column the database did not have. Applying it also starts the only irrecoverable clock in
this backlog — a first-ever ping is observable exactly once, and `raw_device_snapshots` drops
partitions after 7 days, so every day not captured is permanently unmeasurable (feasibility §3).

Consequence to keep in mind: `_prisma_migrations` now holds a row for a migration file that is not in
git. **Do not regenerate or re-create this migration.** If the working tree is ever reset, restore
the migration directory from this session's changes rather than letting `prisma migrate dev` author a
replacement — it will offer one without `NULLS NOT DISTINCT`, and accepting it silently breaks
append-only-ness (`installed_at` is null on ~13% of source rows, `vehicle_id` on unmapped fitments,
and `NULL <> NULL` re-inserts every one on every sync).

## What is missing — three things, stated plainly

### 1. There is no writer. `device_commissioning` is a table nothing fills.

A repo-wide grep finds `device_commissioning` in exactly three places: generated Prisma code, the
migration, and the spec. **`master-sync.service.ts` and `master-mapping.ts` are untouched.**
`VehicleMasterMasterRow` has neither `first_installed_date_time` nor `first_installed_by`, though
`device-commissioning.e2e-spec.ts` constructs rows carrying both.

So the spec is a genuine TDD red — the test is written, the implementation is not — but nothing in
the tree says so, and `git status` reads it as finished work.

### 2. Those type errors are invisible to every check this repo runs.

- `apps/backend/tsconfig.json` has `"include": ["src/**/*.ts"]`. **`test/` is never typechecked.**
  `pnpm typecheck` passing says nothing about any spec file.
- Vitest transpiles with SWC, which strips types without checking them.

Net effect: the spec compiles and runs, silently drops the two unknown fields, and fails on its
assertions instead of failing at the type error that is the actual cause. Whoever picks this up will
see a confusing runtime failure, not "you never added these fields".

### 3. Nothing tests `first_reported_at`. Not one file.

`grep -rl "firstReportedAt\|first_reported_at" apps/backend/test` returns **nothing**. This is a
write-once column, on a deliberately non-standard offset contract (true UTC, offset 0, *not* the live
`AUTOPLANT_UTC_OFFSET_MIN = 330`), with zero coverage — and write-once means a wrong value is
permanent, since nothing revisits it. It is exactly #228's specimen class: a value that cannot be
re-derived, guarded by nothing.

Note the expected, self-healing oddity a test must encode rather than "fix": until #222 lands,
`first_reported_at` may read **later** than `latest_gps_datetime` on the same row, because one is
written at offset 0 and the other at +330. The migration's column comment says so, and warns against
adding a `first_reported_at <= latest_gps_datetime` CHECK before then.

## To finish

1. **Write the writer as ONE change with #223's MVP step 1.** #223 step 1 says "add
   `devices.installed_at`, read `FIRST_INSTALLED_DATE_TIME` in the master sync"; this table needs the
   same read plus `FIRST_INSTALLED_BY` and `INSTALLATION_REMARK`. Done separately, the same AutoPlant
   read gets implemented twice, in two conventions. Add the fields to `VehicleMasterMasterRow`, map
   them, and write `INSERT … ON CONFLICT DO NOTHING` (the `raw_device_snapshots` idiom) — inert, so a
   commissioning failure can never fail the sync carrying it.
2. **Add the `first_reported_at` test** the column has never had: write-once (a later, earlier ping
   must not displace it), chunk-min not chunk-max, offset 0 recorded in `first_reported_offset_min`,
   and a null `gpsDatetimeUtc` leaving the column unset rather than writing an unknown convention.
3. **Then commit all of it together**, including the migration file.

Do not commit the migration on its own to tidy `git status`. An applied migration with no writer and
no test is a worse record than an honest handoff.

## What this is NOT blocked on

`first_reported_at` capture is **independent of #222 and #223** (feasibility §8) and is already
running — the column is live and filling from the next ingest onward. Nothing above needs to wait for
the state-model rewrite. The *published figures* do need #222, but the capture does not.
