> **ARCHIVED 2026-07-14** — consumed: slice 4 applied (935 tickets cancelled, UNZONED 4,607→3,620),
> docs updated, branch pushed. Current state lives in `docs/SYSTEM-STATE-2026-07.md` + INDEX.md.

# Handoff — #119 FSM-owned plant deactivation (mid-slice-4)

**Date:** 2026-07-14
**Branch:** `feat/autoplant-integration`
**Repo:** `D:\fms_adminDashbooard\fsm-platform-greenfield`
**Next session focus:** finish Slice 4 (apply the 6 STAR CEMENT deactivations to the dev DB), then docs + push.

---

## TL;DR — where it stopped

#119 slices **1–3 are DONE, committed, but NOT pushed**. Slice **4 (apply to the 6 STAR CEMENT
plants) has NOT run** — the apply script failed at module load *before touching the DB*, so the dev
DB (`fsm`) is **unmutated** (all 6 plants show `alreadyDeactivated=0`). No partial state to clean up.

Also still outstanding: the docs updates (#119 issue status, INDEX session-log line, SYSTEM-STATE
UNZONED reality, the shutdown file) and the final `git push`.

---

## Git state

- `origin/feat/autoplant-integration` = `a91278e` (the #121 export work, pushed earlier this session).
- **Unpushed local commits** (on top of origin):
  - `563c39d` feat(backend): #119 slice 1 — service + migration + downstream exclusions
  - `4ddf347` test(backend): #119 slice 2 — plant deactivation e2e
  - `09ec199` feat(admin): #119 slice 3 — OH Plant Deactivations admin page
- Working tree clean except pre-existing untracked evidence files under `docs/audits/*.xlsx|*.csv`,
  `docs/reverse-engineering/`, `docs/ui-redevelopment/` — **not mine, leave untracked** (per the
  standing instruction). The `docs/audits/unzoned-plants-2026-07-07.md` whitespace diff was already
  reverted earlier this session.

Do the final `git push` only after slice 4 + docs land (user wants commit-per-slice, push at end).

---

## What's already built (don't rebuild — read the commits/diffs)

See commits `563c39d`, `4ddf347`, `09ec199`. Summary of the design so the decisions aren't re-litigated:

- **Model:** `plant_deactivations` side table (migration `apps/backend/prisma/migrations/20260714120000_plant_deactivations/`),
  partial-unique `plant_deactivations_one_active_per_plant WHERE reactivated_at IS NULL`. Anti-drift
  like `plant_zone_overrides` — never in the master-sync update set.
- **Service/controller/module:** `apps/backend/src/plant-deactivation/`. OH-only API:
  `POST /api/plants/:plantId/deactivate {reason}`, `POST /api/plants/:plantId/reactivate {reason?}`,
  `GET /api/plants/deactivations`.
- **Cancel semantics (decided):** deactivate cancels open tickets → status `CLOSED` +
  `closureType OPERATIONS_HEAD_OVERRIDE_CLOSE` + `closureReason 'PLANT_DEACTIVATED: <reason>'` +
  `TicketEvent.reasonCode 'PLANT_DEACTIVATED'` + parent FailureCycle → `state FAILED` (NOT VERIFIED —
  avoids REPEAT mis-flag) + `hasOpenFailureCycle=false`. Reused `CLOSED` deliberately (a new
  TicketStatus enum value would need adding to every open/closed set — too much blast radius).
  Whole thing runs in one `AuditService.withAudit` tx → one `PLANT_DEACTIVATED` audit_log row.
- **Downstream exclusions** (each expressed in its own query style, keyed on `reactivated_at IS NULL`):
  ticket-creation (`ticket-creation.service.ts` Prisma `notIn`), dashboard counts
  (`dashboard.service.ts` `EXCLUDE_DEACTIVATED_PLANTS` raw-SQL predicate on zone + company/plant),
  recommender dispatch (`recommender.service.ts` relation filter on both troubleshoot + install),
  #121 export `plant_fsm_status` column (`entity-mapping-export.service.ts` LEFT JOIN).
- **Reactivation:** stamps history row; pipeline re-creates tickets for still-inactive devices next run.
- **FE (slice 3):** `apps/admin/src/pages/admin/PlantDeactivationsPage.tsx` + `api/plantDeactivations.ts`,
  OH-only nav ("Plant Deactivations", Admin group) + `/plant-deactivations` route. List DataTable +
  Reactivate confirm dialog + Deactivate flow (plant picker from `/org/plants` + mandatory reason).

**Tests (all green this session, targeted per OOM-box rule):** `plant-deactivation.e2e-spec.ts` 7/7,
`entity-mapping-export.e2e-spec.ts` 8/8 (incl. deactivated-plant `plant_fsm_status`),
`ticket-creation*.e2e` 13/13, dashboard/recommender/non-op suites green, FE
`plant-deactivations-page.test.tsx` 4/4 + nav/routing regressions. `tsc --noEmit` clean both apps.

---

## Slice 4 — the remaining work (apply + verify + docs + push)

### Ground truth already gathered (dev DB `fsm`, localhost:5433) — don't re-investigate

- **Zone 5 = "UNZONED"** holding zone, **4,607 devices**.
- The 6 STAR CEMENT plants (all `zone_id=5`, `alreadyDeactivated=0`):

  | source_plant_id | plantId | name | devices | open tickets |
  |---|---|---|---|---|
  | 3040 | 7 | JORHAT CPW-SCL-LUMS | 280 | 262 |
  | 3530 | 102 | BARPETA ROAD CRS-SCNEL | 341 | 326 |
  | 3078 | 9 | RANIPATRA CRS-SCL-SGU | 207 | 202 |
  | 3529 | 101 | CHANGSARI CDW SCL-GGU | 135 | 125 |
  | 3619 | 128 | SCNEL SILCHAR CEMENT | 24 | 20 |
  | 3187 | 27 | StarCement - LUMS | 0 | 0 |
  | **TOTAL** | | | **987** | **935** |

- **Expected after apply:** ~**935 open tickets cancelled**; UNZONED (zone 5) device count
  **4,607 → 3,620** (Δ 987, since the dashboard/UNZONED tally now excludes deactivated plants).
  (Note: this matches the user's ~4,605→~3,600 expectation; UNZONED here means zone 5, NOT
  `zone_id IS NULL` — that count is 0 in this dev DB.)

### The apply script (written, but has a fix-needed bug)

Script: `<scratchpad>/apply-star-cement.ts` (this dir). It boots the full Nest app against the dev DB
(no port bind, like the e2e harness), logs in as OH (`ops.head@fsm.test` — in-memory user store, DB-
independent), and POSTs the 6 deactivations **through the real HTTP API**, with per-plant reasons
citing `docs/audits/shutdown-plants-2026-07-13.md` + the disputed-claim caveat (AutoPlant still lists
them ACTIVE; 3078 ACTIVE-only). It also verifies: cancelled count, UNZONED before/after, LIST
endpoint, export `plant_fsm_status`, and a simulated master-sync-survival (real sync is VPN-blocked —
`connect ETIMEDOUT` to `10.0.0.25:3306`, confirmed earlier).

**BUG to fix:** running `npx tsx` on a script located in the scratchpad fails to resolve bare imports
like `@nestjs/core` (node_modules is in the project, not the scratchpad). The `investigate` script
worked only because it imported `PrismaService` via an absolute path (its own deps resolve relative to
the project file). **Fix:** copy the apply script into `apps/backend/` (e.g. `apps/backend/scratch-apply.ts`),
change imports to project-relative (`./src/app.module`, `./src/prisma/prisma.service`), run
`npx tsx -r dotenv/config scratch-apply.ts` **from `apps/backend`**, then **delete the temp file**
(do not commit it). `DATABASE_URL` in `apps/backend/.env` already points at the dev DB `fsm`.

Alternative (if you prefer "more real"): `npx tsx -r dotenv/config src/main.ts` from `apps/backend` to
run the server on port 3000, then curl the endpoints with an OH bearer. The no-port app-context
approach above is simpler and still exercises the full API stack.

### After apply — verify then document

1. Confirm the printed numbers match expectations (935 cancelled, 4,607→3,620, LIST shows 6, export
   all 'deactivated', survival=6).
2. **Docs (mandatory per CLAUDE.md convention):**
   - `.scratch/fsm-platform-v1/issues/119-plant-deactivation-semantics.md` — set Status: done, note
     the mechanism + apply.
   - `.scratch/fsm-platform-v1/INDEX.md` — append ONE session-log line (date · what landed · commit
     hashes) and update #119 status in the issue list/Next-up.
   - `docs/SYSTEM-STATE-2026-07.md` — UNZONED reality changed (zone 5: 4,607 → 3,620 operational);
     add the plant-deactivation capability where guard-chain/eligibility is described. Edit in place.
   - `docs/audits/shutdown-plants-2026-07-13.md` — note the 6 were deactivated in FSM (reversible,
     disputed-claim caveat recorded in each reason).
3. Commit slice 4 (the docs + a note that apply ran; the apply itself mutates the DB, no code to
   commit beyond docs). Then **`git push`** (sends slices 1–4).

### Guardrails (unchanged from the session)

- **Scheduler flags and `eligibility_mode` untouched.**
- Untracked xlsx/csv evidence files stay untracked.
- Real master-sync can't run (VPN down); survival is proven by e2e + the simulated mirror refresh.

---

## Suggested skills for the next session

- **`/verify`** — after the apply, drive the OH Plant Deactivations page + the export end-to-end to
  confirm the 6 show as deactivated in the real UI/export (not just DB assertions).
- **`/code-review`** (or `/review`) — optional review of the #119 slices 1–3 diff before pushing.
- **`tdd`** — only if extending behaviour; the current slices already have e2e/FE coverage.

## Key files (quick index)

- Backend: `apps/backend/src/plant-deactivation/` · `prisma/migrations/20260714120000_plant_deactivations/`
  · exclusions in `ticketing/ticket-creation.service.ts`, `dashboard/dashboard.service.ts`,
  `recommender/recommender.service.ts`, `exports/entity-mapping-export.service.ts`
- Tests: `apps/backend/test/plant-deactivation.e2e-spec.ts`, `test/entity-mapping-export.e2e-spec.ts`
- FE: `apps/admin/src/pages/admin/PlantDeactivationsPage.tsx`, `api/plantDeactivations.ts`,
  `components/shell/nav.ts`, `AppRoutes.tsx`, `test/plant-deactivations-page.test.tsx`
- Scratch scripts (temp, not committed): `<scratchpad>/apply-star-cement.ts` (fix + relocate),
  `investigate-star-cement.ts`, `check-zone5.ts`

---

## Operational notes & gotchas (learned this session — save yourself the time)

- **Test runner:** `npx vitest run <pattern>` from `apps/backend`. Run **targeted** (OOM-box rule —
  the box OOMs on the full suite). When a batched run prints `Worker exited unexpectedly` / a file
  "fails" only in a batch but passes alone, that's worker OOM + shared-test-DB contention, not a real
  failure — re-run serialized: `npx vitest run <patterns> --no-file-parallelism --pool=forks`.
- **DBs:** dev = `fsm`, test = `fsm_test` (both `localhost:5433`). `apps/backend/.env` `DATABASE_URL`
  points at `fsm`. Test migrations are auto-applied to `fsm_test` by the test global-setup.
- **Migrations:** author by hand-writing `prisma/migrations/<ts>_<name>/migration.sql`, then
  `npx prisma migrate deploy` (NOT `migrate dev` — avoids the shadow-DB/CREATEDB requirement), then
  `npx prisma generate`. Partial-unique indexes are raw SQL in the migration (not expressible in the
  Prisma schema). The generated client (`src/generated/prisma`) is **gitignored** — never commit it.
- **Timezone CHECK trap (cost real time):** the runner's wall clock is *behind* the simulated date,
  and IST offset applies. `failure_cycles_valid_close` = `closed_at >= opened_at`; the deactivate
  service closes cycles with real `new Date()`. So any seed with a *future/hardcoded* `openedAt` (e.g.
  `2026-07-14T…`) makes `closed_at < opened_at` → 500. **Seed timestamps relative to real
  `Date.now()`** (e.g. `new Date(Date.now() - 4*86_400_000)`), not hardcoded dates.
- **Auth for scripts/tests:** login via the in-memory user store (DB-independent):
  `ops.head@fsm.test` / `csm@fsm.test` / `zm.north@fsm.test` / `se.north@fsm.test`, password
  `correct-password`. Guards are a global `APP_GUARD` chain (Auth→Role→ZoneScope) since #99 — new
  controllers just use `@Roles(...)`, no local `@UseGuards`. Any new route not guarded/`@Public()`
  fails the #99 route-sweep e2e (`global-guard-validation.e2e-spec.ts`).
- **`npx tsx`** isn't preinstalled (installs `tsx@4.23.1` on first run). A bare `import '@nestjs/core'`
  only resolves when the script lives **inside the project tree** (node_modules is there) — that's the
  slice-4 apply-script bug. An absolute-path import of a single project file (like the investigate
  script does for `PrismaService`) works from anywhere because that file's own deps resolve locally.
- **Apply idempotency:** re-running the apply will return **HTTP 409 `ALREADY_DEACTIVATED`** for
  plants already deactivated — that's expected, not a failure. Treat 409 as "already applied".
- **Booting `AppModule` in a script** starts `@nestjs/schedule` crons. Business sweeps are gated by
  `BUSINESS_SWEEPS_ENABLED` (off), so it's safe, but **`await app.close()` promptly** and don't leave
  the process running.
- **LIST endpoint fields:** `company` is the modal company of the plant's devices; `deactivatedBy` is
  a raw actor UUID (UI shows first 8 chars). `deviceCount` is all device_states on the plant.
- **Reading order for the fresh agent:** `CLAUDE.md` → `docs/SYSTEM-STATE-2026-07.md` →
  `.scratch/fsm-platform-v1/INDEX.md` → issue `119-plant-deactivation-semantics.md`. Both #119 HITL
  decisions are already resolved (cancel-open-tickets; apply now) — slice 4 is AFK-executable.
