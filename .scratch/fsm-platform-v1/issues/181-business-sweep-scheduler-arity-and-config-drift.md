# 181 — `BusinessSweepSchedulerService`: TWO defects, not one — constructor-arity drift and config-shape drift

Status: ready-for-agent
Type: AFK · Backend (test repair)

Filed 2026-07-31. **Second in the repair set, landed together with
[#182](./182-hermetic-test-env-allowlist.md).** Sequence:
**[#180](./180-test-db-determinism-truncate-reseed.md) → #181 + #182 together → [#183](./183-tier-override-frozen-clock-check-violation.md).**

> **Do not start until #180 is done.** Until the test database is deterministic, a green run here
> proves nothing and a red run may not be yours.

> **There are TWO defects in this file. Name both in your commit.** They are different tests with
> different fixes. An implementer who fixes one and stops will leave the other red and reasonably
> conclude the work is done. **A2 is missed entirely by
> `docs/audits/2026-07-31-implementation-audit.md`.**

---

## Why A and B are one mechanism (read this before touching anything)

The service's constructor takes **11 collaborators then an optional `config`**
(`src/scheduling/business-sweep-scheduler.service.ts:113-126`). All four spec call sites pass **10
collaborators then the config object**. So the config object lands on the **`systemEfficiency`
parameter**, and the real `config` parameter is `undefined`. Line `:127` then reads:

```ts
this.config = { ...readBusinessSweepSchedulerConfig(), ...config };   // config === undefined
```

— which means **the `{ enabled }` argument every spec passes is silently discarded, and `enabled`
comes from the developer's `.env` instead.**

That single fact produces both symptom sets, and explains why the flag flips the failure list:

| `BUSINESS_SWEEPS_ENABLED` | What happens | Which failures you see |
|---|---|---|
| `"false"` | Every tick hits `if (!this.config.enabled) return { ran: false, reason: 'DISABLED' }` (`:135`) and **short-circuits before touching any collaborator** | The arity bug is **masked**. The `{ enabled: true }` specs fail instead — they expect `{ ran: true }` and get `DISABLED`. |
| `"true"` (current, `.env:41`) | Ticks proceed into misaligned collaborators | The arity bug surfaces (`this.softInactive.recompute is not a function`). The `{ enabled: false }` dormancy specs fail — they expect `DISABLED` and get `{ ran: true }`. |

**Consequence the implementer must be warned about:** #182 makes the test env hermetic, which means
`BUSINESS_SWEEPS_ENABLED` becomes effectively `"false"` inside the suite. **Landing #182 alone will
make the suite look WORSE**, because every `{ enabled: true }` spec starts returning `DISABLED`. That
is not a regression you caused — it is A's failures becoming visible. Land #181 and #182 in the same
change, or land #181 first.

**And note the pleasant consequence:** fixing A1 restores `config` to its own parameter, so
`{ enabled }` is honoured again and these four spec files stop reading `process.env` at all. A1 alone
therefore *also* clears the symptoms #182 was filed for, **in these files**. #182 is still required —
see #182 §"Why A1 does not make this issue unnecessary".

---

# Resolved facts

## R1 — the current constructor signature, in order, with types

`src/scheduling/business-sweep-scheduler.service.ts:113-128`. **Arity is 12: eleven collaborators,
then one optional config.**

> `docs/audits/2026-07-31-implementation-audit.md` implies 11. **Corrected: it is 12** (11 + optional
> `config`). Counting collaborators only, it is 11 — the audit appears to have counted collaborators
> and called it arity.

| # | Line | Parameter | Type | Import |
|---|---|---|---|---|
| 1 | `:114` | `verification` | `VerificationService` | `../verification/verification.service` |
| 2 | `:115` | `intraday` | `IntradayInsertionService` | `../intraday/intraday-insertion.service` |
| 3 | `:116` | `crossZone` | `CrossZoneEscalationService` | `../cross-zone/cross-zone-escalation.service` |
| 4 | `:117` | `installLifecycle` | `InstallLifecycleService` | `../ticketing/install-lifecycle.service` |
| 5 | `:118` | `repeatEscalation` | `RepeatEscalationService` | `../ticketing/repeat-escalation.service` |
| **6** | **`:119`** | **`tierOverrideExpiry`** | **`TierOverrideExpiryService`** | **`../org/tier-override-expiry.service`** |
| 7 | `:120` | `softInactive` | `SoftInactiveCountService` | `../reports/soft-inactive-count.service` |
| 8 | `:121` | `fleetUptime` | `FleetUptimeAggregationService` | `../reports/fleet-uptime-aggregation.service` |
| 9 | `:122` | `rootCause` | `RootCauseAnalyticsAggregationService` | `../reports/root-cause-aggregation.service` |
| 10 | `:123` | `zmPerformance` | `ZmPerformanceAggregationService` | `../reports/zm-performance-aggregation.service` |
| 11 | `:124` | `systemEfficiency` | `SystemEfficiencyAggregationService` | `../reports/system-efficiency-aggregation.service` |
| 12 | `:125` | `config?` | `Partial<BusinessSweepSchedulerConfig>` | (same file, `:43-57`) |

Row 6 is the insertion. Confirmed as the **6th** parameter, exactly as reported.

**The production wiring is correct and must not be touched.**
`src/scheduling/business-sweep-scheduler.module.ts:37-61` passes all 11 collaborators in this order
and omits `config` deliberately (so runtime reads the environment). Nothing in `src/` is broken.

## R2 — what each spec argument currently binds to (the shift table)

With 10 collaborators passed, everything from position 6 shifts left by one:

| Spec arg # | Spec passes | Binds to parameter | Result when a tick fires and `enabled` is true |
|---|---|---|---|
| 1–5 | verification, intraday, crossZone, installLifecycle, repeatEscalation | correct | ✅ these four ticks work |
| 6 | `softInactive` | `tierOverrideExpiry` | `tierOverrideExpiryTick` would call `.sweepExpiredOverrides` on a stub that only has `recompute` — no test drives it, so silent |
| 7 | `fleetUptime` | `softInactive` | `softInactiveTick` → **`this.softInactive.recompute is not a function`** → caught at `:144-146` → `{ ran: false, reason: 'ERROR' }`; spy `softInactive.recompute` at **0 calls** |
| 8 | `rootCause` | `fleetUptime` | `fleetUptimeTick` calls the *rootCause* stub's `computeMonth`; spy `fleetUptime.computeMonth` at **0 calls** |
| 9 | `zmPerformance` | `rootCause` | `rootCauseTick` calls the *zmPerformance* stub |
| 10 | `systemEfficiency` | `zmPerformance` | `zmPerformanceTick` → `this.zmPerformance.computeMonth is not a function` (the systemEfficiency stub has only `computeDay`) → ERROR |
| 11 | `{ enabled }` | **`systemEfficiency`** | `systemEfficiencyTick` → **`this.systemEfficiency.computeDay is not a function`** → ERROR; spy at **0 calls**. **And `config` is `undefined`** — see the coupling section above. |

All three reported symptoms — `this.softInactive.recompute is not a function`, and zero calls on
`softInactive.recompute` / `systemEfficiency.computeDay` / `fleetUptime.computeMonth` — are explained
exactly by rows 7, 8 and 11. Confirmed, no residue.

---

# A1 — constructor arity drift

Commit `4d9ecc8` (Issue 157) inserted `tierOverrideExpiry` as the 6th constructor parameter and
updated `business-sweep-scheduler.module.ts`, but not the four spec call sites.

## Every call site that must change

Verified by `grep -rn "new BusinessSweepSchedulerService" src test` — **four sites in three files**;
nothing else in the repo constructs this service.

| File | Lines | What to insert |
|---|---|---|
| `test/business-sweep-scheduler.e2e-spec.ts` | **`:55-67`** (the `makeScheduler` helper, `:54-67`) | a `tierOverrideExpiry` stub between `sweeps.repeatEscalation` (`:60`) and `sweeps.softInactive` (`:61`) |
| `test/business-sweep-scheduler-install.e2e-spec.ts` | **`:68-73`** | `unused<TierOverrideExpiryService>()` between `unused<RepeatEscalationService>()` and `unused<SoftInactiveCountService>()` on `:70` |
| `test/business-sweep-scheduler-install.e2e-spec.ts` | **`:107-112`** | same insertion on `:109` |
| `test/business-sweep-scheduler-intraday.e2e-spec.ts` | **`:94-106`** | `unused<TierOverrideExpiryService>()` between `:99` and `:100` |
| `test/business-sweep-scheduler-intraday.e2e-spec.ts` | **`:156-161`** | same insertion on `:158` |

`test/business-sweep-scheduler-wiring.e2e-spec.ts:21` resolves the service through Nest DI
(`app.get(BusinessSweepSchedulerService)`) and does **not** construct it — no change needed.

**Notes for the two `unused<T>()` files.** The helper is `const unused = <T>() => ({}) as unknown as T`
(`business-sweep-scheduler-install.e2e-spec.ts:26`, `business-sweep-scheduler-intraday.e2e-spec.ts:30`)
— an empty object cast. It is safe here because those specs only drive one tick each and the dormant
gate stops the rest. Add the matching `import type { TierOverrideExpiryService } from
'../src/org/tier-override-expiry.service';` to both files.

**Note for `business-sweep-scheduler.e2e-spec.ts`.** `makeSweeps()` (`:39-50`) has a docstring saying
"All 10 sweep collaborators"; it is now **11**. Add:

```ts
tierOverrideExpiry: { sweepExpiredOverrides: vi.fn(async () => ({ expired: 0 })) },
```

between `repeatEscalation` (`:44`) and `softInactive` (`:45`), and fix the docstring count at `:38`.
Verify the return shape against `TierOverrideExpiryService.sweepExpiredOverrides` in
`src/org/tier-override-expiry.service.ts` — the stub's return value is never asserted, so any object
compiles, but matching the real shape keeps the file honest.

## A1's tests

Failing today in `business-sweep-scheduler.e2e-spec.ts` (with the flag on): `:183-194` (minutes/
quarter-hour sweeps — fails on `softInactive.recompute`), `:196-203` (daily system-efficiency),
`:205-215` (month-start cubes), `:217-221` (year boundary).

**Also fix the stale count in the cron-registration test.** `:225` says "registers all ten named
business-sweep cron jobs" and `:239-250` lists ten names. The service registers **eleven** — the
missing one is `'business-tier-override-expiry'` (`:177`). The test uses `jobs.has(name)` per name, so
it passes today despite being wrong; add the eleventh name and update the title. This is not a
failing test, it is a coverage hole that let A1 ship.

---

# A2 — config-object shape drift (**missed entirely by the audit**)

Different test, different fix, same file. `business-sweep-scheduler.e2e-spec.ts:71-85` asserts
`readBusinessSweepSchedulerConfig({})` `toEqual` a literal object. `toEqual` is exact on keys, so a
missing key fails.

## The exact key counts

> **Correction to the reported numbers.** The report said "the spec asserts a 10-key object; the
> service returns 11". **Counted from source: the spec asserts 11 keys (`:73-83`) and the service
> returns 12 (`:63-76`).** The delta is one key and the identification of that key was correct.

**The service returns 12 keys** — `readBusinessSweepSchedulerConfig`,
`src/scheduling/business-sweep-scheduler.service.ts:60-77`:

`enabled`, `verificationCron`, `installVerificationCron`, `intradayTimeoutCron`, `crossZoneCron`,
`repeatEscalationCron`, **`tierOverrideExpiryCron`**, `softInactiveCron`, `systemEfficiencyCron`,
`fleetUptimeCron`, `rootCauseCron`, `zmPerformanceCron`.

**The spec asserts 11** (`:73-83`) — the same list **minus `tierOverrideExpiryCron`**.

The missing key resolves to `DEFAULT_TIER_OVERRIDE_EXPIRY_CRON`, whose value is **`'0 * * * *'`**
(hourly) — `:36`. Reported value confirmed correct.

## Every `DEFAULT_*_CRON` const (`:31-41`) — the full current set

| Const | Value | Cadence |
|---|---|---|
| `DEFAULT_VERIFICATION_CRON` | `'*/5 * * * *'` | every 5 min |
| `DEFAULT_INSTALL_VERIFICATION_CRON` | `'*/5 * * * *'` | every 5 min |
| `DEFAULT_INTRADAY_TIMEOUT_CRON` | `'*/2 * * * *'` | every 2 min |
| `DEFAULT_CROSS_ZONE_CRON` | `'*/15 * * * *'` | every 15 min |
| `DEFAULT_REPEAT_ESCALATION_CRON` | `'*/15 * * * *'` | every 15 min |
| **`DEFAULT_TIER_OVERRIDE_EXPIRY_CRON`** | **`'0 * * * *'`** | **hourly — the missing one** |
| `DEFAULT_SOFT_INACTIVE_CRON` | `'0 6,18 * * *'` | 06:00 / 18:00 UTC |
| `DEFAULT_SYSTEM_EFFICIENCY_CRON` | `'30 1 * * *'` | daily 01:30 UTC |
| `DEFAULT_FLEET_UPTIME_CRON` | `'0 3 1 * *'` | 1st of month 03:00 |
| `DEFAULT_ROOT_CAUSE_CRON` | `'15 3 1 * *'` | 1st of month 03:15 |
| `DEFAULT_ZM_PERFORMANCE_CRON` | `'30 3 1 * *'` | 1st of month 03:30 |

Eleven constants; `enabled` is the twelfth config key and comes from the env, not a const.

The `BusinessSweepSchedulerConfig` interface (`:43-57`) already declares all 12 — the interface is
correct, only the spec's literal is stale.

## A2's fix

1. Add `DEFAULT_TIER_OVERRIDE_EXPIRY_CRON` to the import block at
   `business-sweep-scheduler.e2e-spec.ts:12-25` (it is **not** currently imported — the list at
   `:14-23` has ten of the eleven consts, alphabetically ordered; insert it between
   `DEFAULT_SYSTEM_EFFICIENCY_CRON` (`:21`) and `DEFAULT_VERIFICATION_CRON` (`:22`) to keep the sort).
2. Add `tierOverrideExpiryCron: DEFAULT_TIER_OVERRIDE_EXPIRY_CRON,` to the asserted literal, between
   `repeatEscalationCron` (`:78`) and `softInactiveCron` (`:79`), mirroring the service's own key
   order.

**Do not change the service to drop the key.** The key is correct — it is the Issue 157 tier-override
expiry sweep and it is wired, registered (`:177`) and documented (`:23-25`). The test is stale.

---

## Acceptance criteria

- [ ] **AC-1 (A1)** — all four `new BusinessSweepSchedulerService(...)` call sites pass **12**
      arguments: 11 collaborators in the R1 order, then the config object. Verified by
      `grep -A14 "new BusinessSweepSchedulerService" test/*.ts` showing `tierOverrideExpiry` in
      position 6 at every site.
- [ ] **AC-2 (A1)** — `business-sweep-scheduler.e2e-spec.ts` `:183-194`, `:196-203`, `:205-215` and
      `:217-221` pass, and the spies `softInactive.recompute`, `systemEfficiency.computeDay` and
      `fleetUptime.computeMonth` each record **1** call, not 0.
- [ ] **AC-3 (A1)** — `makeSweeps()` (`:39-50`) exposes a `tierOverrideExpiry` stub and its docstring
      says 11, not 10.
- [ ] **AC-4 (A1)** — the cron-registration test (`:224-257`) asserts **eleven** job names including
      `'business-tier-override-expiry'`, and its title no longer says "ten".
- [ ] **AC-5 (A2)** — `business-sweep-scheduler.e2e-spec.ts:71-85` passes with a **12**-key literal
      including `tierOverrideExpiryCron: DEFAULT_TIER_OVERRIDE_EXPIRY_CRON`, and the const is imported.
- [ ] **AC-6 — the `enabled` argument is honoured again.** A direct assertion that the fix reconnected
      the config parameter: with `BUSINESS_SWEEPS_ENABLED` set to `"true"` in the ambient environment,
      `makeScheduler(sweeps, false).verificationTick()` returns `{ ran: false, reason: 'DISABLED' }`.
      This is the regression test for the whole class — without it, the same drift can recur silently.
- [ ] **AC-7 — production wiring untouched.** `src/scheduling/business-sweep-scheduler.service.ts` and
      `src/scheduling/business-sweep-scheduler.module.ts` are byte-identical before and after
      (`git diff --stat src/` shows nothing under `src/scheduling/`).
- [ ] **AC-8 — no new red.** `business-sweep-scheduler-install.e2e-spec.ts` and
      `business-sweep-scheduler-intraday.e2e-spec.ts` pass in full, both their `{ enabled: true }` and
      `{ enabled: false }` tests, **regardless of the ambient `BUSINESS_SWEEPS_ENABLED` value** —
      check both by running the targeted command twice with the flag flipped.

## Out of scope — do not do these here

- **Any change under `src/`.** Both defects are stale tests. The service and its module are correct.
- **Removing or renaming `tierOverrideExpiryCron` / `DEFAULT_TIER_OVERRIDE_EXPIRY_CRON`**, or
  unregistering the `business-tier-override-expiry` cron. Issue 157 owns that sweep.
- **`test/setup-env.ts`** — that is #182. Even though A1 incidentally removes these four files'
  dependence on the ambient flag, do not edit the env harness here.
- **The tier-override e2e specs** (`dispatch-run-tier-override-snapshot`, `recommender-tier-override`,
  `ticket-creation-tier-override`) — that is #183. This issue only adds a *stub* named
  `tierOverrideExpiry`; it does not touch `TierOverrideExpiryService`'s own specs.
- **`test/global-setup.ts` / truncation** — that is #180 and must already be done.
- **Widening `toEqual` to `toMatchObject`** at `:72` to make the shape assertion tolerant. The
  exactness is the point: it is what caught A2. Keep `toEqual`.

## Targeted test command

From `apps/backend/`:

```bash
npx vitest run \
  test/business-sweep-scheduler.e2e-spec.ts \
  test/business-sweep-scheduler-install.e2e-spec.ts \
  test/business-sweep-scheduler-intraday.e2e-spec.ts \
  test/business-sweep-scheduler-wiring.e2e-spec.ts
```

Run it **twice — once with `BUSINESS_SWEEPS_ENABLED="true"` and once with `"false"`** in
`apps/backend/.env`. Both must be fully green. That two-run check is the only way to prove the
config parameter is reconnected (AC-6); a single run cannot distinguish "fixed" from "happens to
match the ambient flag". **Restore the file to `"true"` when you are done** — the repair programme
runs against `"true"` (see #180 out-of-scope).

## UI surfaces

None.

## Reference

n/a.

## Blocked by

- **[#180](./180-test-db-determinism-truncate-reseed.md)** — hard block. Verification is meaningless
  before the suite is deterministic.
- **Land with [#182](./182-hermetic-test-env-allowlist.md).** Not a dependency in either direction,
  but landing #182 first makes the suite look worse — see the coupling section.
