# #324 — Per-row degradation on the masters path, and the removal of a resume that never resumed

**Findings:** F13 + F4 (forensic report §3 ingestion segment) · **Wave 4** · P3
**Landed:** 2026-09-03 · branch `feat/autoplant-integration`
**Issue:** [`.scratch/fsm-platform-v1/issues/324-master-sync-row-degradation-dead-machinery.md`](../../.scratch/fsm-platform-v1/issues/324-master-sync-row-degradation-dead-machinery.md)

---

## F13 — one dirty source row could fail the entire masters run

`BigInt(String(row.plant_id).trim())` and the `.trim()` on each name column throw on a null or
non-numeric value, and nothing caught them. One malformed row therefore aborted the **whole** sync —
every plant, company, transporter, vehicle and device — on every run, until somebody fixed the source
by hand. The telemetry path has answered this shape since #299 (`UNPARSEABLE_TIMESTAMP`: drop the row,
count it, keep draining); the masters path predates that accounting and never got it.

"Authoritative PKs cannot be dirty" is an assumption, not a guard — and this source has already broken
the same assumption twice in equally authoritative columns, both fixed one slice earlier in #323: a
`0000-00-00` datetime and an `'NA'` device id.

### The shape of the guard

`identityProblem(sourceId, name)` and `vehicleIdentityProblem(vehicleNo)` in `master-mapping.ts`, called
by the service **before** the mapper. The mappers keep assuming clean input — now guaranteed rather than
hoped for — and the accounting stays where the run's other skip reasons already live (`entity_stats`
per-reason counters plus a `master_sync_rejects` row carrying the offending key).

**The name is identity, not decoration.** It is NOT NULL on every mirror table and is what each operator
surface renders; a row that cannot answer "which plant is this?" is not partially usable, it is unusable
with a number attached.

**One reason code, `UNPARSEABLE_IDENTITY`,** rather than `BLANK_ID`/`BAD_ID`/`BLANK_NAME`. The operator
action is identical for all of them — go and look at that source row — and the reject row carries the
key that locates it.

Two placement decisions worth recording:

- **Transporters had no skip site at all** because the stage was a `.map()`, which has nowhere to put
  one. It is a loop now.
- **The vehicle guard filters once, at the read**, rather than at each of the three loops below it —
  all three reach for `v.vehicle_no.trim()` and would throw on the same row. The raw read is kept for
  `devices.observed`, which is defined as the source catalog size *regardless of mirror outcome*: a
  dirty vehicle's fitted device still exists at the source, and the observed-vs-mirrored gap is exactly
  what that counter is for. Its device is deliberately **not** also counted as a device skip — one bad
  row is one named event, and the vehicle-level reject already carries the key.

### The trade, stated because it is real

A skipped master row leaves its FSM mirror row **stale** rather than failing loudly. That is the same
trade #299 made on the telemetry side, and it is only acceptable because the skip is counted per reason
and enumerable from `master_sync_rejects` — which is what #300's surfacing reads. It is written into the
code comment, not just here.

## F4 — a resume cursor nothing resumed from

`snapshot_runs.cursor` held an optimistic cross-run re-read floor: on a PARTIAL run it dropped back to
the first failed chunk's lower bound so the next run would re-read that window.
`SnapshotRunService.lastResumeCursor()` read it back.

The reader that was supposed to honour it was then built the other way **on purpose**. From its own
docblock: *"There is deliberately NO cross-run resume cursor: correctness must not depend on a persisted
watermark."* `AutoPlantSourceReader` restarts from `cursor = null` and keyset-scans every device by
`device_id` on every run, so the failed window is re-read regardless, and `ON CONFLICT DO NOTHING` on
`(device_id, gps_datetime)` makes the overlap free.

So the only consumer of the machinery was its own test, which supplied a `ResumeAwareSourceReader` that
existed nowhere else. That is worse than dead code: a persisted value with a documented meaning that no
production path honours reads as a guarantee to the next person, and this one had already been quoted
back inside the worker as if it were true.

**Removed, not labelled** — the issue's stated default, and the right one here for that reason.
`lastResumeCursor`, the `cursor` parameter on `finishRun`, the `firstFailedLowerBound` accumulator, the
`minDate` helper that fed it, and `test/snapshot-partial-cursor.e2e-spec.ts` are all gone. The removal
is pinned by a new case in `snapshot-run-lifecycle` asserting a finished PARTIAL run leaves `cursor`
null and the service exposes no resume reader, so it cannot be quietly revived.

**The column stays.** Dropping it needs a migration for no behavioural gain, it is nullable, and the
values already stored are honest history of the design that once wrote them. `schema.prisma` says so at
the field, which is the "record the decision" the issue asked for. **No migration; the drift baseline is
untouched** (a `///` doc comment produces no SQL). The Prisma client was regenerated so the embedded
schema string stays in step.

### One premise of the issue was stale and is corrected here

The issue states that `SnapshotRun.chunkStats` "is never written". **That is no longer true and must not
be acted on.** #299/#300 landed after the forensic report was written: the worker writes
`chunkStats: { rejected, repaired }` at `snapshot-ingestion.worker.ts`, and two things read it —
`ingestion-alert.ts` and `snapshot-query.service.ts`. Deleting it as dead would have destroyed the
containment accounting #300 exists to surface. Verified against the source before touching anything;
`chunk_stats` is untouched by this slice.

## Verification

- `test/master-sync-row-degradation.e2e-spec.ts` — 6 cases. Red first with the finding's own errors:
  `Cannot convert NA to a BigInt`, `Cannot convert NULL to a BigInt`, `Cannot convert x-7 to a BigInt`.
  Covers a dirty id and a blank name on plants, a dirty company that must not take the plant
  referencing it, a dirty transporter, a blank `vehicle_no`, and a clean run asserting **no phantom
  skips**.
- Removal pinned in `snapshot-run-lifecycle.e2e-spec.ts`; three existing specs that passed
  `cursor:` to `finishRun` updated to assert `data_as_of` instead — the write each case actually cared
  about. (`tsc --noEmit` does not cover `test/`, so those surfaced from the suite, not the typechecker.)
- 45-file ingestion + master-sync + snapshot regression surface — 332/332.
- Full backend suite with #323: **456 files, 2,441 passed, 5 skipped, zero failures**, five batches,
  every batch exit 0 (one #184 worker-crash retry in batch 2, recovered clean).
- `npx tsc --noEmit` clean.

## Acceptance criteria

- [x] **AC1** — one dirty source row cannot fail a masters run.
- [x] **AC2** — no persisted value exists that nothing consumes. The resume cursor's write and reader
      are removed; the column is kept, unwritten, and labelled at the schema. `chunk_stats` was checked
      and is live, not dead.

`UI surfaces: n/a`.
