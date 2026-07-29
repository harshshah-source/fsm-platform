# 179 — OH bulk unassign, Slice 2 (dispatch-run optional `zoneId`)

TDD completion report. Frozen once written — corrections go to INDEX/SYSTEM-STATE, not here.

## AC-by-AC

- **`DispatchRunOptions` gains optional `zoneId: bigint`** — `dispatch-run.service.ts`. When set,
  `runForActiveZones` narrows its zone loop to exactly that zone instead of calling
  `activeZoneIds()`. One-line change: `opts.zoneId != null ? [opts.zoneId] : await
  this.activeZoneIds()`.
- **Omitted → byte-identical** — proven directly, not just asserted: `test/dispatch-run-
  zone-scoped.e2e-spec.ts` builds one fixture (two zones, one eligible ticket each) and runs both
  branches against it. Narrowed (`{zoneId: zoneA}`): `summary.zones === 1`, zone A's ticket
  dispatched, zone B's ticket stays `UNASSIGNED` with zero schedules, exactly one
  `dispatch_run_zones` row. Omitted (no `zoneId`): both zones' tickets end up
  `FORMALLY_ASSIGNED`, `dispatch_run_zones` rows cover both zone ids — the same multi-zone sweep as
  before this option existed.
- **`POST /schedules/dispatch-run` accepts optional `zoneId`, existing suites stay green untouched**
  — `schedules.controller.ts`: `dispatchRunNow` takes `@Body() body: {zoneId?: number} = {}`,
  threads `BigInt(body.zoneId)` through when present. One test **appended** to
  `dispatch-run-controller.e2e-spec.ts` (its three existing tests are byte-for-byte unmodified,
  confirmed green) proving `{zoneId: 1}` narrows the HTTP-triggered run to `zones: 1`.

## RED → GREEN

1. RED: `test/dispatch-run-zone-scoped.e2e-spec.ts`'s narrowing test — `expected 15 to be 1`
   (zoneId silently ignored, full active-zone sweep ran). The omitted-zoneId test in the same file
   passed on the same run — it exercises the pre-existing, unchanged code path, so it is reported as
   a direct-proof test, not a fabricated RED.
   GREEN: the one-line `zoneIds` change above.
2. RED: the appended controller test — `expected 13 to be 1` (all active zones swept via HTTP with
   no zoneId wired). GREEN: the `@Body` param + `BigInt` pass-through.

## Tests / typecheck

- New: `test/dispatch-run-zone-scoped.e2e-spec.ts` (2 tests). Extended:
  `test/dispatch-run-controller.e2e-spec.ts` (+1 test, its 3 prior tests unchanged).
- Touched-neighbourhood regression: `dispatch-run`, `dispatch-run-controller`,
  `dispatch-run-zone-scoped`, `dispatch-scheduler`, `dispatch-scheduler-tick`,
  `dispatch-run-detail-build-stamp`, `dispatch-zone-wedge`, `dispatch-same-day-append`,
  `dispatch-transactional` — 9 files / 26 tests green.
- `npx tsc --noEmit -p .`: clean.

## REFACTOR

None.

## Remaining work

- **Slice 3** — filter zero-live-ticket batches out of the SE day-plan and ZM schedule reads.
  Shares `day-plan-query.service.ts` with #147/#165 — coordinate, do not absorb their scope.
- **Slice 4** — OH-only admin page (Plant Deactivations pattern): two buttons, preview modal with
  class counts, typed confirmation, `audit_logs`-backed history.
