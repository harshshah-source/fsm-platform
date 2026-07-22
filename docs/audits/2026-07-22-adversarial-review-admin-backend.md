# ADVERSARIAL REVIEW v3 — Admin Web + Backend

**Date:** 2026-07-22 · **Branch:** `feat/autoplant-integration` · **HEAD:** `592ca96` (+ 41 dirty paths)
**Scope:** `apps/admin` (web application) + `apps/backend`. Mobile excluded by the review scope line.
**Type:** READ-ONLY audit. No code changed, no issues filed. One temporary analysis script was written
to the session scratchpad (outside the repo).
**Protocol:** `docs/audits/adversarial-review-prompt-v3.md`.

A prior review of this project exists — `docs/audits/2026-07-22-full-project-audit.md`, dated the same
day. **Phase 5 re-review rules therefore apply**: the surface is frozen to that review's scope plus its
findings, reviewer memory comes first, and blocking is damped (only `fail` blocks).

---

## 0. What this cycle adds

The prior audit closed with an explicit limitation:

> *"**LOW / Unable to verify** — … whether the full test suite passes today (I ran `tsc --noEmit` clean
> but did not run the suites …)."*

**This cycle ran them. Both suites are red.**

| Suite | Result |
|---|---|
| `apps/admin` | 2 failed / 318 tests · 91s |
| `apps/backend` | 1 failed / 1176 tests · 544s — **red since 2026-07-18, 43 commits ago** |

That single act produced three of this cycle's four new findings. Everything else in this document is
either a re-verification of a prior finding or a correction to one.

The backend failure is the most consequential thing in this review: it was introduced by a commit that
INDEX marks **✅ DONE … (8/8 e2e)**, in a session that ran a deliberate four-suite regression sweep and
recorded it. Diligence was present; full-suite execution was not. See §3.5 and §7.

---

## 1. Phase 1 — Goal, grounding, settled decisions

**Objective (re-derived from `CLAUDE.md`, not from the plan):** an Admin Web Dashboard (React + TS +
Vite) and a NestJS modular-monolith backend over the nine-stage dispatch funnel, built such that
backend and UI are **one vertical slice** — an issue carrying UI acceptance criteria is *not done*
until those criteria are met **or** an explicit follow-up issue owns them (the "surfacing rule").

**Grounding classification used throughout:**

- **Grounded** — traceable to `CLAUDE.md`, an issue's acceptance criteria, or the INDEX backlog.
- **Inferred** — raised as a question, never as a blocking finding.
- **Security baseline** — grounded by default (auth, validation, secrets, PII, injection).

**Settled decisions — deliberately NOT re-flagged** (Phase 1 §3b):

| Settled | Where recorded |
|---|---|
| Per-zone engine configuration — decided against | INDEX "Deferred / decided-against", proposal `f0f3dcb` |
| AutoPlant MySQL creds unset in dev/test/CI | `apps/backend/vitest.config.ts` setup comment + `test/setup-env.ts` |
| #52 superseded by #55/#60, retained for history | INDEX |
| Open hardening track: #91 auth · #107 CI · #110 rate limiting · #111 deploy/DR · #54 mobile | INDEX, prior audit §1.3 |
| In-process `@nestjs/schedule` cron ⇒ single-instance by construction | prior audit §3.3 |

**Security baseline — PASS (grounded, verified).**

- Global guard chain registered deny-by-default: `AuthGuard`, `RoleGuard`, `ZoneScopeGuard` via
  `APP_GUARD` (`apps/backend/src/app.module.ts:178-180`), plus `APP_PIPE` ValidationPipe (`:184`).
  Opt-out is explicit via `@Public()` (`common/decorators/public.decorator.ts:12`, honoured at
  `common/guards/auth.guard.ts:33`).
- **A first-pass finding was withdrawn here.** A sweep for controllers lacking `@UseGuards(AuthGuard)`
  returned `exports.controller.ts` and `plant-deactivation.controller.ts`. Both are in fact protected
  by the global chain; neither declares `@Public()`. Reporting them would have been a false positive.
- No secrets tracked: `git ls-files` matches only `apps/{admin,backend}/.env.example`; `.gitignore:16-18`
  covers `.env` / `.env.*` at any depth.
- Rate limiting absent — **already owned by #110**, not re-raised.

---

## 2. Phase 5 — Reviewer memory: prior findings re-verified

Every prior finding was re-checked against the code on disk. **All six remain open.**

| Prior finding | Status | Evidence on disk today |
|---|---|---|
| **B1** `DEFER_TICKET` is write-only | **still-open** | `deferredToDate` has exactly 3 non-generated hits, all writes/types: `override.service.ts:21` (command type), `:175` (audit payload), `:182` (the write). Zero readers. |
| **B1 c3** deferred ticket still burns capacity | **still-open** | `committedDayLoad` at `recommender.service.ts:548`, filters `removedAt: null` at `:551`, no defer predicate. |
| **B2** `REMOVE_TICKET` has no exclusion memory | **still-open** | Removal writes `removedAt`/`removedBy` + flips ticket `UNASSIGNED` (`override.service.ts:144-149`); the idempotency guard excludes only live rows (`batch-assignment.service.ts:90`, `removedAt: null`), so the ticket is fully re-eligible for the same SE. |
| **B3** schedules never closed + day-plan has no date filter | **still-open** | `day-plan-query.service.ts:40-43` — `findFirst({ where: { seId, status: 'ACTIVE' }, orderBy: { dispatchedAt: 'desc' } })`, no `dateFrom`/`dateTo`. |
| **B4** sweeps expire on wall-clock, not telemetry freshness | **still-open** | `verification.service.ts:182` — `expired = now - startedAt >= TWENTY_FOUR_HOURS_MS`. No `dataAsOf`/`data_as_of` reader exists anywhere under `verification/` or `install-lifecycle`; the 7 readers are all in `exports/` and `ingestion/`. |
| **B5** ZM-scorecard seq-scans `audit_logs` | **still-open** | Query `WHERE actor_role = 'ZONAL_MANAGER' AND created_at …` (`reports/zm-performance-aggregation.service.ts:69`) vs the only composite index `@@index([actedAsRole, actingZone, createdAt])` on `model AuditLog`. Different leading column. |
| **§3.1** governance: live code uncommitted, no CI | **still-open, worse** | See §3 below. |

### 2.1 Two corrections to the prior audit

Stated plainly because a reviewer inheriting that document would otherwise act on stale facts.

1. **Unpushed commits: resolved.** The prior audit reported
   `git rev-list --left-right --count origin/...HEAD` → `0 4`. It is now **`0 0`** — the four commits
   were pushed. The recommendation was *partially* actioned.
   **But the actual risk is untouched:** the dispatch-correctness layer was never *committed*, so
   pushing changed nothing about it (§3).

2. **X1 ("SYSTEM-STATE is stale on master switches") is narrower than reported.** Checked line by line:
   - `SYSTEM-STATE:449` — *"All three master switches **default** OFF"* → **accurate.** It is a claim
     about code defaults (`business-sweep-scheduler.service.ts:27-36`), which are OFF.
   - `SYSTEM-STATE:751` — *"`BUSINESS_SWEEPS_ENABLED` unset"* → **accurate.** It sits inside a dated
     `>` blockquote recording an earlier session; historical records are correctly frozen.
   - `SYSTEM-STATE:67` — *"two **deliberately-OFF** ops switches … **Nothing runs unattended today.**"*
     → **false.** `apps/backend/.env` carries `BUSINESS_SWEEPS_ENABLED="true"`.

   **The defect is one sentence, not a stale document.** Verdict downgraded to `advisory`.

---

## 3. Gate 1 — PROOF OF LIFE: `fail`

### 3.1 Commands run

| Command | Location | Result |
|---|---|---|
| `npx tsc --noEmit` | `apps/backend` | **clean, exit 0** |
| `npx tsc --noEmit` | `apps/admin` | **clean, exit 0** |
| `npx vitest run` | `apps/admin` | **RED — 2 failed / 318 tests · 2 failed / 81 files · 91s** |
| `npx vitest run` | `apps/backend` | **RED — 1 failed / 1176 tests (1170 passed, 5 skipped) · 1 failed / 289 files · 544s** |

**Both suites are red.** The prior audit's "Test posture: Medium — 1,000+ backend and ~290 admin tests
with genuine TDD discipline" was measuring *volume*, not *status*. Volume is real and the discipline is
visible in the code; the status was simply never checked.

### 3.2 A trap worth naming

The admin suite was first run as `npx vitest run … | tail -60`, and the harness reported
**"exit code 0"** — that is `tail`'s exit code through the pipe, **not vitest's**. The suite was red
the whole time.

**This is exactly how a CI job gets written and reports green on a red suite.** When #107 lands, the
test step must not pipe vitest into anything that swallows its status.

### 3.3 N1a — `fail` — a committed regression has been red for three commits

Commit `ad03769` ("feat(dashboard): Total Devices KPI") **removed the Critical Devices KPI** from the
Pan-India dashboard and did not update the Issue-122 consistency test that guards it:

```
$ git show ad03769 -- apps/admin/src/pages/dashboard/OpsHeadDashboard.tsx
-      { label: 'Critical Devices', value: roll(criticalDevices),
-        hint: 'pan-India, CRITICAL band', tone: 'critical', testId: 'kpi-critical' },
+        testId: 'kpi-total-devices',
```

**Failure:**
```
FAIL test/kpi-critical-plus-consistency.test.tsx
  > Pan-India Critical KPI counts strictly the CRITICAL band (not tickets, not worse bands)
  TestingLibraryElementError: Unable to find an element by: [data-testid="kpi-critical"]
```

**Trace:**
- The test renders `DashboardHome` as `OPERATIONS_HEAD` (`kpi-critical-plus-consistency.test.tsx:15,63-71`).
- `ManagerDashboard` routes Operations Head → `OpsHeadDashboard` (module docblock).
- `OpsHeadDashboard.tsx` is **clean / committed** (`git status` returns nothing for it) and its testIds
  are `kpi-companies`, `kpi-plants`, `kpi-uptime`, `kpi-devices`, `kpi-total-devices` — **no
  `kpi-critical`**.
- `kpi-critical` now exists only in `ZmDashboard.tsx:85` (the ZM variant), which this test does not render.
- The test file itself is **unmodified**.

**Why it matters beyond a red test.** Issue 122's decision was that the Critical KPI must equal the
Zone Performance Scorecard's Critical column — both counting strictly the CRITICAL band of inactive
devices. The other three tests in that file still pass, so the *scorecard* half of the invariant is
intact; the *KPI* half was dropped from the Operations Head view without the decision being recorded.

**Not caused by the uncommitted tree.** Verified: the only uncommitted dashboard changes are a label
change (`ZmDashboard.tsx`, `Devices` → `Active Fleet`), a layout/`centerBelow` prop on
`DashboardHero.tsx`, and small edits to `ActivityTrendSection`/`ZoneOverviewTable`. None touch
`kpi-critical`.

### 3.4 N1b — `needs-changes` — uncommitted rework changed an interaction contract

```
FAIL test/se-management-directory.test.tsx
  > removes a mapped plant via its coverage id from the edit panel
  TestingLibraryElementError: Unable to find role="button" and name `/remove pune depot/i`
```

The `EditableCell` rework changed how a row is selected:

| | Row selection |
|---|---|
| **HEAD** | SE name rendered as a button: `onClick={() => setSelectedId(r.seId)}` (`git show HEAD:…SeManagementDirectoryPage.tsx:200`) |
| **Working tree** | Name is now an `EditableCell` (`:197`); selection moved to a **"Manage coverage →"** button (`:296-302`) |

The test still clicks the name (`:141`) to open the edit panel, so the panel never opens and the
`Remove Pune Depot` button (present and correct at `:451-455`) is never rendered.

**Reproduction loop** (satisfies the protocol's reproduce-before-diagnosing rule): `npx vitest run` in
`apps/admin` — red-capable, deterministic across two full runs, 91s, no human help needed.

### 3.5 N4 — `needs-changes` — the backend suite has been red for 43 commits / 4 days

```
FAIL test/integration-reconciliation.e2e-spec.ts
  > AutoPlantMasterSource counts: one single-row COUNT each, reusing the sync filters
  AssertionError: expected 'SELECT COUNT(*) AS c FROM `ap_masters…' to contain 'deployment_status IN (?)'
  Expected: "deployment_status IN (?)"
  Received: "SELECT COUNT(*) AS c FROM `ap_masters`.`mst_vehicle` WHERE deployment_status IN (?, ?)"
```

**Root cause — a deliberate behaviour change whose guarding test was not updated.**

- The reconciliation test was written by `d208aa2` (Issue 97 Slice 5) against a **single** operational
  status, asserting `IN (?)` and `params == ['DEPLOYED']` (`integration-reconciliation.e2e-spec.ts:153-154`).
- Commit **`b9242da`** (2026-07-18, #128 Slice 1) widened the constant to two values:
  `OPERATIONAL_DEPLOYMENT_STATUSES = ['DEPLOYED', 'ACTIVE']` (`master-mapping.ts:144`), consumed by
  `countVehicleMasters` via `this.inClause('deployment_status', this.operationalStatuses)`
  (`autoplant-master-source.ts:187,99`). The SQL therefore emits two placeholders.
- `git log -S"'DEPLOYED', 'ACTIVE'"` returns exactly `b9242da`. Both the source file and the test file
  are **clean/committed** — this is not working-tree noise.
- `git rev-list --count b9242da..HEAD` → **43 commits**.

**The code is right; the test is stale.** The widening was an explicit, recorded decision — INDEX:36,
#128: *"insert scope pinned to **DEPLOYED/ACTIVE** (read ≠ create)"*. So unlike N1a, no product
decision is in question here. **The fix is to update the test's expectation to `IN (?, ?)` /
`['DEPLOYED', 'ACTIVE']`, not to touch the filter.** Verdict is `needs-changes`, not `fail`.

**Why it went unnoticed is the important part.** The #128 session log (INDEX:113) records exactly what
was run:

> *"**8/8 green** (`device-departure-lifecycle.e2e-spec.ts`), tsc clean, **regression sweep green**
> (device-state 23/23 · plant-deactivation+ticketing 18/18 · recommender 10/10 · dispatch 12/12)."*

That is a careful, deliberate, **author-selected** regression sweep — four suites the author judged
adjacent. `integration-reconciliation.e2e-spec.ts` was not among them, because nothing connects
"device departure lifecycle" to "integration health reconciliation counts" in the author's mental
model. **A hand-picked regression sweep can only cover the blast radius the author already imagined.**
This is the single clearest argument in this document for #107.

**Consequence for the record:** the prior audit lists #128 among subsystems that are *"code-complete,
tested"* (§1.1), and INDEX:36 marks it **✅ DONE 2026-07-18 … (8/8 e2e)**. Both statements are true
about #128's own tests and false about the suite as a whole. #128 landed the platform's test suite red.

### 3.6 Stub hunt & test honesty

- Backend `src/`: one TODO (`recommender.service.ts:371`), consistent with the prior audit. No new stubs.
- The two permanently-inert recommender hard filters (`VEHICLE_ON_TRIP`, `COMPONENT_UNAVAILABLE`) are
  owned by #65 / #51 — not re-raised.

**Mocked-seam rule — N3, `advisory`.** 61 of 81 admin test files stub `fetch` wholesale
(`vi.stubGlobal('fetch', …)`); the remaining 20 are pure unit/component/copy tests that never touch
the network (`ui-primitives`, `sla-bucket-range`, `plant-names`, `export-file`, …).

> **The admin→backend HTTP seam has zero unmocked automated coverage in `pnpm test`.**

The `apps/admin/visual/` Playwright harness *is* a real browser against the real app — but it is
screenshot-comparison only, requires a hand-started dev server (`node visual/capture.mjs` →
`ERR_CONNECTION_REFUSED at http://localhost:5173/login`), and is not part of the test pipeline.

Seams that **do** pass: backend→Postgres is exercised unmocked, via a properly isolated test database
(`test/global-setup.ts` applies committed migrations + idempotent seed to a `_test` sibling DB, so the
suite never runs against the developer's live AutoPlant-synced data).

*Correction against my own first pass:* I briefly flagged the `visual:*` npm scripts as pointing at
non-existent files. Wrong — `apps/admin/visual/` exists (`capture.mjs`, `compare.mjs`, `manifest.mjs`,
`baseline/`, `current/`); my `ls` had run from the wrong working directory. No finding.

---

## 4. Gate 2 — REACHABILITY: `needs-changes`

### 4.1 Method, and its limits — stated honestly

I built a route-inventory script (parse `@Controller` + `@Get/@Post/@Patch/@Put/@Delete` across 52
controller files → **197 routes**; extract path literals from `apps/admin/src`; diff).

**I do not present its output as authoritative.** It produced false positives in two successive
versions:

1. v1 assumed admin paths carry an `/api/` prefix. They do not — the admin passes bare paths to a
   `BASE_URL`-prefixing helper (`api/dashboard.ts:4-13`). This wrongly reported 174/197 unreached.
2. v2 required literals to *start* with `/`. But the admin writes
   `` `${BASE_URL}/verification/${id}/escalate` `` — the path does not start at the literal's first
   character. Fixed by substituting `${…}` → `*` inside every literal before extracting.
3. Even after fixing, it wrongly flagged `GET /component-blocked/van-stock` (reached as `vanStock` in
   `api/engineers.ts`) and `GET /dispatch-runs/:runId/tickets/:ticketId/trace` (reached at
   `api/dispatch-runs.ts:237`, rendered by `pages/dispatch/DecisionTrace.tsx`).

**Everything below is hand-verified** with both kebab-case and camelCase searches across all of
`apps/admin/src`.

### 4.2 Justified-unreached (no finding)

| Surface | Justification |
|---|---|
| 5 × `POST /reports/*/recompute` | Cron-driven — `business-sweep-scheduler.service.ts` injects all four aggregation services (`:112-115`) and runs them on a staggered monthly schedule (`:25`). The POSTs are manual ops escape hatches; a UI button is not required. |
| SE-mobile endpoints (`/tickets/:id/troubleshoot`, `/install/*/on-site`, `/recovery/*/collected`, `/me/activity-ping`, `/me/shared-pool`, …) | Owned by the #54 mobile gap — a settled, tracked scope gap. |
| `POST /auth/login`, `/auth/refresh`, `GET /health*` | Reached via `api/client.ts` / `api/http.ts`, or are infra probes. |

### 4.3 Tracked, not a new finding (§17c redundancy check)

**11 zone-mapping / plant-zone-override endpoints have zero admin references** — verified absent as
`zone-mappings`, `zoneMapping`, `ZoneMapping`, `plant-zone-overrides`, `plantZoneOverride`,
`PlantZoneOverride`:

```
GET  /org/zone-mappings            GET  /org/zone-mappings/pending
POST /org/zone-mappings/:id/map    POST /org/zone-mappings/:id/ignore
POST /org/zone-mappings/reapply    GET  /org/plant-zone-overrides
PUT  /org/plant-zone-overrides     DELETE /org/plant-zone-overrides/:sourcePlantId
```

**This is already filed as #120** (INDEX:245, `needs-triage`, filed 2026-07-13, worded almost exactly
this way: *"backend API complete and audited, `apps/admin` has zero references"*). Per the protocol's
redundancy rule it is **not** re-raised as a discovery. Noted only because it is the largest unreached
cluster on the admin surface and the operator workflow behind it (mapping UNZONED plants, which INDEX:83
records as having moved 16,535 → 4,603 UNZONED devices) is **script-only today**.

### 4.4 N2 — `needs-changes` — parity-gate violation: the audit-trail viewer

**Grounded**, and it fails the repo's own surfacing rule.

Issue 03 (`.scratch/fsm-platform-v1/issues/03-notifications-audit-spine.md`):

- `:8` — *"The cross-cutting notification delivery system and **the user-facing audit trail viewer**
  … **A reusable audit-trail viewer** that renders the full chain for any Ticket (Recommendation →
  BatchApproved → SEAccepted → OnSite → Closed, intra-day retry chains, `closure_type` + reason)."*
- `:18` — **`- [x]`** *"Audit-trail viewer renders the full transition chain for any Ticket with actor,
  role, timestamp"* — **marked done**.
- `:27` — *"Accepted — internal spine + audit viewer built."*

**What actually exists:** the API only — `GET /audit-trail/tickets/:ticketId`
(`audit/audit-trail.controller.ts`). `apps/admin/src` has **zero** references to `audit-trail`,
`auditTrail`, or `AuditTrail`.

**And the last navigational affordance was deliberately removed.** INDEX:92 records:

> *"Footer columns converted from dead text to router `Link`s (16 links …; dead labels Stock/Role
> Access/**Audit Trail** → Component Blocked/Manage SEs/**Exports**)."*

So the footer entry that would have led there was repointed away, correctly (it led nowhere), but
nothing replaced it.

**Why this blocks under CLAUDE.md** — the parity gate states an issue may not be marked done while
leaving in-scope UI ACs unbuilt unless **(a)** a follow-up issue is filed and linked in INDEX, **and**
**(b)** the deferral reason is an external-integration blocker. Here **(a) is absent** — unlike the
zone-mapping UI, which correctly has #120 — and **(b) does not apply**: rendering a ticket's audit
chain consumes an endpoint already implemented in this repo. The explicitly-deferred part of issue 03
was the *external* FCM/APNs/WhatsApp adapters (→ #76), which is legitimate; the viewer is not part of
that deferral.

---

## 5. Gates 3 & 4 — UAT, coherence, proportionate depth

Per §17d, deep tracing is reserved for large changes and core flows; the admin-side deltas this cycle
are small, so Gates 1–3 verification is the appropriate depth.

**`EditableCell.tsx` (newest uncommitted code, and the proximate cause of N1b) — audited, no finding.**
It is genuinely well-built:

- Pessimistic, not optimistic: the displayed value changes only after a confirmed successful save
  (`:66-92`) — the docblock at `:29-33` states this and the code honours it.
- Save failures surface inline with `role="alert"` and `aria-invalid` (`:135`, `:142-146`) rather than
  reverting silently. **No swallowed errors** in any of the three cells (`EditableCell`,
  `EditableSelectCell`, `ToggleCell`).
- Client-side `validate` hook runs before the network (`:77-81`), `Escape` cancels, `Enter`/blur commits.

**Dead ends / one-way states:** none found in the reviewed surface. The one structural dead end on the
platform — B3, an SE served yesterday's day plan with no indication it is stale — is a prior finding,
re-confirmed above, and is mobile-facing (dormant while #54 is unbuilt).

---

## 6. Findings

### 6.1 SPEC findings (requirement missing / implemented wrong)

| Verdict | Finding | Evidence | Fix |
|---|---|---|---|
| `fail` | **N1a** Critical Devices KPI removed from the Pan-India dashboard; Issue-122 consistency test left in place and red for 3 commits | `git show ad03769 -- …/OpsHeadDashboard.tsx`; file is clean/committed with no `kpi-critical`; test `kpi-critical-plus-consistency.test.tsx:75` | Decide whether the removal was intended. If not, restore the KPI; if yes, delete/rewrite the test **and** record the reversal of the Issue-122 decision |
| `fail` | **R1** The dispatch-correctness layer driving the live cron exists only as uncommitted files; still no CI | `git status` → 41 dirty paths incl. `batch-assignment.service.ts`, `dispatch-run.service.ts`, `recommender.service.ts`, `schema.prisma`, untracked migration `20260721120000_batch_run_attribution/`; `ls .github` → absent | Commit by explicit path (do not sweep the concurrent admin session), then #107 |
| `needs-changes` | **N2** Issue 03 AC#18 "audit-trail viewer" marked `[x]` with API only, zero admin references, no follow-up issue, nav label repointed away | issue 03 `:8,:18,:27`; zero refs in `apps/admin/src`; INDEX:92 | Uncheck AC#18 and file a linked follow-up in INDEX, **or** build the viewer |
| `needs-changes` | **N4** Backend suite red for 43 commits — stale reconciliation test after the documented #128 filter widening | `master-mapping.ts:144` (`b9242da`, 2026-07-18) vs test `integration-reconciliation.e2e-spec.ts:153-154`; both files clean | Update the test to `IN (?, ?)` / `['DEPLOYED','ACTIVE']`. **Do not change the filter** — INDEX:36 records the widening as intended |
| `needs-changes` | **N1b** SE-directory row-selection contract changed by the uncommitted `EditableCell` rework; test not updated | `SeManagementDirectoryPage.tsx:197,296-302` vs `HEAD:…:200`; test `:141` | Update the test to click **"Manage coverage →"** |
| `advisory` | **X1** `SYSTEM-STATE:67` "Nothing runs unattended today" is false | `.env` → `BUSINESS_SWEEPS_ENABLED="true"` | Edit that one sentence **in place** (§ Progress convention) |

### 6.2 STANDARDS findings (structure / process)

Reported separately per §17b; neither blocks on its own.

| Verdict | Finding | Evidence | Fix |
|---|---|---|---|
| `advisory` | **N3** Zero unmocked coverage of the admin→backend HTTP seam in `pnpm test` | 61/81 admin test files stub `fetch`; remaining 20 are network-free unit tests; `visual/` harness is manual + screenshot-only | One smoke test against a live backend in CI, or promote `visual/` into the pipeline |
| `advisory` | CI test steps must not pipe vitest through a status-swallowing command | This session: `vitest … \| tail` reported exit 0 on a red suite | Assert vitest's own exit code in #107 |

### 6.3 `not-checked` — no verification performed, no verdict inferred

- **Live dev-DB exposure counts** (0 FLOATING SEs, 0 deferred rows, 0 removed rows, etc.) — the prior
  audit measured these today; I did not re-probe and do not restate them as current.
- Anything behind the VPN / AutoPlant MySQL — unchanged from the prior audit's `Unable to verify`.
- Backend runtime state (`runtime_lock` fingerprint, `dispatch_runs` row 4) — not re-queried.

---

## 7. Phase 5 — Repeat-vs-new ratio and churn diagnosis

**Ratio: 7 repeats : 4 new — repeat-dominated.**

Repeats: B1, B2, B3, B4, B5, §3.1 governance, X1 (narrowed).
New: N1a, N1b, N2, N4. (N3 is a new observation about an accepted design, hence advisory.)

**§28 reading — this is a process problem, not scope growth.** Scope is not expanding; the same
findings are being re-reported because the fixes are not landing. The prior audit ranked
"commit + push the dispatch-correctness layer" as **#1, effort: minutes**, in a document dated *the
same day* — and the tree has since grown from 37 to **41** dirty paths.

**§29 churn classification — (a) product/process defects, not test-harness defects.** The failures are
not flaky selectors, broken seed data, or timeout noise: both suites are deterministic, the admin one
across two full runs, and all three test failures resolve to specific source commits. The harness
itself is in good shape — the backend's isolated `_test` database and serial-file discipline are
sound engineering. So the loop is **not** churning on the harness, and more review passes will not help.

**The recurring gate is Gate 1 (proof of life), and every finding in it shares one root cause: there
is no CI.** The pattern is now confirmed three times over, on both sides of the stack:

| Change | Guarding test | Red for |
|---|---|---|
| `b9242da` #128 widened the operational-status filter (backend) | `integration-reconciliation.e2e-spec.ts` | **43 commits / 4 days** |
| `ad03769` removed the Critical KPI (admin) | `kpi-critical-plus-consistency.test.tsx` | **3 commits** |
| uncommitted `EditableCell` rework (admin) | `se-management-directory.test.tsx` | uncommitted |

**The decisive detail is the #128 session log (INDEX:113).** That session was *not* careless — it ran
a deliberate four-suite regression sweep and recorded it. It still missed this, because the broken test
lived outside the blast radius the author imagined. **This is the failure mode that only CI fixes:**
no amount of author diligence reliably selects the right subset, and both prior audits' "test posture"
assessments measured test *volume* while the suites were red.

Tuning effort belongs at **#107**, not spread across the whole process.

---

## 8. Backend suite — full result

`npx vitest run` in `apps/backend`: 289 spec files, `fileParallelism: false`, against a real
Postgres 16 + PostGIS at `localhost:5433`.

```
 Test Files  1 failed | 285 passed | 3 skipped (289)
      Tests  1 failed | 1170 passed | 5 skipped (1176)
   Duration  544.31s
```

**Verdict: RED** — one failure, root-caused in §3.5 (N4). Everything else passes.

Notes worth recording, since this appears to be the first observed full run:

- **It completes.** The repo's standing OOM warning — which the prior audit cited as its reason not to
  run the suite (*"the docs' own OOM warning makes an unattended full run unreliable"*) — did not
  materialise. The suite ran to completion unattended in **~9 minutes**. That is well inside any CI
  budget and removes the stated obstacle to #107.
- **Isolation held.** `test/global-setup.ts` targets the `_test` sibling database; the live dev DB
  driving the running cron was untouched.
- **The 1,170 passes are real.** The backend→Postgres seam is exercised unmocked throughout, so this
  is a genuinely strong suite — which is exactly why leaving it red for 43 commits is costly.
- `tsc --noEmit` is clean on the backend with the full uncommitted layer applied.

---

## 9. Verdict

**Drifting** — not on architecture, which the prior audit assessed as GOOD and which nothing this cycle
contradicts, but on **delivery discipline**.

| Dimension | Assessment |
|---|---|
| Architecture | **GOOD** — unchanged. No rewrite warranted. |
| Progress vs PRD | **~70%** — prior figure stands (mobile is the gap; out of this review's scope). |
| Admin FE completeness | **Prior "~95%" is now suspect** — a committed regression sat unnoticed for 3 commits, and an AC is checked with no UI behind it. |
| Test posture | **Downgraded from "Medium" to "strong suites, both red"** — 1,488 tests across both apps with real unmocked DB coverage, genuinely good work; 3 failures, none noticed, one standing 43 commits. Volume was never the problem. |
| Production readiness | **4 / 10** — unchanged; no finding this cycle moves it either way. |

### Ordered next steps (blockers first)

| # | What | Why now | VERIFY signal |
|---|---|---|---|
| 1 | Fix **N4** — update the reconciliation test to `IN (?, ?)` / `['DEPLOYED','ACTIVE']` | One-line, zero-risk, no decision needed; gets the backend suite green so it can gate everything else | `npx vitest run` (backend) → 1176/1176, reading **vitest's** exit code |
| 2 | Resolve **N1a** — decide intent, then restore the KPI or rewrite the test + record the decision | A `fail` on a core operator surface, red on committed code | `npx vitest run` (admin) → 318/318 |
| 3 | Fix **N1b** — retarget the test at "Manage coverage →" | Blocks the same suite | same run green |
| 4 | **Commit the correctness layer by explicit path**, then push | Ranked #1 "minutes" a day ago and now worse; proven fix, one disk, no CI | `git status` clean of backend scheduling/recommender paths + the migration tracked |
| 5 | **#107 CI** running both suites, asserting real exit codes | Converts every "green" from a local claim into evidence; is the shared root cause of all three test failures. **The OOM objection is now disproven — the full backend suite runs unattended in ~9 min** | A deliberately-broken test fails the job |
| 6 | Resolve **N2** — uncheck AC#18 + file the follow-up, or build the viewer | Parity gate; cheap either way | INDEX links a follow-up issue, or the viewer renders a ticket chain |
| 7 | Fix **X1** — one sentence in `SYSTEM-STATE:67` | The current-state doc misstates the single most consequential operational fact | Line reads true against `.env` |

Steps 1–3 are ~30 minutes of work in total and take both suites green, which is the precondition that
makes step 5 meaningful.

Prior ranks 2–10 (#124 config snapshot, B1/B2/B3 override integrity, B4 sweep staleness, #103, #91/#110)
remain valid and unchanged — this cycle adds nothing to them and removes nothing from them.

### Kill list

- **Piping test commands through `tail`/`head` in any automated context.** It silently converts red to
  green. This session demonstrated it.
- **Marking UI acceptance criteria `[x]` on the strength of a shipped endpoint.** N2 is the second
  instance (zone-mapping/#120 was the first, and that one at least got filed).

### Open questions (inferred — for a human, with my recommended answer)

1. **Was dropping the Critical Devices KPI from the Pan-India dashboard in `ad03769` intentional?**
   *Recommendation: it was accidental.* Issue 122's explicit purpose was KPI↔scorecard consistency, and
   the guarding test was left in place rather than deleted — the signature of an oversight, not a
   decision. But this is a product call and is flagged, not assumed.
2. **Should the audit-trail viewer be built now or formally deferred?**
   *Recommendation: formally defer via a filed follow-up.* The API is done and audited; the UI is not
   urgent while the operator set is one person. What is not acceptable is the current state — an AC
   checked with nothing behind it and no owner.

**One line:** *Drifting — the architecture is sound, the suites are strong, and the backlog is honest,
but **both suites are red and nobody knew**, one for 43 commits; **the single highest-leverage next
action is #107 CI** — now unblocked, since the full backend suite is proven to run unattended in ~9
minutes.*

---

*READ-ONLY audit. No code changed. No issue files created — triage owns that. The route-inventory
script was written to the session scratchpad, outside the repo. Per `CLAUDE.md`'s progress convention
this document does not fork current-state: `SYSTEM-STATE-2026-07.md` and `INDEX.md` remain the two
living documents, and the INDEX session-log line for this session has not been appended (read-only
audit — pending operator go-ahead).*
