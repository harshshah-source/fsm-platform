# 358 — Verification review page completion: the fraud queue, the stall chip, and the way back

**Done 2026-09-03.** Wave 3 of the module-gaps completion plan (`docs/module-gaps/IMPLEMENTATION-PLAN.md`
§4), absorbing survey ids V-03, V-06, V-07 (UI half) and closing **#148 slice 3**. Red-first. Depends
on **#357** (`d165d55`, report `docs/progress/357-verification-integrity.md`), which landed the backend
this morning and left every one of its new surfaces unread by any client.

Admin page + client, plus one read-surface addition on the backend. This slice did **not** touch
`prisma/schema.prisma` — #337 owned it this round — and needed no schema change.

## What it closes

**1. A zone-scoped fraud queue that no reviewer could open.** #357 clamped `GET /verification/fraud-flags`
to the caller's zone and gave its rows `zoneId` / `zoneName` / `escalationReason`. Nothing in
`apps/admin` called it. The one list a ZM works fraud suspicion from existed only as an endpoint.

It is now a tab of its own, fed by that read. Deliberately **not** a filter over the review rows: the
review list is filtered by outcome and defaults to non-CLOSED, so a "fraud" filter over it would
silently drop every flagged ticket those filters exclude — a queue that looks complete and is not is
worse than no queue. The admin test proves the distinction the only way it can be proved: a fraud row
that exists **only** in the `fraud-flags` payload and is absent from the review payload must still
render.

**2. "Overdue" said about a window nobody is late for.** #148 stopped the sweep expiring a verification
window while the telemetry watermark has not advanced past the submission — correctly, because a
device the SE genuinely repaired must not fail for want of an ingestion run. The tail of that fix is a
window whose 24-hour countdown runs past zero and keeps going, and the page printed `overdue` for it.

"Overdue" tells a reviewer the **engineer** missed a deadline. The truth is that the **pipeline** did.
Those are opposite actions — chase the SE, or chase ingestion — and the page was guessing wrong in the
direction that blames the person. Stalled rows now read `stalled — telemetry as of …`, and a banner at
the top of the page names how many windows are in that state and says in words that they are not
overdue submissions.

**3. Two destructive doors, one click each.** Mark-auto-recovery overrides the platform's verdict on
whether the work happened; de-escalate reverses a manager's own escalation. #357 made a reason
mandatory on both server-side. A reason box alone still fires the override on one stray press in a
table where every row is clickable, so both now take a reason **and** a confirm.

**4. ESCALATED had no way back in the UI.** #357 built `POST /verification/:ticketId/deescalate`; no
control invoked it. It is now offered on ESCALATED rows in both queues, and — the other half of the
same rule — Escalate is *withdrawn* from a row that is already escalated, where it could only ever have
produced a 409.

## The shape of the fix

**`stalled` is the sweep's own predicate, read back.** `isStalled` in `verification-query.service.ts`
mirrors the second half of `VerificationService.windowExpired` exactly: not concluded, and telemetry has
not advanced past `startedAt` (a null watermark counting as *not advanced*, the same limiting case the
guard treats it as). So what the page says about a window is what the sweep will do to it, by
construction, rather than by two definitions kept in step by hand. A concluded run is never stalled —
the flag answers "can this still reach a verdict", and a run with an outcome is answered by its outcome;
calling it stalled would put a pipeline warning on a row nobody is waiting on.

**`telemetryAsOf` rides on the row, not in an envelope.** It is global — identical on every row of a
response — which argues for an envelope, and the argument loses: `GET /verification/review` returns a
bare array, and reshaping a live payload into `{ rows, telemetryAsOf }` breaks every existing client for
a field that is presentational. (Round 2's one regression reached the gate exactly this way.) The field
is documented as global on the type, and the page reads it off the first row that carries one.

**"Is this escalated" is `ticketStatus === 'ESCALATED'`, on both row shapes.** Not "has an escalation
reason", which is a *consequence* of escalation rather than the thing the door guards on. `deescalate`
refuses anything whose ticket status is not ESCALATED (409 `NOT_ESCALATED`), so keying the button to the
same fact makes it visible exactly when the door will accept it. `FraudFlagView` gained the same field
for the same reason, so the two queues test one predicate rather than two that agree today.

**One capture panel for all three doors.** #357 had already routed mark-auto-recovery through the
reason capture Escalate used, to keep the button honest between the two slices; the brief for this slice
was to extend that pattern, not to add a third. So the two near-identical inline panels collapsed into
one `ReasonConfirmPanel` driven by a single `PendingAction`, with per-action copy in one `ACTION` table.
Escalate gains the confirm step as a consequence — it is the same class of decision, and leaving it as
the one door in the module that fires on a single press would have been an accident, not a design.

The confirm step is a **second press on a differently-labelled button** ("Confirm mark auto-recovery",
"Confirm de-escalate"), not a disabled-until-checked box: it states what is about to happen at the
moment it happens, and it restates the reason that will be recorded. `Back` returns to the reason;
`Cancel` abandons.

## Where the issue's premise held, and where it had moved

All four findings reproduced. Two line-number corrections worth recording:

- The plan cites `verification-query.service.ts:206-209` as "the countdown computed without a telemetry
  watermark". That region is the `review()` row map, and it is right that no watermark was read — but
  the *misleading* string was never in the backend at all. `partialDeadline` is a timestamp; the word
  "overdue" was produced entirely by `hoursLeft` in `VerificationReviewPage.tsx:31-34`. The fix
  therefore needed a new field on the read (the page cannot know what the sweep will do) **and** a
  change to the client's own text, which is what the issue asks for; the framing that the backend
  "printed overdue" is wrong.
- `VerificationReviewPage.tsx:228` is cited as "mark-auto-recovery fires without confirm". By the time
  this slice ran, `:228` was the Escalate button and mark-auto-recovery already went through #357's
  reason capture — as the task brief warned. What was missing was the confirm, on both doors, which is
  what AC3 actually says.

## Acceptance criteria

- [x] **AC1** — fraud-flagged rows come from the scoped endpoint (a row present only in the
      `fraud-flags` payload renders in the tab; a non-fraud review row does not).
- [x] **AC2** — a window whose telemetry watermark has not advanced shows "stalled — telemetry as
      of …", never "overdue"; an expired window with *flowing* telemetry still reads "overdue".
- [x] **AC3** — mark-auto-recovery and de-escalate both need a reason and a confirm; nothing reaches
      the wire until Confirm is pressed, and Back sends nothing.
- [x] **AC4** — de-escalate is visible only on ESCALATED rows, in both queues, and Escalate is not
      offered on a row that is already escalated.

### #148 slice 3, absorbed

- [x] **#148 AC5** — a stalled window is observable rather than silent.

**The surface differs from #148's wording, deliberately.** #148 (written 2026-07-22) put the indicator
on `/build-health`, because at the time the stall was framed as an integration-health fact. §4 of the
completion plan re-homed it to the verification review page, and that is the right home: the person who
would otherwise read "overdue" and chase an engineer is standing on this page, and the correction has to
reach them where the wrong conclusion is drawn. `/build-health` remains a reasonable *second* home for a
platform-wide count; it is **not built here** (the page is outside this slice's file ownership) and is
listed as a follow-up below.

## What was tested, and why in that shape

**Backend** — the four new cases live in `verification-staleness.e2e-spec.ts` beside #148's own three,
because that spec already owns the staleness precondition and drives the real sweep. The stalled and
not-stalled cases therefore start from a window the sweep genuinely refused (or genuinely expired),
not from a seeded `outcome` — which is the only way to demonstrate that the read agrees with the sweep
rather than merely with itself. The concluded-run case sets a *stale* watermark **after** the verdict, so
the assertion is specifically that a finished run is not retroactively called stalled.

The ticket-status case seeds its fraud run directly and flips the ticket to ESCALATED, for the same
reason #357's spec seeds: driving a real escalation would exercise `escalateFraud`'s guards, which are
already pinned elsewhere, and the assertion here is only that both read surfaces carry the status.

**Admin** — the four ACs against a mocked client. Two fixtures carry the load:

- `t-foreign` exists **only** in the `fraud-flags` payload. A Fraud-flagged tab implemented as a filter
  over the review rows cannot render it, so AC1 cannot pass by accident.
- `t-overdue` and `t-stalled` have the **same** past deadline and differ only in `stalled`. Without the
  pair, a page that simply deleted the word "overdue" would pass AC2.

AC3 is asserted as a negative before it is asserted as a positive: after typing a reason and pressing
the action button, `expect(postsTo(...)).toHaveLength(0)`. A test that only checks the request arrives
after the confirm click would pass against a page with no confirm step at all.

## Tests, verbatim

Admin (`apps/admin`, no lock needed):

```
✓ test/verification-review.test.tsx (12 tests) 2977ms

 Test Files  1 passed (1)
      Tests  12 passed (12)
```

Backend, through the round's DB lock:

```
✓ test/verification-guarded-transitions.e2e-spec.ts (10 tests)
✓ test/verification-run.e2e-spec.ts (8 tests)
✓ test/verification-staleness.e2e-spec.ts (8 tests)
✓ test/verification-controller.e2e-spec.ts (10 tests)
✓ test/verification-review.e2e-spec.ts (4 tests)
✓ test/verification-integrity.e2e-spec.ts (17 tests)

 Test Files  6 passed (6)
      Tests  57 passed (57)
```

The red runs, for the record:

```
backend — test/verification-staleness.e2e-spec.ts
  × #358 — a window the sweep cannot expire reads STALLED, with the watermark it is stuck behind
  × #358 — the same window with an advanced watermark is NOT stalled
  × #358 — a run that already concluded is never stalled, even on a stale watermark
  × #358 — review and fraud-flag rows carry the ticket status the de-escalate door guards on
 Tests  4 failed | 4 passed (8)     ← the four #148 cases passed throughout

admin — test/verification-review.test.tsx
 Tests  10 failed | 2 passed (12)
```

Type-checks clean: `apps/backend npx tsc --noEmit`, `apps/admin npx tsc -b`.
`apps/admin/test/acting-header-builder.test.ts` (3 tests) re-run green — the new
`apiFraudFlags` / `apiDeescalate` clients authenticate through `authHeaders()` like the rest of the file.

## Follow-ups this slice does not own

- **A platform-wide stalled-window count on `/build-health`** — #148's original wording. The
  verification reviewer is served here; an ops reader watching ingestion is not, and would have to open
  the verification page to learn that the pipeline is stuck. `BuildHealthPage.tsx` is outside this
  slice's file ownership. Small: the count is already derivable from the same watermark read.
- **`apps/admin/src/api/reports.ts`'s `VerificationOutcomesReport` still does not declare
  `escalations`** — inherited unchanged from #357's follow-up list. Additive, so nothing breaks; the
  admin type gains it when a page reads it. This slice reads the *live* escalation state off the review
  and fraud rows, not off the report.
- **The mark-auto-recovery reason is still `audit_logs.metadata` only**, per #357's ruling. The page
  captures it and sends it; there is no column to display it back, so an auto-recovery cannot be
  explained in the queue the way an escalation now can.
- **The fraud tab is unpaged**, like the review list beside it. `fraudFlags` returns every flagged run
  in scope with no cap. That is fine at current volumes and is the same exposure the review list already
  carries; it is one read to fix if either list grows.
