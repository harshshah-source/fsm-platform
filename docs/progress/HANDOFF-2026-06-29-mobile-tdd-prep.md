# HANDOFF — Mobile Specification Sprint (TDD Preparation) · 2026-06-29

**Mode:** documentation only. No backend/frontend code changed; no business logic changed; no
requirements invented. Every contract below is pinned to the verified backend on the integrated line
(`main`) or to PRD/CONTEXT, cited inline in each issue.

## What this sprint did

1. **Verified** the prior mobile rewrite (15 issues) against the live controllers/DTOs — all API
   contracts, validation codes, permissions, and ACs match `main`. No behaviour had been altered.
   Bonus confirmations during verification: the 409 payload is exactly
   `{code:'TICKET_ALREADY_CLOSED', winnerSeId, winnerAt, shadowUseRecorded}`; **SE self-serve is
   allowed** on leave (`@Roles('SERVICE_ENGINEER',…)`) and availability — closing the open RBAC question.
2. **Normalized** every mobile issue to the TDD standard (API contract / validation / permissions /
   navigation / offline / edge cases / tests / business-rule authority).
3. **Created 4 backend dependency issues** (#81–#84) for the genuine gaps — no longer hidden in mobile slices.
4. **Created 6 mobile issues** (#77, #85–#89) for previously unowned workflows.
5. **Superseded #52** (→ #55 + #60), retained for history; **re-scoped #53** under the push pipeline #89.
6. Updated `INDEX.md` (metadata only; no renumbering, no summary rewrites).

## Phase 6 — Dependency graph (rebuilt)

### Mobile → backend (every mobile issue points to an owned dependency)

| Mobile | Backend dependency | Status |
|---|---|---|
| 54 | 01 auth/shell | ✅ built |
| 55 | `/schedules/me` (11), `/me/van-stock` (21), `/me/shared-pool` (12), snapshot (04) | ✅ built |
| 56 | `/schedules/me` (11), `/me/shared-pool` (12), tickets (07) | ✅ built |
| 57 | `/tickets/:id` (07), `/tickets/:id/soft-state` (15), `/tickets/:id/verification` (18) | ✅ built |
| 58 | `/tickets/:id/troubleshoot` (16); **photo → #81** | ✅ + #81 |
| 59 | `/tickets/:id/verification` (18) | ✅ built |
| 60 | `/me/van-stock` (21), `/component-requests/:id/confirm-receipt` (22) | ✅ built |
| 61 | `/vouchers` (38); **photo → #81** | ✅ + #81 |
| 63 | troubleshoot 409 (24) | ✅ built |
| 64 | `/vehicle-unavailability` (28); **readiness chip → #65** | ✅ + #65 |
| 66 | `/schedules/me` (31/11) — client set-diff, no new backend | ✅ built |
| 68 | `/recovery/:id/*` (36) | ✅ built |
| 71 | `/install/:id/*` (34); **photo → #81**, activation push → #89/#76 | ✅ + #81 |
| 77 | `/intraday-insertions/:id/{accept,decline}` (29/30); push offer → #89/#76 | ✅ built |
| 85 | `/notifications` (03) | ✅ built |
| 86 | `/leave-requests` (26) | ✅ built |
| 87 | `/engineers/:seId/availability` (25) | ✅ built |
| 88 | `/me` (01); **Daily-Status source → needs-info** | 🟡 partial |
| 89 | adapters + device-token (**#76**), #77, #85 | ⏸ external |
| 17 | `POST /api/sync/batch` (**#82**) | 🔴 new backend |
| 20 | ticket-search (**#83**), Technical Hints (**#84**) | 🔴 new backend |

### Verification results

- **Every mobile issue points to a backend dependency** — yes.
- **Every backend dependency is owned by an issue** — yes: 81 (media), 82 (sync), 83 (search),
  84 (hints), 76 (adapters/token), 65 (readiness source). None unowned.
- **No hidden dependencies remain** — the previously-hidden gaps (media upload, sync, search, hints)
  are now explicit issues. Remaining non-built deps are all named and blocking-linked.
- **No orphan APIs** — every SE-facing endpoint now has a consuming mobile issue (notifications→85,
  leave→86, availability→87, confirm-receipt→60, intraday accept/decline→77).
- **No duplicated work** — #52 superseded; #53 re-scoped as a trigger of #89.
- **Open question (not a gap, flagged):** #88 Daily-Status metric set + source (`needs-info`) — must be
  confirmed, not invented, before that one section is built. Profile + Settings in #88 are ready.

## Phase 7 — Final audit

### Mobile issues (21 active; #52 superseded)

| Bucket | Count | Issues |
|---|---|---|
| 🟢 Fully TDD-ready now | 13 | 54, 55, 56, 57, 59, 60, 63, 66, 68, 77, 85, 86, 87 |
| 🟡 Core-ready, one leg deferred to a filed issue | 4 | 58 (photo→81), 61 (photo→81), 71 (photo→81/push→89), 64 (readiness chip→65) |
| 🔴 Blocked on new/external backend | 4 | 17 (→82), 20 (→83/84), 89 (→76 external), 88 (Daily-Status needs-info) |

### Backend dependencies

- **Existing & consumed (built on `main`):** schedules/me, me/van-stock, me/shared-pool, tickets +
  detail, verification, soft-state, troubleshoot (+409), vouchers, recovery, install,
  vehicle-unavailability, intraday-insertions (accept/decline), intraday-updates, notifications,
  leave-requests, engineers availability, component-requests confirm-receipt (~18 endpoint families).
- **Newly created (issues, unbuilt):** #81 Media Upload, #82 Offline Batch Sync, #83 Ticket Search,
  #84 Technical Hints.
- **Still missing / external:** #76 notification adapters + device-token (HITL); #65 readiness source
  (gates one chip only); #88 Daily-Status source (`needs-info`).

### Readiness estimate

| Metric | Before sprint | After sprint |
|---|---|---|
| Mobile specification completeness | ~70% | **~95%** (only #88 Daily-Status content open) |
| Mobile TDD readiness | ~55% | **~80%** (17/21 have a buildable path today) |
| Backend readiness for mobile | ~83% built | **~83% built · 100% owned** (gaps now have issues) |
| End-to-end readiness | partial | **~85% spec-ready**, gated on build order (54 → 81/82 → rest) |

### Verdict

> **Can the mobile application now be implemented issue-by-issue using `/tdd` without requiring
> developers or AI agents to invent business rules?**

**Yes — for the entire core SE field loop — provided the dependency build order is honoured.** Every
mobile screen's business rules are now sourced from PRD App Flows (§501–664) + CONTEXT, and every API
contract is pinned to a verified endpoint on `main`. The four backend holes that used to force
invention are now explicit issues (#81–#84) whose semantics come straight from the PRD. The only
remaining genuine unknown is the **#88 Daily-Status metric set**, which is correctly flagged
`needs-info` rather than guessed.

**Build order for an invention-free run:**
1. #54 Mobile Foundation (gates all M-series).
2. #81 Media Upload + #82 Offline Batch Sync (unblock photo legs + offline). #83/#84 unblock #20.
3. The 🟢 set (55, 56, 57, 59, 60, 63, 66, 68, 77, 85, 86, 87) — buildable in parallel after #54.
4. #76 (HITL/external) → #89 push + #53 trigger; #65 → #64 readiness chip.
5. Confirm #88 Daily-Status source, then finish #88.

No mobile issue now requires inventing business logic; the previously-hidden dependencies are owned,
named, and blocking-linked.

---

## Final backlog audit + certification (2026-06-29, commit `5881c4b`)

A final pass over all 21 active mobile issues + their 6 backend dependencies (65, 76, 81–84) along
four axes — hidden dependencies, contradictory ACs, duplicate issues, unresolved architectural
decisions. Findings were resolved in-place (no business logic changed):

| # | Finding | Axis | Resolution |
|---|---|---|---|
| 1 | 7 "to be filed" pointers in #17/#20/#58/#61/#71 — backend issues now exist | Hidden dep | Repointed to #81/#82/#83/#84 |
| 2 | #76 did not own the device push-token registration endpoint #89 consumes | Hidden dep | Added `POST /api/notifications/device-token` to #76 scope + AC |
| 3 | #61 offline-draft AC had no link to the queue | Hidden dep | #61 `blocked-by += #17` |
| 4 | #63 renders a 409 from the troubleshoot submit but did not depend on #58 | Ordering dep | #63 `blocked-by += #58` |

Post-fix verification: zero "to be filed" refs remain; all referenced issue files present; every
mobile issue has both an `## API contract` and a `## Tests` section.

**Axis results**
- **Hidden dependencies:** none remain — every consumed endpoint is built or owned by a named issue.
- **Contradictory ACs:** none. #55 kit-badge vs #60 kit-list = complementary surfaces; #77
  CRITICAL-insertion vs #66 ZM-same-day = explicitly distinct; component loop 58/60/89 = non-overlapping
  steps of PRD Flow 3.
- **Duplicate issues:** none. #52 superseded → #55 + #60 (history preserved); #53 re-scoped under #89.
- **Unresolved architectural decisions:** one — #88 Daily-Status data source — explicitly flagged
  `needs-info` and quarantined to a single AC (Profile + Settings ship without it). #81 presign-vs-direct
  is a recorded, non-blocking decision (the `photoRef` contract is stable either way).

### Certification

> **The FSM mobile backlog is certified TDD-ready**, with one explicitly-quarantined exception
> (#88 Daily-Status content, `needs-info`).
>
> Every mobile issue carries business-rule authority (PRD flow cited), an API contract pinned to a
> verified endpoint on the integrated line, validation/error codes, permissions, navigation, offline
> behaviour, edge cases, and red-first test targets. Every backend gap is an owned issue (#81–84, 76,
> 65) — none hidden. No contradictions, no duplicates.
>
> An engineer or AI agent can implement the SE app issue-by-issue with `/tdd` **without inventing
> business rules**, provided the build order above holds: #54 → #81/#82 (+#83/#84 for QR) → the 13
> green issues → #76-gated push → confirm #88's one open question.

Session commits (backlog-scoped): `e0ba9c0` (normalize mobile issues) · `5881c4b` (resolve dangling
refs + dependency links). This handoff lives under `docs/` and is local-only by repo convention
(`.gitignore` versions only `docs/agents/` + `.scratch/fsm-platform-v1/`).
