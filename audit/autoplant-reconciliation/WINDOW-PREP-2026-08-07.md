# #218c window prep — for operator approval

Status: **awaiting explicit operator approval.** Nothing below has been executed. This consolidates
Step 3 of the 2026-08-07 session plan: recommended time, the SE-team note, what gets watched during
the run and what stops it, and the rollback position.

---

## 0. One decision this session surfaced that the approved plan didn't specify — execution path

`FIX-PLAN.md` §7.5 step 4 says "a single manual `autoplant:sync pipeline`" — the hand-built CLI runner
(`autoplant-sync.ts`). That was written before 218b existed, when the CLI runner was the *only* path
that reliably resolved `DeviceDepartureService` (it constructs the service by hand, so it never
depended on the broken Nest DI wiring). Two things changed since:

- **218b fixed the Nest-wired path** — the one the scheduler and `POST /api/integration/run-pipeline`
  resolve through. `master-sync-di-wiring.e2e-spec.ts` proves this in a test harness (a real
  `AppModule`), but the **production process has not yet exercised it**: the live `dist/main.js` on
  this machine is still running the pre-fix build (`f813b39-dirty`, booted 2026-08-06 17:55 IST).
- The whole #218 investigation's finding was "code that was correct but never ran where it mattered."
  Running the catch-up through the CLI script again would prove the *logic* works (already proven,
  repeatedly, since 128) but would **not** prove the Nest-wired path — the one that actually matters
  day to day — is fixed in production. It would leave that specific claim resting on a test harness
  only, for however long until the next real scheduled/API-triggered sync happens to run.

**Recommendation: deploy the fix (restart the live process) and trigger the catch-up through
`POST /api/integration/run-pipeline`** (OPERATIONS_HEAD-only, `IntegrationSyncController` →
`IntegrationSyncService.runPipeline()` → the same `MasterSyncService.sync()` the DI spec exercises).
This makes the catch-up double as the production proof the fix resolves where it matters, closing the
loop the whole issue is about. The CLI script remains a documented fallback if the operator prefers not
to restart the live process for this — flagging the tradeoff rather than deciding it, since it's a
change to what the approved plan named.

---

## 1. Recommended time, and why

**Monday 2026-08-10, ~04:00 IST.** Full reasoning, including a cron collision found while preparing
this note that the original plan didn't account for, is in
[`SE-TEAM-NOTE.md`](./SE-TEAM-NOTE.md) (§ "Why Monday 2026-08-10..."). Summary:

- The dispatch scheduler fires daily at **05:00 IST** and writes the same `tickets` /
  `plant_batch_assignments` tables — 04:00 IST leaves an hour of buffer against a transaction measured
  at well under 2 minutes (§3 below).
- The SE note needs real lead time to be an honest "tell us before X" — 2026-08-10 gives ~2.5 days if
  sent today.
- A weekday morning has more people around if something needs attention; nothing here is time-critical
  enough to trade that for two fewer days of an already-known, already-detected drift.

**Faster alternative:** Saturday 2026-08-08, ~04:00 IST is mechanically ready today. The only cost is
compressed SE-note lead time and lighter weekend coverage — a real option since SE ticketing isn't in
real operational use, not a technical blocker. Operator's call.

---

## 2. The SE-team note

Full draft: [`SE-TEAM-NOTE.md`](./SE-TEAM-NOTE.md). Filled in with the recommended date/time above;
not sent. Carries the exact closure signature so the team can isolate the whole set from a query, and
states plainly that closure is one-way and batch rows are not touched.

---

## 3. What gets watched during the run, and what stops it

**Before triggering the write (last chance to not run it):**

| Check | Command | Stop if |
|---|---|---|
| Notification seam still inert | `autoplant:window-preflight` | exit ≠ 0 |
| Scheduler still off | same tool, second half | exit ≠ 0 (re-verified fresh, never assumed) |
| Final plan re-read | `autoplant:departure-dryrun` | departures/restores drift from the three prior reads (5,230–5,240 / 1,144–1,149) by more than a few percent, **or** `guardTripped: true` — the absence path would silently abort, applying only the SOURCE_STATUS cohort and leaving MISSING_FROM_SOURCE devices exactly as wrong as they are today |

None of these have failed in three attempts today. If the final pre-write read disagrees with the
prior three, that is new information arriving at the worst possible time — stop and explain, per the
same "do not smooth over a gap" standard as Step 2, rather than proceeding on the older numbers.

**During the write.** The departure/restore/ticket-closure step is **one atomic
`prisma.$transaction`** (`device-departure.service.ts:212`) — Postgres either commits the whole thing
or none of it. There is no real "partway" inside that transaction to stop; the meaningful watching
happens right after it returns:

- `sync().status` — must read `SUCCESS`. Anything else: **stop, do not retry blindly.** Read the
  captured `error` on the `master_sync_runs` row first; a transaction that failed rolled back cleanly
  (see §4), so retrying without understanding why risks repeating the same failure.
- `entity_stats.departures.inserted` / `.updated` — must be non-zero. This is literally the counter
  that read `{0,0,0}` for 27 runs; seeing a real number here for the first time is part of the
  verification, not a formality.
- The service's own log line (`"Departure reconcile: +N departed (...), -M restored, K tickets
  cancelled"`) — N/M/K should land within the same few-percent band as the final pre-write dry-run.

**Immediately after — the independent re-measure, all five, not a subset** (per the operator's
existing instruction not to check only one signal):

| Reading | Expected |
|---|---|
| `lifecycle.drift` | **0** |
| `lifecycle.missingFromSource` | ~2,436 |
| `lifecycle.quietRuns` | **0** |
| FSM operational, Nuvista | **~7,705** vs Excel Deployed **7,650** (materially below ~7,600 or above ~7,800 means something is wrong) |
| A sample of the Check-7 vehicles | `isDeparted` → **false** |

Any one of these landing outside range is a stop-and-diagnose signal even though the data is already
committed — see §4 for what that means in practice.

---

## 4. Rollback position — what state the data is in, and what recovery takes

**Before the departure/restore step, within the same sync:** company/plant/vehicle/transporter mirror
upserts run first, each independently committed (not part of the same transaction). If the process
fails before reaching the departure step, nothing about tickets or departures is touched at all, and
the mirror upserts are idempotent — harmless, self-correcting on the next run.

**The departure/restore/ticket-closure step itself is atomic.** ~5,230 departures + ~1,149 restores +
~4,374 ticket closures + ~4,374 `ticket_events` inserts commit together or not at all
(`device-departure.service.ts:212-216`). A mid-transaction failure (DB connection drop, constraint
violation) rolls back to exactly the pre-run state — zero partial effect. `sync()`'s outer `catch`
marks the run `FAILED` with the error captured (`master-sync.service.ts:372-375`); nothing needs
manual cleanup.

**If the process dies between commit and the run being marked `SUCCESS`:** the departure/ticket data is
already durably committed by Postgres regardless — only the `master_sync_runs` row is left `RUNNING`.
The existing stale-run reaper (`src/ingestion/stale-run.ts`) auto-marks any `RUNNING` row older than 30
minutes `FAILED` on the next `startRun()`, so this self-heals without manual DB surgery. The run's data
effect is unaffected either way — this only fixes the bookkeeping.

**What recovery does NOT mean — this is not an undo button, and I'd rather say so plainly than let
"rollback" imply more than it is.**

- `device_departures` rows are never hard-deleted (established across the whole investigation).
  Restores happen automatically the next time a device is observed operational — there is no
  on-demand "un-depart," only "wait for reality to change, or for the next sync to see it."
- **Ticket closures are genuinely one-way.** The SE note already states this: a restored device does
  not reopen its old ticket. If the window closed something it shouldn't have, the fix is a *new*
  ticket, not reopening the old one — the closed ticket's `closed_at`/`closure_type`/audit trail stay
  as the historical record on purpose.

So "if it goes wrong midway" mostly cannot happen in the sense the phrase implies — the transaction's
atomicity means there is no midway. What *can* happen is the transaction completing successfully but
the independent re-measure disagreeing with the falsifiable predictions (§3) — that is a diagnose-and-
possibly-correct-forward situation, not a rollback, and is exactly why `/diagnose` is on the suggested-
skills list for a follow-up session if it happens.
