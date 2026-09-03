# #300 — Persistent-PARTIAL ingestion is an alert-grade state, not a log line

**Landed 2026-09-02** · branch `feat/autoplant-integration` · issue
[`.scratch/fsm-platform-v1/issues/300-persistent-partial-ingestion-alert.md`](../../.scratch/fsm-platform-v1/issues/300-persistent-partial-ingestion-alert.md)
· finding AR-1/AR-2 surfacing + F10, `audit/2026-09-01-scheduler-engine-forensics.md` §7

## What was wrong

#299 made a poison row survivable. It did not make it **visible**.

When ingestion wedges — one unparseable timestamp that kills the deterministic scan at the same row
every run, one out-of-range value that fails its 90-row chunk through all three retries — every run
finalizes PARTIAL. The #230 gate then correctly refuses to derive device state, run auto-recovery or
open tickets on a read that covered part of the fleet. That refusal is right, and it is loud in the
logs.

It surfaced nowhere an operator looks. The freshness banner read `data_as_of` from the last SUCCESS
run and rendered its ordinary grey "data as of 10:00" line — the same line it renders when everything
is fine. Nothing anywhere aggregated the run-to-run streak, named the chunk that kept dying, or said
that three downstream stages had been switched off since the wedge began. An operator's only signal
was a timestamp quietly getting older, with no statement of why, on a page that otherwise looked
healthy.

Two smaller pieces of the same shape:

- **F10** — the worker persists `data_as_of` on a PARTIAL run; the banner read only SUCCESS runs;
  `AutoPlantHealthService.snapshotHealth` read the newest run with any `data_as_of` at all. Three
  components, two different beliefs about what that column means, nobody's decision written down.
- **#299's counters** — the rejected/repaired tallies rode `SnapshotRunResult` and a WARN log. They
  answered the caller standing right there and ceased to exist the moment the process moved on, which
  is precisely when an operator starts asking what the pipeline threw away.

## Root cause verified against the tree

Confirmed on the current working tree before touching anything:

| Claim in the issue | Verified |
|---|---|
| banner reads `data_as_of` from the last SUCCESS only | `snapshot-query.service.ts` `latest()` — `where: { status: 'SUCCESS' }` |
| worker persists `data_as_of` on PARTIAL (F10) | `snapshot-ingestion.worker.ts` — `dataAsOf: status === 'FAILED' ? null : dataAsOf` |
| the two components disagree | `health.service.ts` `snapshotHealth()` — `where: { dataAsOf: { not: null } }`, i.e. PARTIAL counts there and not in the banner |
| nothing aggregates run health | no reader of `snapshot_runs` streaks anywhere in `src/`; the health surface reports identities, freshness and build attribution only |
| #299's tallies are not queryable | `chunk_stats` had **zero** readers and **zero** writers outside generated Prisma code |
| the gate skips three stages | `integration-sync.service.ts` `runPostIngestStages` — derivation, auto-recovery, ticket creation, all behind `ingestComplete` |

## What was built

One derivation, two surfaces, no new table.

**`src/ingestion/ingestion-alert.ts` (new)** — the whole rule set, pure. Counts the leading block of
non-SUCCESS *finalized* runs (RUNNING is skipped, not counted and not treated as a reset — an
in-flight retry must not make a wedged pipeline read as recovered), folds #299's per-run tallies
across that streak, picks the newest FAILED chunk with its verbatim error, and decides whether the
identical error recurs on *every* run of the streak. Alerts at `streak >= threshold`
(`INGESTION_PARTIAL_STREAK_RUNS`, default 3 — ~1.5 h at the 30-minute telemetry cadence) **or** on a
repeating chunk error, which fires a run earlier because a chunk that fails, is re-read from the
PARTIAL resume floor and fails identically is not going to fix itself.

`downstreamGated` is deliberately *not* gated on the threshold: the #230 gate is per-pass, so it is
true from the first non-SUCCESS run. A single blip is not alert-grade, but claiming freshness while a
stage was skipped is wrong at every streak length.

**`prismaIngestionAlertSource` (in `snapshot-query.service.ts`)** — the two reads, exported so
`AutoPlantHealthService` renders the OH card from the same rows the banner reads. The chunk query is
skipped entirely when the newest run succeeded, which is the steady state and the state this is
polled in from every admin page on a 60-second timer.

**Banner (`SnapshotBanner.tsx`)** — a gated pipeline now *replaces* the grey freshness line rather
than sitting beside it: amber while it is one bad pass, red once the streak is alert-grade, naming
the paused stages in plain language. `partialDataAsOf` renders as "Partial data through …".

**Card (`IngestionAlertCard` on the Build Health page)** — self-gating, renders nothing in the steady
state, and when it does render it names the four things needed to act: how long, which chunk and
error (and whether it repeats), what was dropped or repaired by reason, and which stages have been
off the whole time.

## Two decisions taken

**1. The #299 tallies are now persisted — a deliberate deviation from "no writer change".**

The issue's Implementation-boundaries line says no writer change; its Intended-behavior and
Dependencies lines require the card to show rejected-row totals by reason. Those cannot both hold
while the counters live only in a return value. The resolution keeps the boundary's *intent* — run
finalization semantics untouched — and gives up its letter: `finishRun` now also writes
`{ rejected, repaired }` into `snapshot_runs.chunk_stats`, a JSONB column present since the original
schema and never once written to. No column, no migration (so the issue's "DB: none" holds), and no
input to the SUCCESS/PARTIAL/FAILED verdict, the #230 gate or the retry logic, all of which are
computed exactly as before and passed in unchanged.

`{}` and NULL are kept meaningfully different: a clean post-#300 run writes `{ rejected: {},
repaired: {} }` ("nothing was dropped"), while a pre-#300 row stays NULL ("we do not know"). The
reader treats any malformed shape as the latter.

**2. F10: the PARTIAL watermark stays, and is reported under its own name.**

Of the issue's two options, the PARTIAL `data_as_of` write is load-bearing — the PARTIAL resume floor
and integration-health freshness both read it — so "document it as diagnosis-only" was not available
without breaking something. The recorded decision is therefore option A: the value is real, it is
reported, and it is reported as `partialDataAsOf` / "Partial data through …", never as `dataAsOf`.
The plain "data as of" figure stays SUCCESS-only, because a partial read must not advance the number
an operator reads as covering the whole fleet. Written at the `finishRun` call site (the line the
finding pointed at) and on the `partialDataAsOf` field.

## Tests

Red-before-green proven for each behavioural claim, by reverting the fix and re-running:

| Reverted | Failing |
|---|---|
| `chunkStats` pass-through in the worker | 3/15 `snapshot-worker.e2e-spec.ts` |
| `gated`/`wedged` in `SnapshotBanner` | 3/8 `snapshot-banner.test.tsx` |
| `<IngestionAlertCard/>` on the page | 3/9 `build-health-page.test.tsx` |

- `test/ingestion-alert.spec.ts` (new, 16) — streak arithmetic without a database: isolated PARTIAL
  does not alert but *is* gated; threshold reached; FAILED counts alongside PARTIAL; SUCCESS resets;
  no runs at all is not a wedge; newest failing chunk named; repeat detected across runs but **not**
  across two chunks of one run, and **not** across two different errors; chunks outside the streak
  ignored; tallies summed over the streak only; malformed `chunk_stats` survived; the threshold knob;
  and the steady state issuing no chunk query.
- `test/ingestion-alert.e2e-spec.ts` (new, 7) — the same rules through Prisma against the real
  ledger, plus the AC2 pin (`banner.ingestion` deep-equals the card) and the F10 pin (SUCCESS
  watermark held while the newer PARTIAL one is reported separately; an older PARTIAL one is not
  reported at all). Anchored on seeded runs carrying the highest `run_id`s, with a seeded SUCCESS as
  the barrier — the #218 `quietRuns` technique, for the #215 reason.
- `test/snapshot-worker.e2e-spec.ts` (+3) — tallies persisted on a SUCCESS run, `{}` written for a
  clean run, and persisted on a run that degraded to PARTIAL (the case they are actually needed for).
- `test/snapshot-banner.test.tsx` (+4) — gated state replaces the freshness line and names the paused
  stages; the PARTIAL watermark renders under its own name while "data as of" keeps the SUCCESS one;
  a wedged streak escalates to red; a recovered run returns to the quiet grey line.
- `test/build-health-page.test.tsx` (+5) — card names streak/chunk/error/repeat, reports rejected and
  repaired separately, says so when a read failure left no chunk to blame, and renders nothing both
  when healthy and when the payload predates #300.

## Validation

- Backend affected surfaces (14 files, 93 tests): ingestion-alert ×2, snapshot worker / api /
  lifecycle / partial-cursor, integration health ×2 + reconciliation + sync-api + scheduler +
  sync-tickets, lifecycle-health, autoplant-health — all green.
- Full backend suite, exit 0: **438 files collected** (436 before this slice + its 2) and **2331 tests
  collected** (2305 + its 26), **zero failures**. The main pass printed `434 passed | 3 skipped` and
  `2322 passed | 5 skipped`; a #184 worker crash dropped `intraday-updates-controller.e2e-spec.ts` from
  it and the harness's targeted retry ran its 4 tests green, so all 438 files are accounted for.
  Comparing the collected totals rather than the main-pass ones is deliberate — the baseline run had a
  crash-retry too, so its main-pass numbers exclude a different set of files.
- Admin suite: **119 files / 829 tests** green (was 820).
- `tsc --noEmit` clean in backend and admin.

## Follow-ups

None filed. Two things this slice deliberately did not do, both already owned elsewhere:

- The alert is an in-app read surface only. No push/notification channel — explicitly out of scope in
  the issue, and there is no notification transport to hang it on yet.
- `chunk_stats` is written from now on; historical runs stay NULL. The card reads a NULL run as "no
  information", not as "nothing was dropped", so no backfill is needed and none is proposed.
