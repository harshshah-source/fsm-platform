# #250 — Recommender dry-run seam + target-date parameters

**Done 2026-08-19.** Backend only. The engine foundation the admin Scheduler Preview (#251) stands
on. Independent of the recycling track; #240 was sequenced ahead so the planner date was already IST
before it got parameterised.

## The constraint that shaped this

Approved Decision 1/18: the preview must project the **real** recommender, never a second scheduling
implementation. That rules out the obvious design — a preview service that re-derives the plan —
because two implementations of the same ordering drift, and the one you can't see is the one that
decides real dispatch.

But `runForZone` was mutating by construction. Six writes:

| # | Site | What |
|---|---|---|
| ① | `clearFinalizedOrphans` | zone-wide `deleteMany` of SUGGESTED recs |
| ② | assignable branch | SUGGESTED `recommendations` row |
| ③ | unassignable branch | UNASSIGNABLE `recommendations` row |
| ④ | after the loop | `dispatchDecisionTrace.createMany` |
| ⑤ | kit-drop path | `inventory.recordComponentBlock` |
| ⑥ | assignable branch | `inventory.resolveComponentBlock` |

"Just call it and roll back" was not available either, and ① is why: it is a **zone-wide** delete, so
a preview sharing a transaction with nothing would still have to be prevented from taking out a
concurrent live run's state. The preview also must take no advisory lock, no in-flight slot, and no
`dispatch_runs` row — so it cannot borrow the real run's transaction boundary at all.

Hence a flag on the real function rather than a copy of it.

## Slices (RED → GREEN)

### Slice 1 — AC-1 + AC-3: suppression and the projection

- **RED** — `recommender-dry-run.e2e-spec.ts`: a dry run against a zone with genuinely dispatchable
  work must leave every table unchanged. Failed on all three cases — the flag was ignored, a
  recommendation was written, and `summary.projection` was `undefined`.
- **GREEN** — `opts.dryRun` guards each of the six writes; the loop accumulates `PreviewDecision[]`
  on both branches instead.
- Suppression is asserted by **whole-database table counts**, not fixture-scoped queries: a write
  landing somewhere unexpected is precisely the failure being pinned, and a scoped assertion would
  not see it. (`fileParallelism: false`, so a whole-table delta is stable.)
- AC-3's projection deliberately mirrors the persisted `dispatch_decision_traces` payload rather
  than inventing preview-only vocabulary — #251 renders "why this SE" from it, and two different
  explanations of one decision is the drift Decision 1/18 exists to prevent.
- `bucketsAsOf` is taken from the `computed_at` of the device states the run actually ranked. It
  rides along on a `select` that was already happening, so it costs no extra query and describes
  exactly the inputs the ordering came from.

### Slice 2 — AC-4: today-parity

- Dry run first, then the real run, then compare the projection against the persisted
  `recommendations`. Ordering matters: because the dry run writes nothing, the real run starts from a
  byte-identical database, so this is a true same-input comparison **and** a second independent proof
  of AC-1.
- Three tickets on one plant, so the comparison covers processing order and the plant-cluster seed
  rather than one trivial decision.
- Honest characterisation: this pins behaviour that was already correct once slice 1 landed; it did
  not drive an implementation change. Its value is as the regression pin on the "projects the real
  recommender" guarantee.

### Slice 3 — AC-2: `targetDate`

- **RED** — a ticket deferred until tomorrow must be absent from today's preview and present in
  tomorrow's. Failed: the deferral predicate still read `istDate(now)`.
- **GREEN** — `targetDay` threaded through the deferral predicate (×2 — the ticket read and the
  withheld count, which must not drift apart), `installBacklog`, `committedDayLoad`, and
  `plannerForDate` (whose signature now takes a day rather than re-deriving one).
- **Sensitivity re-verified**: reverting *only* the deferral threading turns AC-2 red again, so the
  test pins the change rather than merely the existence of `targetDate`.

**The `asOf` instant.** Window-active predicates (`currentStatusMany`, `resolveActiveOverrides`) need
an instant, not a day. `asOf` is the same time-of-day as `now`, shifted onto the target IST day. For
a preview of today that is *exactly* `now` — which is what makes today-parity hold **by
construction** rather than by luck. Probing at the target day's midnight instead would silently
disagree with the real run for every availability window that opens during the working day.

### Slice 4 — AC-5 + orchestration

- **RED** — `dispatch-preview.e2e-spec.ts`: `previewActiveZones` did not exist, and
  `runForActiveZones(future)` returned **`RAN`** — it really did create future-dated day plans.
- **GREEN** — `previewActiveZones(targetDate, { zoneId?, now? })` beside `runForActiveZones`; the
  real path throws on a future IST day (15-minute clock-skew allowance).
- **A test-design correction worth recording:** the first version of the AC-5 test used the fixture's
  `TOMORROW` (2026-06-22) — which is *historical* by the time the suite runs, so the guard correctly
  declined to fire and the test failed for the wrong reason. It now uses a date genuinely future
  relative to the real wall clock, which is what the guard compares against.

## What the guard actually closes

`runForActiveZones` builds `work_schedules` dated `istDate(now)` and dispatches them to real SEs.
Nothing validated that argument. The only thing preventing real future-dated day plans was that both
live callers hardcode `new Date()` — an accident of the call sites, not a property of the function.
Now that a preview legitimately needs to ask about tomorrow, that accident stops being load-bearing.

## Honest limits, carried in the type rather than omitted

- **Buckets are as-of-recompute.** `slaBucket` / `inactivityHours` are materialised; no as-of-date
  variant exists or is being built. A D+1 preview moves the deferral/planner/capacity/availability
  reads to tomorrow but still *ranks* on today's buckets. `bucketsAsOf` exists so #251 must state
  this; a preview that hid it would look authoritative about an ordering it cannot know.
- **`modeForZone` ignores its date argument.** `soft-inactive-count.service.ts:74` names the
  parameter `_now` — the count comes from materialised `device_states`. It is threaded with `asOf`
  for intent, but the DEFICIT/PREVENTIVE switch is as-of-recompute for the same reason the buckets
  are. Documented at the call site rather than left to be discovered.
- **One concurrency divergence.** The real run absorbs a P2002 on the one-SUGGESTED-per-ticket unique
  by skipping the ticket — a concurrent still-RUNNING dispatch already owns it. A dry run never
  creates, so it never learns this and will show a ticket the live run has claimed. Closing it would
  mean reading the other run's state, which would make the preview's answer depend on when it was
  asked. Documented at the `catch`.

## Verification

- New specs: `recommender-dry-run.e2e-spec.ts` 5/5 · `dispatch-preview.e2e-spec.ts` 4/4.
- Targeted regression (the paths most exposed to the date threading): `dispatch-run`,
  `dispatch-run-zone-scoped`, `dispatch-scheduler-tick`, `dispatch-run-containment`,
  `recommender-planner-bias`, `dispatch-transparency`, `candidate-selection` — 7 files / 16 tests green.
- `tsc --noEmit` clean.

## Risks / rollback

Flag-gated: absent flags reproduce current behaviour exactly, pinned by the parity test and by the
"control" case that proves suppression is a property of the flag and not of the fixture. The one
non-flag-gated behaviour change is AC-5's refusal, which turns a silent data-corrupting footgun into
a loud error. Rollback = revert.
