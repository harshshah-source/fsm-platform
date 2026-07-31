# 183 — Calendar time-bomb: three tier-override specs have been dead since 2026-07-24 (frozen `expiresAt` vs a live `created_at`)

Status: ready-for-agent
Type: AFK · Backend (test repair)

Filed 2026-07-31. **Last of four in the repair set.** Sequence:
**[#180](./180-test-db-determinism-truncate-reseed.md) → [#181](./181-business-sweep-scheduler-arity-and-config-drift.md) + [#182](./182-hermetic-test-env-allowlist.md) → #183 (this).**

Last because its six tests **do not currently execute at all** — `beforeAll` throws, so they can
neither mask nor be masked by anything else in the set. Fixing it changes the suite's *skipped* count
as well as its failed count, which is easier to read once #180 has made the counts stable.

> **Do not start until #180 is done.**

---

## HARD CONSTRAINT — the CHECK constraint is correct and caught a real bug. Do not touch it.

```sql
CONSTRAINT "company_tier_overrides_expiry_window_chk"
  CHECK ("expires_at" > "created_at" AND "expires_at" <= "created_at" + INTERVAL '2 months')
```

`prisma/migrations/20260723130000_company_tier_overrides/migration.sql:24-25`.

It encodes the Issue 157 business rule: a tier override is a **temporary, scoped** CSM/ZM authority
extension over the OH-owned global `company_master.company_tier`, and it must expire within two
months. It is raw SQL because it is not Prisma-expressible — the same posture as `se_coverage` and
`soft_states` (migration `:5-6`).

**Do not weaken it, drop it, relax the interval, add a migration that alters it, or bypass it with
`$executeRawUnsafe`.** It did exactly its job: it refused fixture rows that assert a past expiry
against a present creation, which is a state the product must never hold. The **tests** are what is
wrong here. If you find yourself editing anything under `prisma/migrations/`, stop — you have
misread the issue.

---

## The defect

`created_at` defaults to a **live** clock: `"created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT
CURRENT_TIMESTAMP` (migration `:19`). Three specs build their fixture with a **frozen absolute**
clock and never set `createdAt`, so Postgres fills it with the real now:

| Spec | `NOW` const | `expiresAt` | Fixture insert |
|---|---|---|---|
| `test/dispatch-run-tier-override-snapshot.e2e-spec.ts` | `:13` — `new Date('2026-07-23T06:00:00Z')` | `:44` — `NOW + 24h` | `:38-47` |
| `test/recommender-tier-override.e2e-spec.ts` | `:24` — same | `:83` — `NOW + 24h` | `:77-86` |
| `test/ticket-creation-tier-override.e2e-spec.ts` | `:19` — same | `:55` — `NOW + 24h` | `:49-58` |

`expires_at` is therefore pinned at **2026-07-24T06:00:00Z** while `created_at` is *today*. From
**2026-07-24T06:00:00Z onward** the first conjunct `expires_at > created_at` is false, every insert is
rejected, `beforeAll` throws a `DriverAdapterError`, and **six tests never execute** — in
`dispatch-run-tier-override-snapshot` (Issue 157 AC-6, 1 test), `recommender-tier-override`
(AC-4, 4 tests) and `ticket-creation-tier-override` (1 test). Confirmed against the 2026-07-31 runs.

**The repo already knew the rule and applied it correctly elsewhere.**
`test/tier-override-expiry-sweep.e2e-spec.ts:38-39` says verbatim: *"expiresAt must satisfy the DB
CHECK (> createdAt) at insert time, so it is created with an expiry a few minutes after its own
creation"*, and `:55-57`: *"createdAt is pinned relative to NOW (not left to default now()) so the row
keeps satisfying the … CHECK"*. That spec passes. The three above are the ones the rule was never
applied to.

---

# Resolved facts

## R1 — per spec: which assertions DEPEND on the frozen clock, and which merely inherited it

This is the classification that decides the fix. **A naive switch to `Date.now()` on an
ordering/boundary assertion makes it flaky rather than green** — one of the three has exactly such an
assertion.

### R1.1 `dispatch-run-tier-override-snapshot.e2e-spec.ts` — **inherited only**

`NOW` reaches exactly two places: the fixture's `expiresAt` (`:44`) and `svc.runForActiveZones(NOW)`
(`:64`). The single test (`:63-76`) asserts only that the override appears in
`configSnapshot.tierOverrides` with the right `companyId` / `zoneId` / `tier` (`:69-75`).

The only clock-sensitive code it touches is `DispatchRunService.captureConfigSnapshot`, whose override
query is `where: { status: 'ACTIVE', expiresAt: { gt: now } }`
(`src/scheduling/dispatch-run.service.ts:228-232`) — a live/expired predicate against the **injected**
`now`. **Zero assertions depend on the absolute value 2026-07-23.** Only `expiresAt > now` matters.

> **Separate hazard, do not fix here:** `:64` calls `runForActiveZones(NOW)` **unnarrowed** (pan-India)
> and `:65` then reads `findFirstOrThrow({ orderBy: { runId: 'desc' } })` — the globally newest run,
> not provably its own. Both are #180's territory (R1.1 / R1.3 there). Note it in your completion
> report; do not widen scope.

### R1.2 `recommender-tier-override.e2e-spec.ts` — **ONE ORDERING ASSERTION IS LOAD-BEARING**

`NOW` (`:24`) is threaded into five fixture fields *and* the engine call:
`deviceState.latestGpsDatetime` (`:37`), `deviceState.computedAt` (`:40`), `failureCycle.openedAt`
(`:43`), `ticket.lastStateChangedAt` (`:54`), the override's `expiresAt` (`:83`), and
`rec.runForZone(zone, { now: NOW })` (`:95-96`).

| Test | Lines | Depends on the clock? |
|---|---|---|
| "provably reorders zone A's dispatch" | `:116-122` | **YES — ordering.** `expect(silverRec.processingRank!).toBeLessThan(goldRec.processingRank!)` |
| "stamps scoreBreakdown … overrideId" | `:124-132` | No — needs only `expiresAt > now` |
| "leaves the OTHER zone untouched" | `:134-139` | No |
| "never writes to global company_tier" | `:141-144` | No — clock-independent |

**Why `:121` is load-bearing.** The test's own comment at `:88-89` states the design: Gold's ticket is
created **first**, so absent the override, canonical order would put it ahead of Silver's — the
reorder must be attributable to the tier and nothing else. That holds only because **both tickets
carry the identical `lastStateChangedAt: NOW`** and the engine runs at that same `now`, so SLA
urgency / age is exactly equal for both and tier is the sole discriminator.

Replace `NOW` with a per-fixture `new Date()` and the two tickets get `lastStateChangedAt` values
milliseconds apart. Any age- or urgency-derived term then becomes a live input to the comparison at
`:121`, and the test becomes **flaky rather than green** — passing most of the time and failing
whenever the fixture writes straddle a boundary. **This is the exact trap to avoid.**

The requirement is *one clock value computed once and reused everywhere*. Whether that value is
absolute or relative is irrelevant. **So do not change the clock in this spec at all.**

### R1.3 `ticket-creation-tier-override.e2e-spec.ts` — **inherited only, but one relationship is load-bearing**

`NOW` (`:19`) reaches `latestGpsDatetime: NOW − 30h` (`:38`), `inactivityHours: 30` (`:40`),
`computedAt: NOW` (`:46`), the override's `expiresAt` (`:55`), and
`service.createForInactiveEligible(NOW)` (`:75`).

The **−30 h / `inactivityHours: 30` pairing must stay coherent** — the device is a ticket candidate
because it has been inactive for 30 hours as of the injected `now`. That is a *relative* requirement;
the absolute date is inherited. The three assertions (`:76`, `:79`, `:82`) are all
clock-independent given a live override.

> **Separate hazard, already owned by #180 R7:** `:76` asserts `expect(result.created).toBe(1)`, but
> `TicketCreationService.createForInactiveEligible` is a **fleet-wide** sweep with no device predicate
> (`src/ticketing/ticket-creation.service.ts:34-52`), so `created` counts *every* inactive-eligible
> device in the DB. `:10` also pins `const DEVICE = String(9_401_000n)` — a fixed, un-namespaced
> device id. **#180 owns both.** Land #180 first; if `:76` is still red after your fix, that is #180's
> failure, not yours.

## R2 — the fix: pin `createdAt`. **Do not introduce a live clock.**

**Decision: set `createdAt` explicitly, relative to each spec's existing `NOW`, and change nothing
else.** This is the smallest possible change, it has a passing in-repo precedent, and — critically —
it does not touch the ordering assertion at `recommender-tier-override.e2e-spec.ts:121`.

For each of the three fixture inserts, add one field:

```ts
createdAt: new Date(NOW.getTime() - 60 * 60 * 1000),   // 1h before NOW: < expiresAt, well inside the 2-month window
```

- `dispatch-run-tier-override-snapshot.e2e-spec.ts` — inside the `data` at `:39-46`
- `recommender-tier-override.e2e-spec.ts` — inside the `data` at `:78-85`
- `ticket-creation-tier-override.e2e-spec.ts` — inside the `data` at `:50-57`

Both CHECK conjuncts then hold permanently and independently of the wall clock:
`expiresAt (NOW+24h) > createdAt (NOW−1h)` ✅ and
`expiresAt ≤ createdAt + 2 months` (25 h ≤ ~61 days) ✅.

**Precedent, verbatim in-repo:** `test/tier-override-expiry-sweep.e2e-spec.ts:49` and `:66` do exactly
this, with the reasoning in the comments at `:37-40` and `:55-57`. Copy that pattern and cite it in
the comment you add, so the next reader finds the rule rather than rediscovering it.

Two other tier-override specs already avoid the trap by a different route and need **no change**:
`test/org-tier-overrides.e2e-spec.ts` and `test/org-tier-overrides-winning-mark.e2e-spec.ts` both use
a local `futureIso(daysFromNow)` helper over `Date.now()` (`org-tier-overrides.e2e-spec.ts:61-63`;
`org-tier-overrides-winning-mark.e2e-spec.ts:58`), and the winning-mark spec pins `createdAt`
explicitly where it needs a past creation (`:102-103`, `:113-114`, `:144-145`).

## R3 — recommended relative-clock helper

The `futureIso` helper is duplicated in two files today and neither enforces the 2-month bound.
Consolidate into one fixture helper that makes the **pair** the unit — the defect was never a wrong
`expiresAt`, it was an `expiresAt` chosen without reference to its `createdAt`.

Put it in `apps/backend/test/fixtures/` (the directory already exists):

```ts
// test/fixtures/tier-override-window.ts
/**
 * A (createdAt, expiresAt) pair that satisfies company_tier_overrides_expiry_window_chk
 * (migration 20260723130000:24-25) by construction, anchored to a caller-supplied clock.
 *
 * ALWAYS pass createdAt explicitly when inserting a company_tier_overrides row. The column
 * defaults to CURRENT_TIMESTAMP, so a fixture that sets only expiresAt from a frozen date is
 * valid on the day it is written and rejected forever after (#183).
 */
export function tierOverrideWindow(
  now: Date,
  opts: { createdBeforeMs?: number; expiresAfterMs?: number } = {},
): { createdAt: Date; expiresAt: Date };
```

Defaults: `createdBeforeMs = 60 * 60_000` (1 h), `expiresAfterMs = 24 * 60 * 60_000` (24 h). It must
**throw** if the computed pair would violate either conjunct — a fixture helper that can emit an
invalid window is the same defect one layer up.

Adopting it in the three specs is optional and can follow the one-line `createdAt` fix; **the AC is
the `createdAt` pin, not the helper**. If you adopt it, do so as a separate commit so a regression is
attributable.

## R4 — fake timers: **there are none, anywhere**

`grep -rln "useFakeTimers\|setSystemTime\|useRealTimers" apps/backend/test/` returns **zero files**.
No spec in the backend suite fakes time.

So the interaction the question anticipated cannot arise today — but the reason matters for the
convention in R5: **`vi.useFakeTimers()` would not help even if it were used.** It patches the
*Node* clock. `created_at DEFAULT CURRENT_TIMESTAMP` is evaluated by **Postgres**, in a different
process, on the real system clock. Faking timers in the spec would move `expiresAt` while leaving
`created_at` at the true now — reproducing this exact bug rather than fixing it.

**Record that as a rule:** any constraint or default evaluated server-side (`CURRENT_TIMESTAMP`,
`now()`, `INTERVAL` arithmetic in a CHECK) is unreachable from Node's clock. The only way to control
it from a test is to **write the column explicitly**.

## R5 — the convention, and why a lint rule is NOT cheap here

**The convention** (add it to `docs/agents/workflow.md` alongside the TDD report format):

> **Fixtures for tables with a `CURRENT_TIMESTAMP` default must set that column explicitly whenever
> another column in the same row is compared against it by a CHECK constraint.** Never derive one
> half of a constrained pair from a frozen absolute date and leave the other to the database default —
> such a row is valid on the day it is written and rejected forever afterwards. Faking timers does
> not help: the default is evaluated by Postgres, not Node.

**A lint rule is not cheap.** There is **no ESLint configuration anywhere in this repo** — no
`.eslintrc*` / `eslint.config.*` at the root, in `apps/backend/`, or in `apps/admin-web/`, and
`apps/backend/package.json` has no `lint` script (`build`, `start`, `seed`, `autoplant:*`,
`runtime-lock:reset`, `test`, `test:watch`, `typecheck`). The root's `turbo run lint` has nothing to
run. Adding a custom rule means standing up a linter first — that is its own issue, not a rider on
this one.

**Cheaper equivalent that costs nothing to run: a guard spec.** Add
`test/tier-override-fixture-guard.spec.ts` — a pure unit test (no DB) that reads the `test/` directory
and fails if any file both writes `companyTierOverride.create(` and omits `createdAt` from that call.
It runs inside the existing suite, needs no new tooling, and fails at the moment the mistake is
reintroduced rather than two months later. Keep it deliberately narrow — one table, one column — so it
cannot become a maintenance burden. If a future file has a legitimate reason to omit `createdAt`, it
opts out with a named comment the guard recognises.

---

## Acceptance criteria

- [ ] **AC-1** — the fixture insert in each of the three specs sets `createdAt` explicitly, relative
      to that spec's own `NOW` const: `dispatch-run-tier-override-snapshot.e2e-spec.ts:39-46`,
      `recommender-tier-override.e2e-spec.ts:78-85`, `ticket-creation-tier-override.e2e-spec.ts:50-57`.
- [ ] **AC-2** — all six previously-dead tests **execute and pass**: 1 in
      `dispatch-run-tier-override-snapshot`, 4 in `recommender-tier-override`, 1 in
      `ticket-creation-tier-override`. No `beforeAll` throws a `DriverAdapterError`.
- [ ] **AC-3 — the constraint is untouched.** `git diff --stat prisma/` is empty. No new migration.
      Verified positively: inserting a row with `expiresAt < createdAt` still fails, and one with
      `expiresAt = createdAt + 3 months` still fails.
- [ ] **AC-4 — no live clock was introduced.** The `NOW` const in each of the three specs is
      unchanged, and `recommender-tier-override.e2e-spec.ts:121`
      (`silverRec.processingRank < goldRec.processingRank`) still compares two tickets that share one
      identical `lastStateChangedAt`. Verified by running that file **five times consecutively** —
      all five green, no flake. This is the AC that guards against the naive fix.
- [ ] **AC-5 — time-proof, demonstrated not asserted.** Re-run the targeted command with the system
      clock advanced by three months (a container/VM with a shifted date, or `faketime` if
      available). All six tests still pass. If no clock-shifting facility is available, state that
      explicitly in the completion report rather than claiming the AC — **UNRESOLVED — implementer
      must determine** whether this environment can shift the clock; a `libfaketime` equivalent on
      Windows was not verified while filing.
- [ ] **AC-6 — the convention is written down** in `docs/agents/workflow.md`, in the R5 wording,
      including the "faking timers does not help, the default is evaluated by Postgres" sentence.
- [ ] **AC-7 — the guard exists.** `test/tier-override-fixture-guard.spec.ts` fails when a
      `companyTierOverride.create(` call omits `createdAt`, and passes on the repaired tree. Proven by
      temporarily removing one `createdAt` and observing the guard go red.

## Out of scope — do not do these here

- **Any change under `prisma/`** — schema, migrations, or the CHECK constraint. Restated because it is
  the single most likely wrong turn.
- **`expect(result.created).toBe(1)`** at `ticket-creation-tier-override.e2e-spec.ts:76`, and the
  fixed `DEVICE = String(9_401_000n)` at `:10` — both are **#180 R7**.
- **The unnarrowed `runForActiveZones(NOW)` and the global `orderBy: { runId: 'desc' }`** at
  `dispatch-run-tier-override-snapshot.e2e-spec.ts:64-65` — **#180 R1.1 / R1.3**.
- **`test/org-tier-overrides.e2e-spec.ts` and `test/org-tier-overrides-winning-mark.e2e-spec.ts`** —
  both already handle the window correctly (R2). Do not "harmonise" them.
- **`test/tier-override-expiry-sweep.e2e-spec.ts`** — it is the precedent. Read it; do not edit it.
- **Standing up ESLint** to host a lint rule — R5. Separate issue if anyone wants it.
- **Any change under `src/`.** `TierOverrideExpiryService`, `EffectiveTierResolver` and
  `DispatchRunService.captureConfigSnapshot` are all correct.
- **`vi.useFakeTimers()`** anywhere — R4 explains why it would reproduce the bug, not fix it.

## Targeted test command

From `apps/backend/`:

```bash
npx vitest run \
  test/dispatch-run-tier-override-snapshot.e2e-spec.ts \
  test/recommender-tier-override.e2e-spec.ts \
  test/ticket-creation-tier-override.e2e-spec.ts \
  test/tier-override-expiry-sweep.e2e-spec.ts \
  test/org-tier-overrides.e2e-spec.ts \
  test/org-tier-overrides-winning-mark.e2e-spec.ts
```

The last three are the **regression half** — they pass today and must still pass; they are the proof
you did not "fix" the three broken specs by loosening something shared.

Then run `test/recommender-tier-override.e2e-spec.ts` alone **five times consecutively** for AC-4.

## UI surfaces

None.

## Reference

Issue 157 (company tier overrides) — AC-4 and AC-6 are the acceptance criteria these six tests are the
evidence for. Both have been unevidenced since 2026-07-24.

## Blocked by

- **[#180](./180-test-db-determinism-truncate-reseed.md)** — hard block, and it owns two hazards
  inside these same files (R1.1, R1.3 notes above).
- Independent of #181 and #182 in mechanism; sequenced after them only so the suite's counts are
  already stable and the six newly-executing tests are legible as a delta.
