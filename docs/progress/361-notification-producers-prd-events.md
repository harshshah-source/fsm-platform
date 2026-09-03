# 361 — Notification producers for the remaining PRD events

**Done 2026-09-04.** Wave 4 of the module-gaps completion plan
(`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4), absorbing survey ids NOTIF-06, INV-G3, INV-G4 (notice
half), INV-G7, ING-01 (notice half) and VCH-07, and closing **#53** and the adoption remainder of
**#76**. Built on #337 (the push exit) and #338 (the durable in-transaction outbox). Red-first.

## What it closes

PRD story 72 names a set of events somebody is supposed to be told about. For eight of them nobody
was. Each had written an audit row and stopped, on a reading — recorded in the code comments
themselves — that the notification channel was still an external seam. It stopped being one when
#337 landed the exit and #338 landed the durable enqueue; the producers were simply never written.

| Event | Told | Producer |
|---|---|---|
| Component request APPROVED / SHIPPED / REJECTED | the requesting **SE** | `component-request.service.ts` (`transition`) |
| Component request raised (awaiting approval) | the **WM** role | `troubleshoot-submission.service.ts` → `queueWarehouseNotice` |
| Common Kit short / component blocked | the **SE** whose van it is | `inventory.service.ts` (`recordComponentBlock`) |
| Component request waiting > 7 days | the zone's **ZM** | `component-request.service.ts` (`sweepWaitingComponentEscalations`) |
| Departure auto-close | the zone's **ZM** | `device-departure.service.ts` (`notifyAutoClose`) |
| Ingestion FAILED / overdue | the **OH** role | `prd-event-notice.service.ts` (`sweepIngestionAlerts`) |
| Voucher reviewed / paid | the **SE** | `vouchers.service.ts` + `notification-voucher-notifier.ts` |

The worst of them was the voucher decision, and not because it was the largest. The Voucher Review
page has told the reviewing manager "the SE is notified" since Issue 38, over a module that bound
`LoggingVoucherNotifier`. A ZM rejected an engineer's month of expenses believing the engineer had
been told; the engineer found out whenever they next happened to open the app. A promise in the UI
that the code does not keep is worse than silence — it is what stops anyone from chasing the gap.

## Where the premise was wrong

Three corrections, all found against the working tree:

1. **The issue's file paths are stale.** `component-request.service.ts` is in `src/component-request/`,
   not `src/inventory/`; `device-departure.service.ts` is in `src/device-departure/`, not
   `src/ingestion/autoplant/`. Both moved before this slice.
2. **`reject`'s own comment named the wrong recipient.** It read "the Zonal Manager is notified —
   Issue 03 seam". Neither half was true: nothing was notified, and the ZM is not the right audience.
   The person blocked by a refusal is the engineer standing at a vehicle they cannot fix, and the
   reason has to travel with the notice or "rejected" just moves the question. The ZM keeps the
   oversight queue and the new 7-day escalation, which are the manager-grain views of the same fact.
3. **`ingestion-alert.ts` cannot host a producer.** The issue asks for "`ingestion-alert.ts` — OH
   notice on transition into alert/overdue", but that module is deliberately pure: no Nest, no Prisma,
   no writes, and its two consumers are read paths polled from every admin page on a 60-second timer.
   It got the *decision* (`dueIngestionNotices`, `ingestionNoticeBody`, both pure and unit-testable);
   the enqueue went to a sweep. See decision 2.

## Decisions worth keeping

**1. Two of the eight events have no mutation to hang off, and that is why they were missing.**

Six producers hang off something a person did — a WM approves, an SE raises, a reconcile closes a
ticket — and enqueue at the mutation. Two cannot:

- *The 7-day waiting-component escalation.* Nothing happens on day seven. The event is the **absence**
  of an event, so only a clock can notice it.
- *Ingestion FAILED / overdue.* #348's whole finding was that a stopped pipeline produces no runs to
  hook: `streak: 0`, `downstreamGated: false`, every field reporting a healthy pipeline whose newest
  data is a day old. A producer wired into the ingestion cron would be the same mistake one layer
  down — it would go quiet exactly when the pipeline did.

So they get a tick: `business-prd-event-notices`, hourly, in a new leaf module
(`notifications/prd-event-notice.{service,module}.ts`).

**2. Its own scheduler rather than a twelfth collaborator on `BusinessSweepSchedulerService`.**

Following `VehicleReturnResumeScheduler` and `ScheduleClosureScheduler`, and for a stronger reason
than tidiness: that class is constructed positionally by a `useFactory` with seventeen arguments, and
#338 documented what a thirteenth costs — a factory that stopped one argument short of a deliverer,
invisibly, for as long as the happy path kept working. The new service reaches nothing that scheduler
owns. `ScheduleModule.forRoot()` is registered once (IngestionModule) and its explorer discovers
`@Cron` across the container, so the wiring cost is one line in `app.module.ts`.

`scheduler-wiring.e2e-spec.ts`'s exact-set assertion goes 21 → 22. That spec's own docstring calls
this out as the intended workflow: "Adding a legitimate new cron means updating EXPECTED_CRON_JOBS in
the same commit. That is the point: the list is a decision record."

**3. Hourly is safe *because* of the dedup, not despite it.**

The upper bound is set by ingestion — a pipeline that stopped at 09:05 should not wait until tomorrow
to be reported. The lower bound is set by nothing, because both sweep events dedupe to one notice per
entity per IST day. The cadence therefore controls only how *promptly* the first notice goes out,
never how many there are. Without the dedup an hourly poll would be indefensible: a snapshot-overdue
notice arriving every hour does not make an Operations Head act faster, it makes them mute the
channel — and that mute then costs every future alert too, including the ones that would have
mattered.

**4. The dedup key lives in the payload, not in `created_at`.**

`queueNoticeOnce` (`notifications/prd-event-notice.ts`) stamps the IST day into `metadata.noticeDay`
and keys on `(type, entityId, noticeDay)` via Prisma JSON path filters. `created_at` is the database
clock and is not injectable, so a dedup keyed on it could not be pinned against a frozen `now` —
which is exactly the property AC3 asks to be proven by running the sweep twice. The read and the
write are both on the caller's `tx`.

`entityId` is **required** by that helper where `NotifyInput` leaves it optional: it is half the key,
and a notice with nothing to key on has no "per entity" to be deduplicated per. The type says so
rather than letting the helper silently degrade to "one of these a day, globally".

**5. Entity grain is chosen for the action, not for the data.**

- Waiting-component and departure auto-close key on the **zone**, not the request or the ticket. A ZM
  with nine stalled requests has one job to do; nine pushes describing it is the storm the dedup
  exists to prevent. The count and the oldest age go in the body so the notice is still worth reading
  on day two.
- The ingestion notices key on a constant `ingestion/telemetry`. There is one pipeline. A varying id
  (a run id, say) would let the same outage re-notify on every new failed run — precisely what the
  dedup is for.
- The departure notice is **not** deduplicated, deliberately: it fires only when a reconcile actually
  closed something, so a second run over an unchanged read enqueues nothing because it closes nothing.
  Pinned in the spec.

**6. `FAILED` and `OVERDUE` are two notices, not one `INGESTION_ALERT`.**

Two different problems with two different first moves. FAILED means runs are happening and dying —
there is a poison chunk to go and look at, and the notice names it. OVERDUE means no run is happening
at all — the cron, the process or the VPN is down, and there is no chunk to inspect because nothing
got far enough to fail. Collapsing them would send an operator to read chunk errors that do not exist.
Both can be due at once and both are returned.

A **paused** scheduler yields neither. `deriveIngestionAlert` cannot set `overdue` while
`schedulerPaused`, and it must not: ingestion being off is a decision somebody made, and paging them
about their own decision nightly is how an alert channel dies. The surface still says "paused" rather
than "healthy" (#348 AC4) — that distinction stays where a human is looking.

**7. The voucher port was retired as a *deliverer* and kept as a *builder*.**

`VoucherNotifier` used to deliver: the spine did not exist, so `VouchersService` fired events at it
post-commit and the bound implementation logged them. Both halves are now wrong — the spine exists,
and a post-commit fire is the exact shape #338 removed from twelve other sites.

#338's recorded rule for choosing a row shape decides this cleanly. A `NOTIFY` row carrying a resolved
`NotifyInput` is right for producers that call `NotificationService` directly; an event row delivered
through a port is right for `InstallNotifier`/`RecoveryNotifier`, which resolve their own recipients
and — in `escalatedToOh`'s case — deliberately notify nobody. Vouchers do neither: there is exactly
one recipient and it is written on the voucher. So the port keeps the half that is genuinely policy —
**who is told and what the notice says** — and returns it synchronously for the producer to enqueue
inside its own transaction.

The practical payoff is that the retry sweep already knows how to redeliver a voucher notice, because
it is an ordinary `NOTIFY` row. The alternative meant threading a fourth deliverer through
`OutboxDeliverers` **and** the seventeen-argument factory — the shape #338 found a live bug in.
`LoggingVoucherNotifier` is deleted; `NotificationVoucherNotifier` is bound at `VOUCHER_NOTIFIER`, and
`notifier-adoption-wiring` fails if that ever regresses.

**8. `InventoryService`'s new dependency is `@Optional()`, and both halves of that are load-bearing.**

`EngineersModule` and `RecommenderModule` **re-provide** `InventoryService` in their own contexts
without importing `NotificationsModule`, so a required parameter takes the whole app down at boot
("Nest can't resolve dependencies of the InventoryService"). Adding the import to two modules this
slice does not own was the alternative; `@Optional()` plus a default is the smaller change and fails
softer. Nest passes `undefined` where the binding is absent, which is what triggers the default — so
the notice is still produced there, on a service built on the same client. The container's configured
singleton is injected wherever `InventoryModule` resolves the class.

The same defaulting (without `@Optional()`) is used on `ComponentRequestService`,
`DeviceDepartureService`, `VouchersService` and `TroubleshootSubmissionService`, which are
hand-constructed in production code (`autoplant-sync.ts`, `autoplant-departure-dryrun.ts`,
`recommender.service.ts`, `intraday-insertion.service.ts`, `engineers-query.service.ts`) and in a
dozen specs. It mirrors `RecommenderService`'s own `InventoryService` default. Those four keep the
hard DI requirement — a boot failure is the right signal for a module that genuinely forgot the
import.

## What was tested, and why in that shape

**Every case asserts the outbox row, not a spy.** A spy proves a method was called; `VOUCHER_NOTIFIER`
was bound to a spy-satisfying logging notifier for a year while the page's copy was false. The row is
what survives a crash, records who was told, and is what the sweep retries.

**The in-transaction property is asserted the only way that tells it apart** from a post-commit notify
that merely happens to write a row: break the **enqueue** and require the mutation to roll back with
it. Done for the component-request transition and for the voucher review.

Both used #338's shared rig (`test/fixtures/outbox-crash-injection.ts`). The first version of each
test used a plain `Proxy` on `PrismaService` and **passed the mutation straight through** — because
`$transaction` hands out a fresh client from the real one, so an outer proxy is simply not in the path
the enqueue takes. `failingNotifyEnqueue` wraps the transaction client too. Recording it here because
it is a rig that fails silently in the direction of a false green.

**The dedup is pinned on the entity's row count, not on the sweep's return tally.** Both sweeps are
database-wide and other spec files share this database, so asserting `notified === 0` on the second
run would be a claim about their fixtures as well as ours.

## Acceptance criteria

- **AC1** — met. One notice per event, to the role the PRD names: SE for approve/ship/reject,
  kit-short and both voucher decisions; WM for approval requests; ZM for waiting-component and
  departure auto-close; OH for snapshot failed/overdue. Recipients asserted exactly (`toEqual`) in
  every case, including that the SE is *not* among the WM recipients.
- **AC2** — met. Every producer enqueues via `queueNotification` / `queueNoticeOnce` inside the
  mutation's own transaction, and delivers post-commit through `drainProducerRows`. Proved by
  enqueue-failure rollback on two representative doors.
- **AC3** — met. `(type, entityId, IST day)`, pinned by a double sweep on all three sweep-driven
  events.
- **AC4** — met, by making the wording **true**: `NotificationVoucherNotifier` is bound, the notice is
  enqueued in the review transaction, and the page's docstring now names the producer that keeps the
  promise (so a future removal has to face the copy).

## Tests, verbatim

New in `notifier-adoption-wiring.e2e-spec.ts` (now 10 tests, up from 3): the `VOUCHER_NOTIFIER`
binding, the cron registration, and one producer case each for kit-short (+dedup), request-raised,
waiting-component (+dedup), departure auto-close (+no-op re-run) and ingestion FAILED (+dedup).
New in `component-request-warehouse.e2e-spec.ts` (8, up from 5): approve/ship, reject, enqueue-failure
rollback. New in `voucher-service.e2e-spec.ts` (23, up from 20): review notice, Mark-PAID notice with
the SAME_APPROVER skip notifying nobody, enqueue-failure rollback. 17 tests written for this slice.

Runs, all through `.scratch/locks/backend-test.sh`:

- named specs: `notifier-adoption-wiring` **10/10**, `scheduler-wiring` **4/4**,
  `component-request-warehouse` **8/8**, `voucher-service` **23/23**.
- regression, component-request + inventory + departure + ingestion + outbox + vouchers:
  **15 files / 99 passed**.
- regression, troubleshoot + notifications + schedulers: **10 files / 103 passed**.
- regression, recommender + dispatch + intraday (the `InventoryService` re-providers):
  **6 files / 29 passed**.

`npx tsc --noEmit` exit 0 (backend), `npx tsc -b` exit 0 (admin). `tsconfig.test.json` shows only its
~50 pre-existing errors; none in the files this slice touched.

## Follow-ups this slice does not own

- **SLA-warning at bucket crossing.** Named in the issue and in plan §4, but deliberately not built:
  it belongs at the `device-state` / ticket SLA bucket recompute, which is not in this slice's file
  set and was not in the executing brief's event list. It is the one PRD event from the original list
  still without a producer — **it needs an issue filed**, since #361 was the last of thirty-one and
  nothing follows to pick it up.
- **TKT-09 — customer confirmation (SMS/WhatsApp to a non-user).** Excluded per plan §7; the default
  assumed is *external seam, stays on #76* (HITL accounts). Not built here.
- **#349** owns the departure auto-close *surfacing*; this slice built only the notice.
- The mobile and admin notification clients switch on `type`. Eleven new type strings are now on the
  wire (`PRD_NOTICE_TYPES`); anything that renders an unknown type through a `default` branch will
  show them generically until a client slice teaches it the copy and the tap target.
