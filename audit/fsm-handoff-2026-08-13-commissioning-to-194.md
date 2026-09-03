# Handoff — FSM platform, 2026-08-13

**From:** session that investigated and built the "Recently Commissioned Devices" feature.
**To:** next session, to continue implementation — starting with **#194** (dev login seed) and onward.
**Repo:** `C:\fsm-platform-backup` · **Branch:** `feat/autoplant-integration` · **Tip:** `a5a312b`

Read `CLAUDE.md` → `docs/SYSTEM-STATE-2026-07.md` → `.scratch/fsm-platform-v1/INDEX.md` first, as
always. This document only covers what those do *not* already say.

---

## 1. What landed this session (do not re-read the code to find out — read the reports)

An operator ask for a "Recently Commissioned Devices (last 3 months)" feature. It turned out to be
~70% already built as **#232**, with one predicate wrong. Delivered as a correction plus four slices.
**No new table, no new module, no new cron, no migration, no new index, no additional AutoPlant query.**

| Ref | Where the detail lives |
|---|---|
| Investigation & design | `audit/recently-commissioned-devices-investigation-2026-08-13.md` |
| #233 population fix | `docs/progress/233-commissioning-population.md` |
| #234 resolution curve | `docs/progress/234-commissioning-resolution-curve.md` |
| #232 admin surface | `docs/progress/232-commissioning-admin-surface.md` |
| #235 drill-through | `docs/progress/235-commissioning-drillthrough.md` |
| KPI provenance | `docs/kpi-definitions.md` §8 |
| Session narrative | `.scratch/fsm-platform-v1/INDEX.md` — five session-log rows dated 2026-08-13 |

Commits `93900e8`, `63c838b`, `e726c82`, `0efa079`, `b24630c`, `cf0b850`, `07dd62d`, `6b788a1`,
`a5a312b`. All four issues are `done`. Nothing from this work is uncommitted.

---

## 2. THE CORRECTION THAT CHANGES YOUR STARTING POINT

I told the operator, more than once, that the two new admin pages "have never been opened in a browser
because no dev credential exists (#194), so every login 401s." **The first half is true; the second is
wrong for this machine.** I verified the database after saying it:

| `fsm` @ localhost:5433 | |
|---|---|
| `user_credentials` rows | **9** |
| `*@fsm.test` accounts present | all 8 — `ops.head`, `csm`, `wm`, `se.north`, `zm.north/south/east/west` |

This is #194's documented **workaround** (see that issue's "Current workaround" section) — a one-off
run of `seedAuthFixtureUsers` against `fsm`, applied to this machine only, nothing committed. Password
is the fixture one recorded in the issue.

**Consequences for you:**

- **You can log in and visually verify both new pages right now**, on real dev data (~25.5k devices).
  That was listed as "not done" in both progress docs — it is available on this box, just not
  reproducible elsewhere. If you do it, record what you saw.
- **#194 is still entirely real** — a clean clone still cannot log in. The workaround does not survive
  a database reset and exists nowhere else.
- Do not let the workaround's presence make you close #194. It is the reason #194 was filed.

---

## 3. Suggested next work, in the order I would take it

### #194 — no committed path seeds a dev login *(the operator named this)*

`.scratch/fsm-platform-v1/issues/194-no-dev-login-seed-path.md` is unusually complete: the defect, the
three seeding paths and what each does, why #91 caused it and does not own it, why #190 is unrelated,
clean-clone repro, the acceptance criteria, and three pieces of **stale documentation to fix with the
code** (`SYSTEM-STATE` §3j, `org-seed.ts:8`, #133's done-note). Read it rather than re-deriving.

Two judgement calls it leaves open, worth settling before you write code:

1. **Where the dev entrypoint lives.** `seedAuthFixtureUsers` is deliberately walled off from
   `src/seed.ts` so `pnpm seed` against a real database can never mint `*@fsm.test` credentials. That
   walling-off is correct and the issue says so. The fix is the *other half* — a separate, explicitly
   dev-only entrypoint (the issue suggests `npm run seed:dev`) — not a relaxation of the wall.
2. **What guards it.** A dev-only seeder that can be pointed at production is a worse defect than the
   one it fixes. #217's `OPS_EXPLORER_ENABLED` (default-off, 404-not-403) is the in-repo precedent for
   an explicitly-gated capability.

It also unblocks the FE-00 visual harness (`apps/admin/visual/capture.mjs` logs in through the form
with those accounts), which has been stale since 2026-07-28 — likely for exactly this reason.

### Then, in rough order of value

- **Verify the two new pages in a browser** (cheap now, see §2) and stamp the result into the two
  progress docs' "Not done" sections.
- **#190** — the uncommitted test-infra bundle. Still uncommitted (see §4). Unrelated to #194 despite
  the shared theme; the issue says so explicitly.
- **`tsconfig.test.json` carries 93 pre-existing type errors** and nobody owns it. SYSTEM-STATE records
  `test/**` as typechecked since 2026-08-09; it is not currently clean. Baseline was identical before
  and after all of this session's work, and none are in files this session touched. Worth filing.
- **#229's auto-recovery has still never run.** It is the precondition for the deferred calendar-time
  cohort inactivity series (recorded in #234), and enabling it is an operator-gated ~9,888-closure
  event. Not a coding task — an operator decision.

---

## 4. Working tree — everything left is pre-existing, and each has a stated reason

```
 M apps/backend/scripts/run-tests.mjs      ┐
 M apps/backend/vitest.config.ts           │ #190's bundle — that issue owns it
 M pnpm-lock.yaml / pnpm-workspace.yaml    │
?? apps/backend/test/crash-diagnostics.ts  │
?? patches/                                ┘
 M apps/backend/src/main.ts                 a human's study annotations; behaviour unchanged
?? apps/backend/_wh_evidence.mjs            one-off evidence script
?? audit/*.txt, *.xlsx, docs/*.xlsx         point-in-time extracts
```

Leave them unless you are doing #190. The 2026-08-13 session log explains each.

---

## 5. Environment facts that will save you time

- **Databases:** `fsm` (dev) and `fsm_test` (suite) on `localhost:5433`. Connection string is in
  `apps/backend/.env` — do not copy it into any committed file.
- **`psql` is not on PATH.** I queried the dev DB with a throwaway node script using the `pg` module
  already in `apps/backend/node_modules`. Worked fine; keep such scripts in the scratchpad.
- **AutoPlant MySQL** creds are in `apps/backend/.env` (read-only user, over VPN). Untouched this
  session — the feature added zero source queries.
- **Run:** backend `npm run build && npm start` (port 3000, prefix `/api`); admin `npm run dev`
  (5173). Both from their own app directory.
- **`test/probes/` + `vitest.probe.config.ts` are new this session** — a lane for checks that run
  against the live dev mirror, structurally outside the suite's collection glob because they assert
  properties of mutating data. `npx vitest run --config vitest.probe.config.ts`. It caught two real
  defects that fixtures could not. Use it; do not move probes into the suite.
- **The full local suite is not a reliable green/red signal** (#156 — `fsm_test` is never truncated).
  Run per-file and report per-file. I did not run the full backend suite this session; I ran the
  affected files and their neighbours.

---

## 6. Traps I hit, so you do not

- **Backticks inside SQL comments in a `Prisma.sql` template literal terminate the template.** Cost me
  a confusing three-line `TS1005`.
- **Prisma 7 takes a driver adapter, not a datasource URL.** `new PrismaClient({ adapter: new PrismaPg({ connectionString }) })` — `datasources`/`datasourceUrl` both throw.
- **Seeded login is `ops.head@fsm.test`, not `ops@fsm.test`.** Seven tests failed on that before I
  checked `src/auth/auth-fixture-seed.ts`.
- **A new e2e fixture can break a neighbouring assertion.** Mine shared a vehicle with an existing
  fixture and turned a `total === 1` search assertion into 2. I isolated the fixture rather than
  loosening the assertion — the assertion was right. Expect this in this suite.
- **`KpiInfo` renders nothing for an unknown catalog key**, so a typo silently drops the affordance and
  no test fails unless you assert `kpi-info-<key>` explicitly.
- **`vitest` 2.1 has no `--include` CLI flag.** Use a second config file.
- **Do not edit `FLEET_COUNT_COLUMNS` / `EXCLUDE_DEACTIVATED_PLANTS`** in `dashboard.service.ts`.
  Import them. They drive the KPI strip, zone rows, company×plant rows, Fleet Directory and Ops
  Explorer reconciliation; `dashboard-kpi-reconciliation.e2e-spec.ts` is the tripwire.

---

## 7. Operator decisions already settled this session — do not re-litigate

Recorded in the investigation report §12 and approved: 90-day window label (not "3 months");
`operational` default population; blank-remark bulk-load rows shown as their own row; 48 h grace;
installer logins labelled but never ranked as people; calendar-time inactivity series deferred behind
#229.

---

## 8. Suggested skills

| Skill | When |
|---|---|
| `/tdd` | Default for #194's seeder and anything after it. This repo's convention is red-green-refactor per slice with a per-issue progress report. |
| `/code-review` | Before committing a slice, especially anything touching auth or seeding — reviews against documented standards *and* the originating issue. |
| `/field-ops-director` | If you touch anything operational (dispatch, SLA, tickets, engineer workflow). Judges against field reality rather than code style. Not needed for a dev seeder. |
| `/diagnose` | If the backend or admin misbehaves at runtime once you can finally log in. |
| `/run` | To launch and drive the app for the visual verification in §3. |
| `/grilling` | Worth it before implementing #194 — a dev-only credential seeder is exactly the kind of thing whose guard rails deserve stress-testing before it exists. |
| `/security-review` | Recommended on the #194 branch specifically. It is a credential-minting path. |

Do **not** use workflows / multi-agent orchestration unless the operator asks — this session was told
not to, and nothing in the remaining work needs it.

---

## 9. Style notes on this operator, learned the hard way

- They want to be told when something did not pass as written. #234's AC-4 asked for a figure the
  endpoint could not return; I restated the AC against measurement and said so plainly rather than
  matching a literal. That was the right call.
- Measure before asserting. Two defects this session (the population predicate, the asymmetric epoch
  gate) passed every fixture test and were only visible against the live mirror.
- They commit deliberately and only when asked. Ask before committing; do not batch unrelated work.
- Record what is *not* done as prominently as what is. Both progress docs carry a "Not done" section,
  and the operator responded well to it.
