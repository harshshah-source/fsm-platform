# Integration Handoff — 2026-06-29

**Branch:** `integration/fe-plus-backend` (merge commit `fd64150`, two parents).
**Status:** ✅ Integrated and fully verified. This branch is now the **single source of truth** for continued development.

---

## 1. Why this happened

Post-Issue-27 work had forked into two divergent lines from a common base
`78db5a5` (the `issues-28-31-45-46-49-62` tip, 10 commits past `main`):

- **`feat/issue-34-install-lifecycle`** (the *backend-features* line, integration base)
- **`feat/fe-enterprise-ui`** (the *frontend-parity* line, merged in)

`main` carried none of it (31 commits behind `fe`, 25 behind `issue34`). The two
lines had become mutually dependent — FE-21..25 (analytics UI) are gated on the
report backends (39–44) that lived only on `issue34` — so consolidation was the
unblocking step, not optional parallelism.

## 2. Branches merged

| Line | Tip | Unique content |
|---|---|---|
| `feat/issue-34-install-lifecycle` (base) | `8363f5f` | Install lifecycle (34), intra-day insertion 29/30, cross-zone escalation (32), Notifications & audit spine (03), Reports 39–44, Recommender PREVENTIVE mode (72/75) |
| `feat/fe-enterprise-ui` (merged in) | `a831b5f` | FE-00..26 enterprise UI parity + Expense Vouchers backend (38) |

Module split before merge — `fe` added `vouchers/`; `issue34` added `reports/`,
`intraday/`, `cross-zone/`, `notifications/`. All other 23 backend modules shared.

## 3. Conflict summary & resolutions

A real `git merge-tree` predicted, and the merge produced, **exactly 5 conflicts** —
all additive/mechanical, **zero architectural conflict, zero divergent logic**
(Issue-33 was byte-identical on both branches, patch-id `747b5b19`).

| File | Type | Resolution |
|---|---|---|
| `apps/backend/src/app.module.ts` | mechanical | Union of `imports`/`controllers` registrations; single `InstallController` |
| `apps/backend/src/ticketing/ticketing.module.ts` | mechanical (superset) | Kept issue34 superset: `InstallService` + `InstallLifecycleService` + `INSTALL_NOTIFIER` |
| `apps/backend/src/ticketing/install.controller.ts` | add/add (superset) | Kept issue34 superset (Issue-33 create/CSV **and** Issue-34 lifecycle routes) |
| `apps/backend/prisma/schema.prisma` | mechanical union | Kept fe's `ExpenseVoucher*` + `EngineerMaster.expenseVouchers`, and issue34's `Ticket.fitted*` / intraday / cross-zone / notification / 4 summary models. No `TicketStatus` change; no field renames |
| `.scratch/fsm-platform-v1/INDEX.md` | semantic (renumber) | Union of status lines; **issue-number collision** resolved by keeping committed backend numbers (`#71`=SE-mobile-Install, `#72`=Recommender-preventive) and renumbering fe's two doc-only follow-ups: `#71`→**`#79`** (Schedule-stop payload), `#72`→**`#80`** (`Modal`-ize `window.prompt`). Inline FE-12/FE-16 refs updated |

## 4. Migration summary (44/44)

The two branches' migrations are disjoint except the byte-identical
`add_install_tickets`. The merged chain is linear and applies in timestamp order.

Recovery note (environment, not merge): the dev DB was rebuilt during integration.
A `migrate reset` had dropped the **out-of-band PostGIS extension** (the app role
`fsm` is not superuser; `20260621140000_add_geography_postgis` intentionally assumes
`geometry` already exists). After PostGIS 3.5.3 was reinstalled into the **correct
cluster** (PG16 / port 5433 / db `fsm` — there are two clusters; PG18 listens on
5432), recovery was: `migrate resolve --rolled-back geography_postgis` → drop the
failed run's partial `regions`/`districts` artifacts → `migrate deploy`.

Final: **44 migrations found, "Database schema is up to date!", no drift, no pending.**

## 5. Backend verification

- **e2e: 714 passed / 2 skipped (197 files), exit 0.**
- First run showed 13 failures, all `55000: materialized view "plant_eligible_floating_se" has not been populated` — an environment/bootstrap gap (clean `migrate deploy` leaves the MV `WITH NO DATA`), **not** a merge regression. Fixed by a one-time `REFRESH MATERIALIZED VIEW` (the first-run path `PlantEligibleFloatingSeService.refresh()` already implements). Re-run fully green.
- `tsc --noEmit`: clean. `tsc -p` build: clean.

## 6. Frontend verification

- Admin `tsc --noEmit`: clean.
- Admin tests: **108 passed (38 files)**.
- Admin `vite build`: OK (938 modules; one chunk-size advisory only).

## 7. Current development status

- `integration/fe-plus-backend` is green across every gate and is the source of truth.
- **Not yet promoted to `main`** (deliberate — promote in a separate reviewed step).
- The two parent branches remain unchanged for traceability.

## 8. Remaining open / deferred issues (high level)

Unchanged by this merge; see `INDEX.md` for the authoritative list.

- **Mobile app (~5%)** — Issue 54 foundation is auth-shell only; M-series 55–61, 63–68 + 77 unbuilt. Largest remaining workstream.
- **Analytics admin UI (FE-21..25)** — now **unblocked** (report backends 39–44 present on this branch). No pages yet.
- **Cross-zone admin UI (#78)**, **warehouse stock read (#73)**, **per-ticket form-read (#70)** — backend present/absent as noted; UIs pending.
- **Runtime/infra** — no scheduler/cron (workers are invoke-only), in-memory auth, external channels are log-only seams (FCM/APNs/WhatsApp/SMTP/S3), AutoPlant source is a mock. (`#76` covers notification-channel adapters.)
- **Deferred follow-ups:** `#79` (schedule-stop payload), `#80` (`Modal`-ize `window.prompt`), `#71` (SE mobile Install screens), FE-09 Forms tab (blocked by `#70`).

## 9. Recommended next development issue

**FE-21 — Reports landing + Fleet Uptime + Soft-Inactive.** This is the natural
next step and the one this integration unblocked: the FE-05 chart kit and the
BE-39/40 report endpoints now live on the same branch. Follow with FE-22..25 over
BE-41..44, then **#78** (Cross-Zone admin page over the existing `/api/cross-zone`).
Mobile (Issue 54 + M-series) remains the largest separate workstream.

## 10. MV bootstrap — long-term recommendation (documented, NOT implemented)

The failing tests exposed that a freshly-migrated DB serves `plant_eligible_floating_se`
**unpopulated** (created `WITH NO DATA`), so any read throws `55000` until a first
`REFRESH`. Where should population live?

- **During migrations? — No.** Migrations must stay data-free; a `REFRESH` there
  runs against empty plants/territory and couples schema to data.
- **During seed? — Only as a convenience.** There is no seed wired into
  `prisma.config.ts` and the e2e suite is self-seeding, so depending on a seed is fragile.
- **By the refresh service? — Already correct, keep it.** `PlantEligibleFloatingSeService.refresh()`
  owns the right logic (CONCURRENTLY with a first-run plain-`REFRESH` fallback) and is
  invoked on territory edits. The gap is *when it first runs*, not how.
- **Recommended — two complementary guards:**
  1. **Application startup:** an idempotent first-run populate (e.g. `OnModuleInit`
     calling `refresh()`) so no deployed environment ever serves an unpopulated MV.
  2. **Test bootstrap:** a global setup step that runs one `REFRESH MATERIALIZED VIEW`
     after `migrate deploy`, before the suite, so tests are hermetic on a clean DB.
  Optionally make `eligibleSeIdsForPlant()` resilient (treat unpopulated as empty) as
  defence-in-depth. Net: population belongs at **startup + test bootstrap**, driven by
  the **existing refresh service** — never in migrations.
