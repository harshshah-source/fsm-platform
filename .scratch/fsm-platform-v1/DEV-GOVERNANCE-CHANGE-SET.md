# FSM Platform — Development Governance Change Set

> Planning artifact. **No implementation, no code, no doc edits applied here.** This is the actionable
> change set itself. Synthesised from `DOC-RECONCILIATION-GOVERNANCE-REVIEW.md`, `UI-OWNERSHIP-PLAN.md`,
> `UI-RECOVERY-PLAN.md`, CONTEXT.md, CLAUDE.md, PRD, workflow docs, ADRs, issue files, progress docs,
> and the desktop/mobile reference screenshots. **No new audit was performed.**
>
> **Objective (unchanged):** keep backend-led TDD. The change set only ensures completed capabilities
> get surfaced, screenshots are used, every user-facing capability has UI ownership, and no future
> issue can silently defer UI visibility. **This is not a switch to UI-first.**

Legend: ✅ complete · 🟡 partial · ❌ missing · n/a not applicable. Class: **A** complete · **B** needs
UI retrofit (screen exists) · **C** needs new UI follow-up (screen absent).

---

# Part 1 — Existing Features (Issues 01–21)

| Issue | Backend capability delivered | Current UI status | Required UI work | Reference screenshot(s) | Owner issue | Class |
|---|---|---|---|---|---|---|
| **01** Foundation/infra | auth, RBAC, Prisma, settings, app shells | Admin ✅ `LoginPage`/`AdminShell`/`AuthProvider`; Mobile 🟡 auth shell only | Admin: none. Mobile: the **shell itself** (bottom-tabs Home/Tickets/Stock/Vouchers/Profile, component kit, offline-aware client) | `desktop/v2-reference/00-login`; all `mobile/*` | Admin **01 (done)**; Mobile → **new Mobile Foundation issue** | A (admin) / **C** (mobile) |
| **02** Org/reference config + Settings | zones/plants/users/companies/engineers/coverage/SLA/scoring/kit/geo CRUD | 🟡 `SettingsPage`+sections, `TerritoryPage` | Plants CRUD page; Company-update page; full user-mgmt UI; surface code-constant settings (geofence radius, PGI window, stuck-snapshot threshold) | `v2-reference/26-settings` | Retrofit `SettingsPage` (**02**) + **45** Plants, **46** Company, **49** deal_type | **B** + **C** |
| **03** Notifications & audit spine | ❌ not built (HITL, ready-for-human) | ❌ | none yet — **no backend to surface** | (none) | **03** (when built) | n/a |
| **04** Snapshot + data-as-of | ✅ ingestion + as-of | Admin ✅ `SnapshotBanner`; Mobile ❌ | Mobile: online / last-sync pill on Home | `mobile/home-dashboard.png.png` | Admin **04 (done)**; Mobile → **M1 Home** | A (admin) / **C** (mobile) |
| **05** Device state + ticket creation | ✅ inactivity + SLA bucket + auto-create | ✅ via `TicketsPage`/`DashboardHome` | none (system pipeline; no dedicated surface) | — | **05 (done)** | **A** |
| **06** Zone Dashboard Home | ✅ aggregations + role access | 🟡 cards stubbed, no KPI strip, no role variants | Wire 8 live Action-Required cards; KPI metric strip (uptime % + counts); role-variant dashboards | `v2-reference/01` (+`02/03/04/05`) | Retrofit **06**; variants → **27** + new variant issue | **B** (+ **C** for variants) |
| **07** Ticket List & Detail | ✅ list + detail + 6-tab drawer | Admin 🟡 4 of 6 drawer tabs stub; Mobile ❌ | Admin: fill Forms/Components/Assignment-History tabs, inline badge columns. Mobile: list + detail | `v2-reference/07,08,28`; `mobile/tickets-priority-view`, `ticket-detail-ready` | Admin retrofit **07**; Mobile → **M2/M3** | **B** (admin) / **C** (mobile) |
| **08** Auto-recovery + repeat | ✅ detection + badges + `markAutoRecovery` | 🟡 badges render; manual-close has no button | Manual "mark auto-recovery (pre-submission)" control | `v2-reference/08` | Retrofit **08** (or fold into drawer retrofit) | **B** |
| **09** Coverage/territory + MVs | ✅ hierarchical polygon + MV refresh | 🟡 `TerritoryPage` polygon editor disabled | Polygon map-drawing editor | (org-config; no dedicated v2 screen) | **New spatial-editor issue** → 09 | **C** |
| **10** Recommender scoring | ✅ scoring + hard filters + canonical sort | 🟡 reasoning shown; no gate-skip view | Company-Tier gate-skip / starve-depth panel | `v2-reference/01` (gate area) | **New dashboard-panel issue** → 10 | **C** (low priority) |
| **11** Batch dispatch → Day Plan | ✅ auto-dispatch + Day Plan API | Admin 🟡 no KPI strip / card badges / pickup stop; Mobile ❌ | Admin: KPI strip, per-ticket card badges, pickup stop. Mobile: Day Plan home | `v2-reference/12`; `mobile/home-dashboard` | Admin retrofit **11**; Mobile → **M1/M2** | **B** (admin) / **C** (mobile) |
| **12** SE Shared Pool | ✅ shared-pool API | Mobile ❌ (no admin surface needed) | Mobile: Pool entry + list (separate from Assigned) | `mobile/home-dashboard` ("Open Ticket Pool") | Mobile → **M2** | **C** |
| **13a/b** ZM Monitoring & Override | ✅ engine + API + admin UI | 🟡 near-complete | KPI strip; drag-reorder (position-based); reason-code vocab (domain decision first) | `v2-reference/12` | Retrofit **13** (polish) | **B** |
| **14a/b** SE Planner | ✅ CRUD + recommender bias + grid UI | 🟡 minor gaps | Date-range/cadence picker; engineer display names; real drag | `v2-reference/16` | Retrofit **14** (minor) | **B** |
| **15** Soft states + activity ping | ✅ soft-state machine + derived Activity Status | Admin ❌ no SE-activity board; Mobile ❌ no soft-state actions | Admin: SE Activity board. Mobile: VIEWED/ON_SITE/Start + geofence prompt | `v2-reference/15-se-activity`; `mobile/ticket-detail-ready` | Admin → **25**; Mobile → **M3** | **C** (both) |
| **16** Troubleshoot form | ✅ form + structured root cause + idempotency | Admin 🟡 Forms tab stub; Mobile ❌ | Admin: submitted-form view. Mobile: full form | `mobile/troubleshooting.png.png`; `v2-reference/08` Forms tab | Admin retrofit **07/16**; Mobile → **M4** | **B** (admin) / **C** (mobile) |
| **17** Offline queue | ❌ not built | n/a / Mobile ❌ | none yet — **no backend to surface** (build-from-scratch, owned by 17) | `mobile/*` offline states | **17** (exists) | n/a |
| **18** GPS three-phase verification | ✅ three-phase + outcome | Admin ✅ (via 19); Mobile ❌ | Mobile: verification view + PARTIAL_RECOVERY badge + CTA | `v2-reference/14`; `mobile/verification.png.png`, `ticket-detail-verification-pending` | Admin **19 (done)**; Mobile → **M5** | A (admin) / **C** (mobile) |
| **19** Verification Review page | ✅ review + fraud flag | ✅ `VerificationReviewPage` | none | `v2-reference/14` | **19 (done)** | **A** |
| **20** QR + Technical Hints | ❌ not built | n/a / Mobile ❌ | none yet — **no backend to surface** (build-from-scratch, owned by 20) | `mobile/*` | **20** (exists) | n/a |
| **21** Van Stock + Component-Blocked | ✅ van stock + Common-Kit hard filter + Component-Blocked queue | Admin 🟡 page done, no AR cross-link / real WM status; Mobile ❌ | Admin: Action-Required cross-link, real WM status. Mobile: Stock screen + Home kit badge | `v2-reference/17`; `mobile/inventory.png.png`, `home` kit badge | Admin **53** (cross-link) + 22/23 (WM status); Mobile **52** (kit badge) + **M6** (stock) | **B** (admin) / **C** (mobile) |

### Part 1 roll-up

- **Class A (complete, no UI work):** 05, 19; **admin-complete-for-scope:** 01 (admin), 04 (admin banner), 18 (admin).
- **Class B (needs UI retrofit — screen exists):** 02 (Settings), 06, 07 (admin), 08, 11 (admin), 13, 14, 16 (admin), 21 (admin).
- **Class C (needs new UI follow-up — screen absent):** 01 (Mobile Foundation), 04/07/11/12/15/16/18/21 (mobile, M-series), 09 (spatial editor), 10 (gate-skip panel), 15 (admin SE Activity → 25), 06 (role-variant dashboards → 27/new), 02 (45/46/49).
- **Excluded (no backend to surface):** 03, 17, 20.
- **Single biggest ownership hole:** there is **no Mobile Foundation issue** and the mobile halves of 04/07/11/12/15/16/18/21 are only **partially** owned in `INDEX.md` (52/53 cover Issue 21 only). See Part 3.

---

# Part 2 — Required Document Changes

Each entry gives **exact location → exact text → reason.** Apply in the Part 5 order.

## 2.1 CLAUDE.md

**Location:** new top-level section appended after the existing `### Workflow` block (end of "## Agent skills").

**Add:**

```markdown
## Surfacing rule (UI parity)

Backend and UI are **one vertical slice**, not two phases. An issue with UI/mobile acceptance criteria
is **not done** until those criteria are met *or* an explicit follow-up issue owns them (filed in
`.scratch/fsm-platform-v1/INDEX.md`). "Build the seam" applies to **external integrations**
(FCM/APNs/WhatsApp/SAP/AutoPlant) — **not** to admin pages or mobile screens that consume endpoints
already implemented in this repo.

**Before executing any issue that touches a dashboard, page, screen, form, table, drawer, queue,
report, or navigation:** read the authoritative reference image(s) under
`docs/ui/desktop/v2-reference/` (desktop) or `docs/ui/mobile/` (mobile — note the `.png.png`
extension) and follow the UI-discovery steps in `docs/agents/workflow.md`. Match layout, hierarchy,
role visibility, and navigation; do not redesign.

**Parity gate (hard stop before "done"):** an issue may not be marked done while leaving in-scope
UI/mobile ACs unbuilt unless (a) a follow-up issue is filed and linked in INDEX.md, **and** (b) the
deferral reason is an external-integration blocker — *not* "no app shell yet." A missing app shell is
a backlog gap to escalate (Strategic HITL: backlog-ownership), not a reason to defer silently.
```

**Reason:** CLAUDE.md is the first (often only) doc a fresh agent reads. It names the v2 reference dirs
but imposes **no parity gate** and does not counter the AFK "build the seam" instinct that is being
over-applied to defer UI. This is the highest-leverage single edit (Governance Review §3, §7).

## 2.2 CONTEXT.md

Five domain reconciliations only — UI/design-system rules deliberately stay **out** of CONTEXT
(UI authority is delegated to domain.md + workflow.md; adding UI rules here would create a second
source of UI truth). Governance Review §2.

**(a) §Override** — append:
> *Override reason is captured as mandatory free-text in v1 (no controlled vocabulary). A coded
> `override_reason_code` enum is deferred to the reporting phase; until then "reason-coded" means
> "reason-required," not "enumerated."*

**(b) §Soft State** — append:
> *Advancing a soft state (VIEWED → ON_SITE → TROUBLESHOOT_STARTED) resolves the SE's prior active
> state on that ticket (`resolved_by = SE`, `reason = ADVANCED`), so one SE holds at most one active
> state per ticket. An additional resolution event, not a conflict.*

**(c) §Soft State / ON_SITE** — append:
> *AUTO_GEOFENCE is satisfied when the captured point is within a default 200 m radius
> (`DEFAULT_GEOFENCE_RADIUS_M`) of the plant point; promote to a Settings value when per-deploy
> tuning is needed.*

**(d) §9 (verification anchor)** — append:
> *v1 anchors Phase-1 on the SE form-GPS / ON_SITE capture only; the "or inside Plant geofence"
> corroboration is deferred (plant.location + ST_DWithin).*

**(e) §SE Planner** — append:
> *In v1 the bias is a binary preference (prefer the planner-named SE among hard-filter-passed
> candidates), not a weighted score term; a weighted `planner_affinity_weight` is deferred until SE
> selection becomes score-ranked.*

**Reason:** these six decisions (13b/14a/15/18) live only in progress docs; they must be in the
top-authority doc before Issues 22/25/28 touch the same areas. Also add a single one-line pointer in
CONTEXT that "UI parity is governed by `docs/agents/workflow.md`" (do **not** import UI rules).

## 2.3 docs/agents/workflow.md

**Location 1 — "## Strategic HITL policy", the "Continue autonomously" / "Build the seam" paragraph (lines ~20–22).**

**Change:** after "Build the seam: interfaces, adapters, mocks, placeholders, and TODO integration
points." insert:
> **Scope of "build the seam":** it covers *unavailable external infrastructure only* (Redis, SMTP,
> FCM, APNs, WhatsApp, SAP, AutoPlant). It does **not** cover an admin page or mobile screen whose
> backend endpoint already exists in this repo — those are buildable surfaces, and deferring them
> requires a tracked follow-up issue (see Parity gate below), not a seam.

**Location 2 — "## UI reference system", append a new subsection after "### UI regression".**

**Add:**
```markdown
### Parity gate (per-issue, not a phase switch)

An issue carrying in-scope UI or mobile acceptance criteria cannot be marked done with those ACs
deferred unless **both**: (a) a follow-up issue owning them is filed and linked in INDEX.md, and
(b) the blocker is a true external integration. "No app shell yet" is not a valid deferral reason —
it is a backlog-ownership Strategic HITL event. Record the disposition in the issue's progress doc.
```

**Reason:** the "build the seam" rule's ambiguity is what is being used to justify backend-first UI
deferral. This draws the line explicitly and co-locates the enforceable gate with the UI rules that
already exist but aren't enforced (Governance Review §1, §7).

## 2.4 Issue template / canonical issue file structure

There is no separate template file — the structure is implicit in `issues/<NN>-*.md`
(`# title` → `Status` → `Type` → `## What to build` → `## Acceptance criteria` → `## Blocked by`).
Codify the canonical structure in **`docs/agents/issue-tracker.md`**.

**Location:** new "## Issue file structure" section after "## Conventions".

**Add:**
```markdown
## Issue file structure

Every issue file uses this skeleton:

    # NN — <title>
    Status: <triage-label>
    Type: <AFK|HITL>

    ## What to build
    ## Acceptance criteria
    ## UI surfaces            ← required if the issue touches any user-facing surface; else "n/a"
    ## Reference              ← required for any issue with UI surfaces; lists the exact image path(s)
    ## Blocked by

**`## UI surfaces`** names each Admin and Mobile surface the issue creates or modifies, e.g.
`Admin: SE Activity board (new)`, `Mobile: n/a`. If a surface is deferred, it must name the
follow-up issue that owns it.

**`## Reference`** lists the authoritative image(s) by on-disk name, e.g.
`Reference: docs/ui/desktop/v2-reference/18-component-requests.png` (mobile: `.png.png`). "n/a"
only if the issue is backend/test-only with no user-facing surface.

Acceptance criteria for any UI surface must be phrased against its reference image (layout,
hierarchy, role visibility) and are subject to the Parity gate in `docs/agents/workflow.md`.
```

**Reason:** the screenshot is mandated by workflow.md but issue *files* never name the specific image,
and no field forces a UI surface to declare an owner. Adding the two fields makes the screenshot an
enforceable AC input and makes silent mobile deferral structurally visible (Governance Review §5, §6).

## 2.5 ADRs

ADR **bodies** are not edited (domain.md declares them non-authoritative/historical). Two index +
authoring fixes:

**(a) `docs/adr/README.md`** — regenerate the index to:
- add **0024** (Action-triggered heartbeat — Status: *Superseded*, HEARTBEAT_STALE removed 2026-06-22)
  and **0025** (Foundation skeleton infra) which exist on disk but are missing;
- add a **Status column** flagging Superseded/Amended (0002, 0003, 0007, 0011, 0019, 0020, 0024);
- fix stale titles still showing pre-supersession language.

**Reason:** bodies carry correct supersession banners but the index misleads (Governance Review §4).

**(b) Author the two ADRs missing from Issues 13–21** (decisions currently only in progress docs):
- **ADR-0026 — Soft-state resolution & geofence presence model** (supersede-on-advance,
  `DEFAULT_GEOFENCE_RADIUS_M = 200`, Phase-1 anchor = form-GPS/ON_SITE only). Cross-refs CONTEXT (b)(c)(d).
- **ADR-0027 — Override reason is free-text in v1** (no coded vocabulary). Cross-refs CONTEXT (a).

**Reason:** governance completeness; these are the only decisions from 13–21 with no ADR.

**(c) Lower-urgency hygiene (defer-able):** add supersession banners (no rewrite) to
`docs/PRD-fsm-admin-dashboard.md` and `docs/workflow/fsm-business-technical-workflow.md`; add a
"deferred tables / dangling FKs" note to `docs/backend/fsm-db-schema-table-wise.md`.

---

# Part 3 — Backlog Changes

## 3.1 Issues that need updating (status / content)

| Issue / file | Change | Reason |
|---|---|---|
| **INDEX.md 18, 19** | Already shown `*(done)*` — confirm progress docs flipped from `ready-for-agent` to done | Status drift noted in Governance Review §1; verify it's reconciled |
| **INDEX.md** | Link `UI-RECOVERY-PLAN.md`, `UI-OWNERSHIP-PLAN.md`, and this change set from the header | Recovery roadmap currently unlinked from "live truth" |
| **Issue 22 file** | Add `## Reference: docs/ui/desktop/v2-reference/18-component-requests.png` and a `## UI surfaces` block (Admin: component-requests queue + drawer Components tab; Mobile: resubmit/receipt → **blocked-by Mobile Foundation**) | First issue after the gate; must model the new template |
| **Issues 23–44** | Add `## Reference` (per Part 4 map) + `## UI surfaces` retroactively, batched | Make the screenshot an enforceable AC input for all screen-touching issues |
| **Issue 21 progress doc** | Already records AC#5/#6 deferral → confirm follow-ups 52/53 + 51 are linked as owners | Closes the "silent defer" pattern that triggered this review |

## 3.2 Issues that need splitting

| Issue | Split into | Reason |
|---|---|---|
| **39–44 Reports** | `Na` backend MV + `Nb` report UI (mirror 13a/b, 14a/b) | Each bundles heavy chart-UI with backend MV work; splitting lets backend land under TDD while the UI follow-up carries the v2 reference and parity gate |
| **30 Intra-day timeout/retry** | Keep backend in 30; **merge its UI into 29's intra-day queue** | 30 is backend-heavy; its only surface is the same queue 29 builds |
| **22–37** | **Do NOT split** | Already vertical tracer-bullets; enforce the parity gate instead of splitting |

## 3.3 Missing UI follow-up issues to file

**Mobile (the structural hole — none of these exist except 52/53, which cover Issue 21 only):**

| New issue | Owns | Parent (done backend) | Reference |
|---|---|---|---|
| **Mobile Foundation** (file first; blocks all M-series) | RN shell, bottom-tabs Home/Tickets/Stock/Vouchers/Profile, component kit, offline-aware client | 01 | all `mobile/*` |
| **M1 Home** | last-sync · Day Plan/Next Visit/Plant Workload · kit badge · Open Ticket Pool | 04/11/21/12 | `home-dashboard.png.png` |
| **M2 Tickets / Day-Plan / Pool** | list + day-plan + shared-pool entry | 07/11/12 | `tickets-priority-view` |
| **M3 Ticket Detail (ready + verification-pending) + soft-state actions** | detail + VIEWED/ON_SITE/Start + geofence prompt | 07/15/18 | `ticket-detail-ready`, `ticket-detail-verification-pending` |
| **M4 Troubleshoot form** | full mobile form | 16 | `troubleshooting.png.png` |
| **M5 Verification** | verification view + PARTIAL_RECOVERY badge + CTA | 18 | `verification.png.png` |
| **M6 Stock/Inventory** | van-stock screen | 21 (+22) | `inventory.png.png` |
| **M7 Vouchers** | voucher capture | 38 | `vouchers.png.png` |

*(M8 daily-status/Profile and Issue 20 QR are the deferred 20% — file but sequence last.)*

**Admin (net-new screens; some already planned):**

| New / planned issue | Owns | Status |
|---|---|---|
| **Admin-retrofit issue** (cross-cutting) | drawer tabs (A1), tickets badges (A2), dashboard cards + KPI strip (A3), schedule/planner polish (A4/A5), nav cleanup (A9) | **File new** — small, highest visibility-per-effort |
| **Spatial-editor issue** → 09 | polygon map-drawing editor | **File new** |
| **Dashboard gate-skip panel** → 10 | Company-Tier gate-skip / starve-depth panel | **File new** (low priority) |
| **Role-variant dashboards** → 27 + new | CSM-acting / Ops-Head / Warehouse dashboard variants | 27 (acting) + **file new** for variants |
| **25** SE Activity board | admin SE Activity surface (Issue 15 backend) | Already planned — **do not defer its UI** |
| **45 / 46 / 49** | Plants / Company-update / deal_type settings | Already filed |

## 3.4 Mobile ownership gaps (summary)

Before this change set, **every mobile half of 04/07/11/12/15/16/18/21 was orphaned** except Issue 21
(52/53). Filing **Mobile Foundation + M1–M7** converts all mobile `❌` from orphaned to tracked, and
makes every future issue's mobile AC `blocked-by Mobile Foundation` rather than silently deferred.

---

# Part 4 — Future Development Rules (Issues 22+)

1. **Screenshot usage.** Any issue touching a dashboard/page/screen/form/table/drawer/queue/report/nav
   must carry a `## Reference` line naming the exact on-disk image (desktop `v2-reference/`, mobile
   `.png.png`). Run the workflow.md UI-discovery steps before writing the first test. No reference =
   the issue is not ready-for-agent.

   | Reference image | AC for issue |
   |---|---|
   | `v2-reference/18-component-requests.png` | 22, 23 |
   | `v2-reference/19-shadow-use-queue.png` | 24 |
   | `v2-reference/15-se-activity.png` | 25 |
   | `v2-reference/10-readiness.png`, `11-vehicle-unavailability.png` | 28 |
   | `v2-reference/13-intraday-queue.png` | 29, 30 |
   | `v2-reference/02/03-dashboard-csm/central.png` | 27 |
   | `v2-reference/17`, `20-warehouse-stock`, `05-dashboard-warehouse` | 21 follow-ups |
   | `v2-reference/21–25` (reports) | 39–43, 44 |
   | `mobile/*` | Mobile Foundation + M-series |

2. **UI ownership.** Every user-facing capability has exactly one owning issue per surface (Admin and
   Mobile counted separately). A capability with no UI owner on a surface is a **backlog gap** (file an
   issue), never an implicit "later."

3. **Acceptance criteria.** UI ACs are phrased against the reference image (layout, hierarchy, role
   visibility, navigation) — not as free prose. Backend ACs stay test-first under `/tdd`. A UI surface
   without a reference-anchored AC cannot be accepted.

4. **Admin surface ownership.** The originating backend issue owns its admin surface by default. Only
   move it to a follow-up when (a) the follow-up is filed/linked and (b) the blocker is a real external
   integration. Cross-cutting admin polish lives in the standing admin-retrofit issue.

5. **Mobile surface ownership.** Every mobile AC is `blocked-by Mobile Foundation` until that issue
   lands. After it lands, mobile surfaces are owned by the relevant M-series issue, parented to the done
   backend issue. No issue may close a mobile AC by pointing at "no app shell."

6. **Follow-up issue requirements.** A deferred UI/mobile AC must spawn a follow-up at the next free
   `NN`, added to INDEX.md Follow-ups with a parent pointer + reason (existing 45/51/52/53 pattern), and
   recorded in the parent's progress doc as accepted-with-follow-up. Deferral without a filed follow-up
   is prohibited (Parity gate).

7. **Navigation ownership.** Admin nav (`AdminShell.tsx`) and mobile bottom-tab nav are owned
   surfaces: an issue that adds a screen must register/enable its nav entry, and must not leave dead
   labels. Nav integrity (remove/disable dead labels, role-grouped nav) is owned by the admin-retrofit
   issue (A9) and the Mobile Foundation issue.

---

# Part 5 — Execution Plan (smallest set of edits before Issue 22 begins)

Ordered by priority. **No code; document + backlog edits only.**

## 1. Must do now (before Issue 22 starts)

| # | Action | Where | Why |
|---|---|---|---|
| 1 | Add **Surfacing rule + parity gate + mandatory screenshot read** | CLAUDE.md (Part 2.1) | First doc every agent reads; it's what's letting UI be deferred. Cheap, immediate, highest leverage |
| 2 | **File Mobile Foundation issue + M1–M7**; link UI-RECOVERY/OWNERSHIP plans + this change set; confirm 18/19 done | INDEX.md + new issue files (Part 3.3) | Backlog is "live truth"; without mobile issues the parity gate has nowhere to send deferred work — unblocks every 22–38 mobile AC |
| 3 | Distinguish "defer external integration (OK)" from "defer implemented-backend UI (NOT OK)" + add Parity-gate clause | workflow.md (Part 2.3) | Removes the rule ambiguity that justified backend-first deferral |
| 4 | Add `## UI surfaces` + `## Reference` to the canonical issue structure; **apply both to Issue 22 now** | issue-tracker.md (Part 2.4) + Issue 22 file | Issue 22 is next; it must be the first to model the gated template |

## 2. Should do soon (within Issues 22–25 window)

| # | Action | Where | Why |
|---|---|---|---|
| 5 | Add the 5 domain reconciliations (override free-text, soft-state supersede, geofence radius, verification fallback, planner binary bias) | CONTEXT.md (Part 2.2) | Must precede issues touching those areas (25, 28); closes the only real domain drift from 13–21 |
| 6 | File the **admin-retrofit issue** (A1–A9) + back-fill `## Reference`/`## UI surfaces` on Issues 23–28 | INDEX.md + issue files (Part 3) | Surfaces completed 06/07/08/11/13/14/21 backend at S/M effort; makes screenshots enforceable for the active window |
| 7 | Regenerate ADR README (add 0024/0025, Status column, fix titles) | docs/adr/README.md (Part 2.5a) | Prevents agents being misled by the stale index |
| 8 | Split **39–44** into Na/Nb; merge 30 UI into 29 | INDEX.md (Part 3.2) | Lets report backend land under TDD while UI follow-ups carry the gate |

## 3. Can defer

| # | Action | Where |
|---|---|---|
| 9 | Author ADR-0026 (soft-state/geofence) + ADR-0027 (override free-text) | docs/adr/ (Part 2.5b) |
| 10 | Supersession banners on PRD + workflow doc; "deferred tables/FKs" note on table-wise schema | docs/ (Part 2.5c) |
| 11 | File spatial-editor (09), gate-skip panel (10), role-variant dashboards (27+) | INDEX.md (Part 3.3) |
| 12 | File M8 daily-status/Profile; sequence Issue 20 QR last | INDEX.md |

---

**Bottom line:** the rules to do this right already exist in `workflow.md`/`domain.md`. The change set
(1) makes them an **enforced per-issue parity gate via CLAUDE.md**, (2) gives the orphaned mobile/UI
work **tracked owners in INDEX.md** (Mobile Foundation + M-series + admin-retrofit), and (3) **binds
every screen-issue to its v2 reference image** via two new issue-file fields — then lets the existing
backend-led TDD cadence continue, surfacing each implemented slice as it lands. Items #1–#4 are the
minimum before Issue 22.
