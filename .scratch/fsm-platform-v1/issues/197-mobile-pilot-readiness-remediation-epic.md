# 197 — EPIC: Mobile pilot readiness + cross-surface contract remediation

Status: ready-for-agent (parent — tracks slices, owns no code itself)
Type: EPIC · Mobile + Backend + Admin · Filed 2026-08-04

Parent for the remediation of two audits:
`audit/mobile-device-readiness-2026-08-04.md` (can it run on a handset at all) and
`audit/mobile-contract-sync-audit-2026-08-04.md` (does mobile agree with backend and admin).
Discrepancies found while verifying those audits: `audit/audit-discrepancies-2026-08-04.md`.

**This epic exists because nothing tracked pilot go/no-go.** The mobile work is spread across
INDEX.md section headings (`### Mobile-readiness block`, `### Mobile contract-freeze block`) that
carry no issue number, no status and no ACs. #169 calls itself "the freeze itself" but is scoped to
the backend contract; #172 was the governance ratification and is closed; #54 is the shell. That is
why [#170](./170-mobile-release-upgrade-mechanism.md)'s *"owner needed before pilot"* has had
nowhere to escalate to since 2026-08-03. **This issue is that escalation target.**

## What is actually wrong, structurally

Four root causes produce almost every finding in both audits. Naming them matters because the
slices are cut along them, not along audit section numbers.

1. **Mobile has no HTTP middleware layer.** Every screen hand-rolls `getAccessToken()` +
   `catch → 'offline'`. There is no interceptor, no refresh-on-401, no way to distinguish an auth
   failure from a network failure. The admin app solved this in `apps/admin/src/api/http.ts`; mobile
   never got the equivalent. This single absence produces the worst finding in either audit (the app
   silently misreporting expiry as "Offline" after 15 minutes) and makes every error-shape
   inconsistency user-visible as `Error(undefined)`.
2. **Contract types are synchronised by convention, not by types.** `@fsm/shared` is the intended
   single source, but `TicketStatus`, `WorkType` and the notification `type` vocabulary were never
   moved into it; label/tone maps are typed `Record<string, …>` so a missing enum member is
   invisible to the compiler; and `apps/admin` re-declares 13+ contract types by hand. There is no
   parity test anywhere. Every C-series divergence and half the B-series are instances of this.
3. **The admin app does not consume contracts that already exist.** `GET /api/media/:id` (shipped by
   #81), `GET /api/intraday-insertions` (shipped by #29/#30), and the whole notification spine
   (shipped by #03) have **zero** callers in `apps/admin/src`. Three separate PRD-specified manager
   workflows are therefore dead on the dashboard while their backends are green.
4. **Time has no ratified definition.** No document in the authority chain defines what "today"
   means for a work schedule, and the only IST reference in the entire 218-file backlog is an
   unrelated prose aside — while `utcDayStart` (a 05:30 IST boundary), an unpinned dispatch cron, and
   admin's device-local planner each assume a different answer.

Underneath all four sits a fifth, non-code problem: **you cannot currently run the app on a handset
at all** — no native build has ever been produced, and the one SE who can log in has zero work data.

## Execution order

Ordered by dependency and by risk of corrupting a field trial. A bug that makes the app misreport
its own state outranks one that leaves a screen empty, because the first generates false bug reports
from testers and burns their trust in the build.

**P0 — you cannot test anything until these land**

| # | Slice | Owner |
|---|---|---|
| 1 | [#209](./209-mobile-build-pipeline-device-install.md) — native build pipeline, device install, netinfo version | new |
| 2 | [#210](./210-dev-dataset-loginable-se-with-work.md) — a dev dataset an SE can log into and see work in | new |

**P1 — the app misreports its own state**

| # | Slice | Owner |
|---|---|---|
| 3 | [#186](./186-mobile-auth-shell-no-session-persistence.md) — wrap **every** authenticated call, not just `apiMe` | **existing, scope-completed in place** |
| 4 | [#201](./201-mobile-consumes-server-day-plan-signal.md) — read #161's `removedFromPlanAt`/`deferredToDate` | new · blocked by [#200](./200-decision-deferred-vs-removed-presentation.md) |
| 5 | [#202](./202-cross-surface-session-semantics.md) — cross-surface session revocation | new · blocked by [#199](./199-decision-one-active-device-cross-surface.md) |
| 6 | [#204](./204-time-semantics-day-boundary-implementation.md) — day boundary, cron TZ, leave windows | new · blocked by [#198](./198-decision-day-boundary-and-dispatch-clock.md) |

**P2 — a PRD-specified workflow is dead**

| # | Slice | Owner |
|---|---|---|
| 7 | [#203](./203-admin-media-display.md) — admin renders uploaded photos (voucher lightbox) | new |
| 8 | [#206](./206-admin-manager-action-surface.md) — Action Required + header badge; bind the intraday columns | new |

**P3 — correctness and cross-surface agreement**

| # | Slice | Owner |
|---|---|---|
| 9 | [#169](./169-se-api-contract-freeze.md) items 1-2 + [#174](./174-se-request-validation-dtos.md) — error shape, shared error union, param validation | **existing** |
| 10 | [#205](./205-contract-typing-shared-enums.md) — move the missing unions into `@fsm/shared`, make maps exhaustive | new |
| 11 | [#207](./207-admin-queue-filter-availability-completeness.md) — ticket filter, AVAILABLE setter, component statuses | new + in-place on #25/FE-15/#62 |
| 12 | [#208](./208-label-vocabulary-parity.md) — conform labels to the PRD's severity-name vocabulary | new |

**P4 — hygiene, but load-bearing for the next reader**

| # | Slice | Owner |
|---|---|---|
| 13 | [#211](./211-status-truth-doc-hygiene.md) — stale M-series statuses, `CLAUDE.md`, `SYSTEM-STATE` §1 | new |
| 14 | [#212](./212-admin-repoint-api-v1.md) — repoint admin, retire the unversioned alias | new · closes #169's last AC |

## Decision issues (block the slices above)

These need a human ruling before any code is correct. Options and consequences are laid out in each;
**none of them is decided here.**

- [**#198**](./198-decision-day-boundary-and-dispatch-clock.md) — is the operating day IST- or
  UTC-boundaried, and when should dispatch run? → blocks #204.
- [**#199**](./199-decision-one-active-device-cross-surface.md) — does one-active-device span
  surfaces, or bind only handsets? → blocks #202.
- [**#200**](./200-decision-deferred-vs-removed-presentation.md) — how is a *deferred* ticket shown
  to the SE versus a *removed* one, and does "for one session" survive a cold start? → blocks #201.

## In-place corrections made while filing this epic

Per the tracker's no-forks rule, findings that already had an owner were corrected on that issue
rather than given a new number. Every one of these was found by duplicate-checking a finding an
audit had marked "Issue: none".

| Issue | Correction |
|---|---|
| [#186](./186-mobile-auth-shell-no-session-persistence.md) | Its AC#2 already says "every authenticated call"; it shipped for `apiMe` only. Scope-completion recorded — this is audit-2 finding A1, the highest-severity item in either audit. |
| [#29](./29-intraday-critical-insertion.md) | AC#6 `[x] Intra-day Queue reflects PENDING_ACCEPTANCE / ACCEPTED / DECLINED` is **factually false** — zero `intraday-insertions` references exist in `apps/admin/src`. Un-ticked with a dated correction. |
| [#38](./38-expense-vouchers.md) | AC `[x] ZM review shows … photo lightbox` was true when written and was **silently broken by #81** changing `photoRef` to a media-object id. Recorded. |
| [#25](./25-se-management-availability.md) | Admin's settable-status list omits `AVAILABLE`, which the backend permits managers to set — so no manager can clear an SE's stuck window from the console. |
| [#58](./58-mobile-troubleshoot-form.md) | Photo AC's "blocked on #81 (unbuilt)" reason is stale — #81 is done. Corrected 2026-08-04 (before this epic). |
| [#66](./66-mobile-day-plan-same-day-update-cues.md) | Recorded that #161 subsequently shipped the server-side removal signal its "Option B (not adopted)" anticipated, and that the client diff's cold-start blind spot is a consequence. |
| [#85](./85-mobile-notifications.md) | Its "Admin: n/a (admin has its own notification surfaces)" line is an assumption that proved false — admin has no notification consumer at all. |
| FE-15 / [#62](./62-ticket-drawer-component-chain.md) | Component-request metric strip covers 3 of 5 statuses; #62 carries an unticked AC under a `done` status. |

## Dispositions — findings that are deliberately NOT slices

| Finding | Disposition |
|---|---|
| `device_tokens` migration unapplied | **Runbook line, not an issue.** One command (`pnpm prisma migrate deploy`), and it exists only until the next backend restart — an issue would outlive the problem. Recorded as step 1 of the readiness doc's "shortest real path". |
| Durable offline queue | **Existing owner [#17](./17-offline-queue-batched-sync.md)**, blocked on [#82](./82-offline-batch-sync-api.md). Confirmed a real bug against `CONTEXT.md:411` (SQLite persistence is mandated), not a gap. |
| Dev login credentials | **Existing owner [#194](./194-no-dev-login-seed-path.md)**. Note it *explicitly excludes* work data — hence #210. |
| Push / FCM / APNs / WhatsApp / SMS / SMTP | **External account provisioning** — [#89](./89-mobile-push-notifications.md), [#76](./76-notification-spine-adoption-external-adapters.md) remainder. Unchanged. |
| App-version floor, `X-App-Version` inert | **Existing owner [#170](./170-mobile-release-upgrade-mechanism.md)**. |
| `actionTakenCategory` enum | **Existing owners [#169](./169-se-api-contract-freeze.md) item 7 + [#174](./174-se-request-validation-dtos.md)**. |
| Ticket-UUID leak in notification bodies | **Existing owner [#76](./76-notification-spine-adoption-external-adapters.md)** — deliberately folded there 2026-07-28, still unfixed. |
| UNZONED's two definitions | **Existing owner [#192](./192-unzoned-two-definitions.md)**. |
| Notification outbox | **Existing owner [#189](./189-day-plan-notifier-no-outbox.md)**. |
| Unable-to-collect not surfaced on re-read | **Existing owner [#196](./196-recovery-unable-to-collect-not-surfaced-on-reread.md)**. |
| Mobile collapses 8 SLA colours to 2 | **Deliberate, close as won't-fix.** Documented at `ticketDisplay.ts:4-9`; a phone is not a dashboard. The *label* half is a real defect and is #208's. |
| Mobile renders `workState`, not `ticket.status` | **Deliberate, close as won't-fix.** #172 decision 3 ratified the `VISIT_NOW/PLAN/IN_WORK/VERIFY` vocabulary. |
| `/api` unversioned still served | **Not a bug.** Ratified as a time-boxed migration alias (`mobile-backend-freeze-plan-2026-07-28.md:165`, `169-…md:149-152`); retirement is #212. |
| `app.json` had no `android.package` | **Already fixed** — `app.json:16` is `in.autoplant.fsm`. Audit 1's premise was stale. |

## Coverage matrix

Every finding ID from both audits, plus findings made while verifying them. No ID is unmapped.

### Audit 1 — `mobile-device-readiness-2026-08-04.md`

| ID | Finding | Disposition |
|---|---|---|
| A-1 | No native build config (no `android/`, no `eas.json`) | #209 |
| A-2 | API URL is emulator-only; firewall/`adb reverse` | #209 |
| A-3 | Dev-DB migration lag | runbook (above) |
| A-4 | Credential/data mismatch | #194 (credentials) + #210 (work data) |
| B-1 | Home/Tickets empty — no schedule for a loginable SE | #210 |
| B-2 | Stock empty — `se_van_stock` zero fleet-wide | #210 |
| B-3 | Notifications empty | #210 (+ resolves as #76's adopted notifiers fire) |
| C-1 | No push | #89 (external) |
| C-2 | Troubleshoot photos unwired | #58 |
| C-3 | No durable offline | #17 / #82 |
| C-4 | One-active-device surprise logouts | #199 → #202 |
| C-5 | Release APK + cleartext `http://` | #209 |
| D | FCM/APNs, WhatsApp, SMS/SMTP | #89 / #76 (external) |
| — | `CLAUDE.md` "auth shell only" stale | #211 |

### Audit 2 — `mobile-contract-sync-audit-2026-08-04.md`

| ID | Finding | Disposition |
|---|---|---|
| A1 | No token refresh after mount → false "Offline" | **#186** (in place) |
| A2 | Guard 401/403 carry no `code` → `Error(undefined)` | #169 item 1 (server) + #186 (client) |
| A3 | Admin voucher photos render broken | #203 |
| A4 | Admin login kills mobile session | #199 → #202 |
| A5 | Migration lag + stale process | runbook |
| A6 | Dispatch cron TZ unpinned | #198 → #204 |
| B1 | `BigInt(id)` 500 on intraday routes | #174 (param validation) |
| B2 | `FAILED_ACTIVATION` missing from badge map | #205 |
| B3 | 15 notification types produced, 1 consumed, all `string` | #205 |
| B4 | `@Roles(...string[])` unchecked | #205 |
| B5 | Stale contract comments in `@fsm/shared` | #211 |
| B6 | Convention-only enum sync, no parity test | #205 |
| B7 | Admin date-render traps | #204 |
| B8 | Leave-window UTC-midnight shift | #198 → #204 |
| B9 | `TicketStatus`/`WorkType` absent from `@fsm/shared` | #205 |
| C1 | SLA labels: range vs severity; `null` bucket | #208 |
| C2 | UNZONED two populations | #192 |
| C3 | `SOFT_UNAVAILABLE` raw + red + uncounted on admin | #207 (setter) + #208 (label) |
| C4 | Root cause: three renderings | #208 |
| C5 | Voucher status tone/label divergence | #208 |
| C6 | Component/schedule label divergence | #208 |
| C7 | Three definitions of "today" | #198 → #204 |
| C8 | Admin ticket filter offers 8 of 17 statuses | #207 |
| D1 | Mobile ignores `removedFromPlanAt`/`deferredToDate` | #201 |
| D2 | `DAY_PLAN_REBALANCED` is a dead-end tap | #201 |
| D3 | Schedule closure has no mobile state | #201 |
| D4 | Intraday: 5 states, mobile 1, admin 0 | #206 |
| D5 | Admin consumes no notifications | #206 |
| D6 | Voucher decisions notify no one | #76 |
| D7 | Admin cannot set `AVAILABLE` | #207 (+ #25 in place) |
| D8 | `NonOpState` admin type lies (3 of 7) | #205 |
| D9 | WM queue can never show `RECEIVED`/`REJECTED` | #207 (+ FE-15/#62 in place) |
| D10 | `X-App-Version` inert | #170 |
| D11 | `actionTakenCategory` has no server vocabulary | #169 / #174 |
| D12 | Ticket UUID leak in SE_ACCEPTANCE body + offer screen | #76 |
| D13 | Troubleshoot `photoRefs` accepted, never sent | #58 |
| E | #169 scope: `/api/v1` dual-serve, admin unrepointed | #212 |
| F1 | Migration lag verdict | runbook |
| F2 | #58 corrected in place | done 2026-08-04 |
| F3 | #194 noted as owner | #194 |

### Found while verifying (neither audit caught these)

| ID | Finding | Disposition |
|---|---|---|
| N1 | "Pull to retry" copy with **zero** `RefreshControl` in the app | #186 |
| N2 | `@react-native-community/netinfo@12.0.1` vs SDK-expected `11.4.1` — a major-version mismatch on the module backing offline detection | #209 |
| N3 | No error boundary in mobile (or admin) — an unhandled render throw white-screens with no recovery | #209 |
| N4 | `SYSTEM-STATE:77-79` contradicts its own §4.4 — both say different things about mobile | #211 |
| N5 | #29's AC#6 is factually false | #206 (+ #29 in place) |
| N6 | #38's photo-lightbox AC silently broken by #81 | #203 (+ #38 in place) |
| N7 | M-series (#54-#60, #147) statuses stale — every AC ticked under `ready-for-agent` | #211 |

## Done when

- [ ] All P0-P2 slices closed, or explicitly deferred with a reason recorded here
- [ ] All three decision issues ruled on, and the slices they block unblocked
- [ ] An SE can install the build, log in, and complete one Troubleshoot and one Recovery ticket
      end-to-end on a real handset against a real backend, with no false "Offline" and no broken
      image in the ZM's review of the resulting voucher
