# Handoff — P9 committed (`6ceaea5`); F6 filed as P10 (#280/#281), not started

**Date:** 2026-08-24 · **Branch:** `feat/autoplant-integration` @ `6ceaea5`, **ahead 43, not pushed**
**Working tree:** 135 uncommitted files — see §3 before touching git.

This session began with the operator asking why the Scheduler-engine UI wasn't the one they planned.
It ended with P9 committed and that actual question finally answered correctly. Read §1 and §5 first;
§5 is the part a fresh agent is most likely to get wrong.

---

## 1. The premise error worth knowing about

The opening question — *"I proposed a new UI for the Scheduler engine, but the current UI isn't that"* —
was answered on an **assumption I never confirmed**: that they meant the Assign Work Console. They did
not. They meant the **dispatch/scheduler surfaces** (`/schedules`, `/schedules/preview`,
`/dispatch-runs`), proposed in the 2026-08-19 audits and **never filed as an issue by anyone**.

The work done under the wrong premise is still real and verified (§2), but the operator's actual
question was only answered at the end of the session, and its outcome is §4.

**Rule for the next session:** "the design I approved" is ambiguous in this repo. Three tiers get
called that, and only one is authoritative — `docs/ui/desktop/approved-designs/README.md` tables every
approved design and its owning decision issue. An audit recommendation is **not** an approved design
and nothing is built from it until it becomes a decision record + backlog issue. Confirm which one
before building. (Also saved to agent memory as `confirm-which-design-before-building`.)

---

## 2. What landed — committed

**`6ceaea5` — `feat: complete Assign Work Console (P9) on scheduler tail`** · 50 files,
+4480 / −699. Read the commit message; it is long and explains the composition. Do not re-derive it.

Two fixes were made this session on top of the previously "done" P9 work:

1. **The #276 no-eligible-engineer rail.** The AC claimed it; the code did not have it — `result.unplaced`
   was discarded on *Add to draft*, and `noEligibleEngineerCount` was hardcoded `0`. Now real state in
   `AssignConsolePage.tsx`, rendered as the approved design's rail, carried into Review & Commit.
2. **Acting-zone / audit consistency.** `api/schedules.ts` had a *bearer-only* header builder shadowing
   the shared one, so the console's writes never sent `X-Acting-As-Zone` at all — a backend-only fix
   would have been inert. Backend: all five `/schedules` writes now take `@CurrentActor()`, resolve
   scope through one `scopeFor()` helper, and record `actedAsRole`.

Full detail: the commit message, `.scratch/fsm-platform-v1/issues/275|276|277-*.md`, and
`docs/progress/275|276|277-*.md` (uncommitted — see §3).

**Verification at commit time:** backend 416 files / 2116 passed / 0 failed; admin 106 / 573 / 0
failed; tsc clean both apps; backend build clean; live `/assign` driven against real data.
The commit was additionally **proved self-contained**: the other 133 files were stashed so the tree
was exactly the commit, then tsc + the P9 suites were re-run green, then restored.

---

## 3. The working tree — 135 files, and why the commit looks "wider than P9"

**Do not `git add -A`.** The tree holds several unrelated in-flight workstreams.

| Category | ~Count |
|---|---|
| MUI/theme + enterprise UI (charts, settings, shell, login, 28 visual baselines, `ui/Select`) | 73 |
| Documentation / audit (INDEX, SYSTEM-STATE, `docs/progress/275-277`, handoffs, xlsx) | 20 |
| #264 outbox remainder · #270 filter-transparency remainder · #267 home-base remainder | 10 / 8 / 7 |
| #239 acting-scope infrastructure (`manager-scope.ts`, `@CurrentScope`, dashboard/reports controllers) | 7 |
| Test-harness diagnostics (tinypool patch, `crash-diagnostics.ts`, `vitest.config`, `run-tests.mjs`) | 3 |
| Other — incl. a **root `package.json` regression** | 5 |

**Why `6ceaea5` carries #264/#267/#270 code.** A P9-only commit that compiles is impossible without
editing shared files. `assignLane` (#275's own write) calls #264's `queueDayPlanOverridden`;
`recommender.service.ts` holds #267, #270 **and** #276's scoped-projection seam in one file, and
#276's `DistributeProjectionService` calls that seam. The operator chose "Option A" — one atomic
buildable commit with an accurate message — over a non-compiling split. The commit message enumerates
exactly which files/hunks were carried and why.

**A trap that was caught and must not be re-introduced:** the *committed* `hard-filters.spec.ts` fails
against the carried `hard-filters.ts` (#270 changed its shape). A test must travel with its subject or
the commit lands red. Verified by extracting the HEAD version and running it.

**Root `package.json` regression — still present, should be reverted, not committed:** an accidental
`dependencies` block with `@mui/material` + `@emotion/*` at the workspace root. They already live
correctly in `apps/admin/package.json`.

---

## 4. What was filed this session — P10, NOT started

Audit finding **F6 (HIGH)** formalised through the repo's normal workflow:

- `.scratch/fsm-platform-v1/issues/280-decision-dispatch-timeline-ia.md` — decision record. Direction
  approved 2026-08-24; **four open questions unruled**.
- `.scratch/fsm-platform-v1/issues/281-dispatch-timeline-navigation.md` — implementation issue,
  `Status: needs-triage`, 14 acceptance criteria. **Blocked on #280 Q1–Q3.**
- `INDEX.md` — new **P10** block registering both.

Read those two files rather than this handoff for the substance. Three things a next agent must not
get wrong:

1. **#280 R2 — group and cross-link, do NOT merge.** Preview / Schedules / Dispatch Runs answer three
   different operator questions. Collapsing them into one page would be a *worse* error than the
   present fragmentation.
2. **#280 R7 — this is not P9.** `/assign` is the *manual* assignment surface and is finished. P10 is
   the *automatic* engine's timeline. They are not merged.
3. **No approved design or v2 image covers this screen set.** If #280 Q1's answer needs a layout the
   reference set never drew, an approved design must be added under
   `docs/ui/desktop/approved-designs/` by operator decision **before** #281 starts.

The two source audits (`audit/navigation-ia-audit-2026-08-19.md`,
`audit/frontend-ux-audit-2026-08-19.md`) are **untracked** — #280 cites them as evidence, so they
should be committed (that is #280's own open question Q4).

---

## 5. Outstanding, in the order it probably matters

1. **Ask the operator which work is next** — P10 is blocked on their rulings (#280 Q1–Q3), so it
   cannot simply be picked up.
2. **Documentation bookkeeping for `6ceaea5`** — INDEX session-log line and SYSTEM-STATE were
   deliberately excluded from the commit and are still uncommitted. `docs/progress/276-*.md` was
   **deliberately not committed**: it predates the rail fix and claims a rail test that only asserted
   the Distribute panel banner, and its test counts are stale. Per `CLAUDE.md` progress reports are
   frozen once written and corrections go to INDEX/SYSTEM-STATE — so the correction belongs there.
3. **Commit the remaining workstreams** — #264 / #267 / #270 remainders, #239, MUI/theme, test-harness.
   Note their *core* code already shipped inside `6ceaea5`; what is left is their UI, their own tests
   and their remaining services. Check what is already in `6ceaea5` before assuming a file is unlanded.
4. **Revert the root `package.json` regression** (§3).
5. **Known non-blocking follow-ups** recorded at the end of the P9 verification: `GET /schedules/engineers`
   is not acting-scoped while the rest of the console is; the intraday surface ignores acting on both
   halves; `scopeFor()` duplicates #239's `resolveManagerScope` and #239 should collapse them; #272's
   open question Q1 (Device Detail deep-link) is still unruled; design deviations D1/D3/D4/D5 (ledger
   risk-tag cell, 3 of 4 filter chips, device search, legend) need follow-up issues to satisfy the
   parity gate; pre-existing `TicketDetailDrawer.tsx:440` fault.

---

## 6. Environment — deltas only

Base facts (test chunking, the `#184` Windows flake, CRLF handling of SYSTEM-STATE) are unchanged —
see `audit/fsm-handoff-2026-08-24-p9-275-276-done.md` §4 rather than re-reading them here.

Two additions from this session:

- **The stale-`dist` trap — this caused the whole opening "the UI is broken" report.** The backend runs
  `node dist/main.js`; a `dist` compiled before the console's endpoints existed made
  `GET /api/schedules/assignable-work` fall through to `GET /schedules/:engineerId` and 400 on its
  `ParseUUIDPipe`, so `/assign` rendered "Failed to load the work pool". **Always
  `npm run build` + restart the backend before believing a UI-is-broken report.** The app's own Build
  Health banner detects this and was ignored.
- **Driving the app**: `chromium-cli` is not available here. Use `@playwright/test` from
  `apps/admin`, copying the login + client-side-nav pattern in `apps/admin/visual/capture.mjs`
  (session is React-state only, so a full page load of a protected route redirects to `/login`).
  Seeded dev logins and their well-known password are documented in
  `docs/runbooks/local-development-login.md` — not repeated here. Delete any scratch driver script
  afterwards; several were created and removed this session.
- A full backend suite run **killed the running dev backend**. Run live browser checks *before*
  starting a full suite, or restart the server after.

---

## 7. Suggested skills for the next session

- **`/tdd`** — for #281 when it unblocks, and for any of §5's follow-ups. The repo's red-green
  protocol; note this session's convention of *verifying test sensitivity* by reverting the fix and
  confirming exactly the intended tests fail.
- **`/code-review`** — if reviewing `6ceaea5` before push (`--since aed7c2e`). Its Spec axis is the
  right tool for checking the carried-dependency reasoning.
- **`/field-ops-director`** — before implementing #281. The R2 risk (collapsing three operator
  questions into one page) is a domain-reality failure a code review would not catch.
- **`/grilling`** — to stress-test #280's open questions Q1–Q3 with the operator before building.
- **`/diagnose`** — if another "the UI is broken" report arrives; check the stale-`dist` trap first.
- Do **not** reach for `/design` or the artifact design skills for #281 unless the operator has ruled
  Q1 and asked for a design — #280 explicitly forbids inventing a layout.

---

## 8. Do not

- Do not re-open or modify P9 / `6ceaea5` — verified complete and committed.
- Do not `git add -A`, and do not push (branch is 43 commits ahead of origin; nothing was pushed).
- Do not treat the 2026-08-19 audits as an approved design (§1).
- Do not mark #281 done, started, or `ready-for-agent` while #280 Q1–Q3 are unruled.
