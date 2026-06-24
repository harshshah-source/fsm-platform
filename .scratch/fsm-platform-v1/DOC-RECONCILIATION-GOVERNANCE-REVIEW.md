# FSM Platform — Documentation Reconciliation & Governance Review

> Governance/reconciliation review performed before continuing development (at Issue 21).
> **Analysis only — no code, no file modifications other than this report.**
> Authority order: CONTEXT.md → ADRs → PRD → workflow → backend design → issues → progress → codebase.

## Two findings that reframe this review

1. **UI-first governance already exists but isn't enforced.** `docs/agents/workflow.md` has a full "UI reference system" (mandatory UI-discovery steps, "do not redesign", `.png.png` robustness) and `docs/agents/domain.md` already places UI references in the authority chain (`CONTEXT → PRD → workflow → UI images → code → ADRs`). The problem is not missing rules — it's that **issues are being closed with their UI/mobile ACs deferred** (e.g. Issue 21, updated 2026-06-24, marks AC#5 mobile and AC#6 push as `[~]`/`[ ]`).
2. **ADR bodies are well-maintained (0007/0019/0020 carry proper "Superseded" banners), but the ADR README index is stale** (lists only 0001–0023; 0024/0025 exist on disk; titles show pre-supersession language), and **no ADRs were written for the decisions made during Issues 13–21**.

---

# 1. Documentation Gap Report

| Document | Current purpose | Outdated? | Conflicts w/ implementation? | Conflicts w/ UI refs? | Recommended changes |
|---|---|---|---|---|---|
| **CONTEXT.md** | Highest-authority domain model + Decisions §1–18 | Mostly current | **Minor** — 6 decisions from Issues 13–21 live only in progress docs, not here (see §2) | No (UI authority delegated to domain.md) | Add the 6 missing decisions; add a one-line pointer that UI parity is governed by workflow.md (don't import UI rules into CONTEXT) |
| **CLAUDE.md** | Project orientation + skill pointers | **Yes, thin** | No | **Yes — silent gap**: names the v2 reference dirs but states no parity *gate* | Add an explicit "surface-before-advance" rule + parity-gate pointer (see §3) |
| **docs/agents/workflow.md** | Owns HITL, TDD report, UI reference rules | Largely current & strong | **Partial** — the "build the seam / unavailable infra" AFK rule is being mis-applied to defer *UI* (a buildable surface) | Aligned in intent | Tighten: distinguish "defer external integration (OK)" from "defer the UI surface of an implemented backend (NOT OK once the app shell exists)"; add a parity-gate clause |
| **docs/agents/domain.md** | Owns authority hierarchy incl. UI | Current | No | No | No change — already ranks UI refs above code |
| **docs/adr/README.md** | ADR index | **Yes — stale** | Omits 0024, 0025; titles show superseded language (0002 "Daily", 0003 "Customer-Tier", 0007 "One-Click Approval", 0011 "Ops-Head Only", 0019, 0020) | n/a | Regenerate index to include 0024/0025; add a Status column flagging Superseded/Amended |
| **docs/adr/0001–0025** | Historical decisions | 0007/0011/0019/0020/0024 superseded (bodies banner this); others valid | No (domain.md declares them non-authoritative) | n/a | No new edits to bodies; **create ADRs for the 13–21 decisions** (see §4) |
| **docs/PRD-fsm-admin-dashboard.md** | Product requirements (authority #3) | **Heavily superseded** — CONTEXT "Flagged ambiguities" enumerates ~25 deviations (Admin persona, Customer→Company, REVIEW_PENDING, ±500m, SE Confirmation, AGED_CRITICAL…) | Yes, broadly — hierarchy resolves it (CONTEXT wins) | **Likely yes** — predates the v2 screenshots | Do not rewrite. Add a top banner: "Superseded where it conflicts with CONTEXT.md; see CONTEXT *Flagged ambiguities*. UI screens governed by docs/ui/ v2-reference." |
| **docs/workflow/fsm-business-technical-workflow.md** | End-to-end workflow (authority #4) | Partially superseded (approval gate, REVIEW_PENDING) | Some | Possibly | Add the same supersession banner; no full rewrite |
| **docs/backend/* (LLD, schema-blueprint, table-wise)** | Backend design (authority #5) | Largely accurate — progress docs build from LLD §13.1/§3.6 | **Localized** — schema defers FKs the table-wise doc may assume present (transporters, component_master, users FKs); recommendation_history / role_unavailability / cross_zone_escalation not yet built | n/a | Add a "Deferred vs designed" note to the table-wise doc (evidence: schema.prisma lines 526, 604, 871) |
| **docs/progress/*** | Per-issue build records | Current & excellent | They *are* the record of conflicts | n/a | (a) flip 18/19 from `ready-for-agent` to done; (b) promote recurring "RN screen deferred" notes into tracked issues |
| **.scratch/.../INDEX.md** | Live backlog truth | **Yes** — 18/19 status drift; no Mobile-shell or M-series issues; UI Recovery Plan not linked | n/a | Flip 18/19; add Mobile-shell + M-series follow-ups; link UI-RECOVERY-PLAN.md |
| **.scratch/.../issues/*** | Issue specs | Mostly current | **Pattern conflict** — issues bundle UI/mobile ACs but close with them `[~]`/`[ ]` (Issue 21 AC#5/#6) | n/a | Rule: UI/mobile ACs cannot be silently deferred without a tracked follow-up |
| **UI-RECOVERY-PLAN.md** | Recovery roadmap to 80% parity | Current | No | No | Link from INDEX.md; source for filing M-series |
| **docs/ui/desktop/v2-reference, docs/ui/mobile** | Authoritative UI references | Current | The baseline for gap measurement | n/a | No change; mobile `.png.png` double-extension already documented in workflow.md |

---

# 2. CONTEXT.md Review

**Judgment call:** UI-parity, design-system, and screenshot rules **do not belong in CONTEXT.md** — UI authority is already correctly delegated to `domain.md` + `workflow.md`. Adding UI rules to CONTEXT would create a second source of UI truth. Below: genuine domain decisions → exact CONTEXT edits; UI/mobile/design-system/role-dashboard governance → routed to workflow.md/CLAUDE.md.

### Missing decisions from Issues 13–21 (belong in CONTEXT — exact proposed edits)

**(a) Override reason vocabulary** — §Override says "reason-coded" but enumerates none; Issue 13b shipped free-text. Add to §Override:
> *Override reason is captured as mandatory free-text in v1 (no controlled vocabulary). A coded `override_reason_code` enum is deferred to the reporting phase; until then "reason-coded" means "reason-required," not "enumerated."*

**(b) Soft-state supersede-on-advance** — §Soft State lists resolution events but not the advance rule Issue 15 implemented. Add:
> *Advancing a soft state (VIEWED → ON_SITE → TROUBLESHOOT_STARTED) resolves the SE's prior active state on that ticket (`resolved_by = SE`, `reason = ADVANCED`), so one SE holds at most one active state per ticket. An additional resolution event, not a conflict.*

**(c) Geofence radius** — §Soft State / ON_SITE describes AUTO_GEOFENCE but no radius; Issue 15 used 200 m. Add:
> *AUTO_GEOFENCE is satisfied when the captured point is within a default 200 m radius (`DEFAULT_GEOFENCE_RADIUS_M`) of the plant point; promote to a Settings value when per-deploy tuning is needed.*

**(d) Verification Phase-1 plant-geofence fallback** — §9 says anchor may be "inside the Plant geofence," but Issue 18 wired only SE form-GPS/ON_SITE (progress 18 §3). Add:
> *v1 anchors Phase-1 on the SE form-GPS / ON_SITE capture only; the "or inside Plant geofence" corroboration is deferred (plant.location + ST_DWithin).*

**(e) Planner soft-bias is a binary preference** — ADR-0022/§SE Planner imply a weighted term; Issue 14a implemented binary preference. Add to §SE Planner:
> *In v1 the bias is a binary preference (prefer the planner-named SE among hard-filter-passed candidates), not a weighted score term; a weighted `planner_affinity_weight` is deferred until SE selection becomes score-ranked.*

### Missing UI-parity / mobile / design-system / role-dashboard requirements
- **UI-parity:** already governed by workflow.md + domain.md. Do not add to CONTEXT. Gap is enforcement (see §3/§7).
- **Mobile:** CONTEXT already defines the mobile domain (§Day Plan, §Shared Pool, §Soft State, §client_submission_id). Gap is missing mobile *issues*, not domain text.
- **Authority rules:** complete in domain.md. No CONTEXT change.
- **Design-system:** not a domain concern → CLAUDE.md/workflow.md (shadcn), not CONTEXT.
- **Role-specific dashboards:** CONTEXT §People already encodes role access (CSM/Ops-Head full access; ZM own-zone; Warehouse owns inventory). The domain rule exists; the missing piece is the UI manifestation (v2 screens 02–05) → UI Recovery Plan / issues, not CONTEXT.

**Net:** CONTEXT needs only the 5 small domain reconciliations (a–e).

---

# 3. CLAUDE.md Review

CLAUDE.md is thin and is the one place a fresh agent reliably reads. It names the UI references but imposes **no gate**, and doesn't counterbalance the AFK "build the seam" instinct driving backend-first deferral.

### Rules causing backend-first development
- The workflow.md AFK rule "build the seam … for unavailable infrastructure (Redis, SMTP, FCM…)" is **over-extended to the UI surface**. The mobile app's *absence* is treated like unavailable infra, so every mobile AC is "seamed away." But an RN screen consuming an existing endpoint is buildable, not blocked. Neither CLAUDE.md nor workflow.md draws that line.

### Exact proposed edits to CLAUDE.md (new section)
> **## Surfacing rule (UI parity)**
> Backend and UI are **one vertical slice**, not two phases. An issue with UI/mobile acceptance criteria is **not done** until those criteria are met or an explicit follow-up issue owns them (filed in INDEX.md). "Build the seam" applies to *external integrations* (FCM/WhatsApp/SAP/AutoPlant), **not** to admin pages or mobile screens that consume endpoints already implemented in this repo.
>
> **Before executing any issue that touches a dashboard, page, screen, form, table, drawer, queue, report, or navigation:** read the authoritative reference image(s) under `docs/ui/desktop/v2-reference/` (desktop) or `docs/ui/mobile/` (mobile, note the `.png.png` extension) and follow the UI-discovery steps in `docs/agents/workflow.md`. Match layout, hierarchy, role visibility, navigation; do not redesign.
>
> **Parity gate:** an issue may not be marked done while leaving its in-scope UI/mobile ACs unbuilt unless (a) a follow-up issue is filed and linked, and (b) the deferral reason is an external-integration blocker, not "no app shell yet." If no app shell exists, that is a backlog gap to escalate (Strategic HITL: backlog-ownership), not a reason to defer silently.

### Missing requirements
- CLAUDE.md should point to workflow.md's UI-discovery procedure (currently only workflow.md knows it; CLAUDE.md is opened first).
- Add the parity gate above as a hard stop before "done."

---

# 4. ADR Review

| ADR | Valid? | Action |
|---|---|---|
| 0001 SE routing precedence | Valid (impl `recommender.service.ts`) | none |
| 0002 Recommender cadence | **Amend** — title/body say "Daily Plan"; CONTEXT §2 made it flexible-cadence | Update title + supersession note |
| 0003 Scoring tier structure | **Amend** — "Customer-Tier" → "Company-Tier"; top gate reshaped to Company Tier | Terminology + reshape note |
| 0004 Unified ticket work_type | Valid | none |
| 0005 Fleet Uptime / Soft Inactive | Valid as design; **not implemented** (no monthly calc, no deficit/preventive mode) | Add "impl deferred to 39/40 + recommender mode" note |
| 0006 Floating territory | Valid (impl Issue 09) | none |
| 0007 Morning batch one-click approval | **Superseded** ✓ (banner 2026-06-08) | fix README title only |
| 0008 Failure-cycle resubmit | Valid (partial; WAITING_COMPONENT pause deferred to 22) | none |
| 0009 Three-phase verification | Valid (impl 18); plant-geofence fallback deferred | cross-ref CONTEXT edit (d) |
| 0010 SE availability table | Valid as design; **not built** (Issue 25) | none |
| 0011 Install Ops-Head-only | **Superseded** ✓ (Decision §11) | fix README title |
| 0012 Component layered hard filter | Valid; partially built (21 kit leg done) | none |
| 0013 Shadow Use on 409 | Valid as design; **not built** (Issue 24) | none |
| 0014 Non-Op dual confirmation | Valid as design; **not built** (Issue 35) | none |
| 0015 Role backup cascade | Valid as design; **not built** (Issue 27) | none |
| 0016 Intra-day SE Acceptance + WhatsApp | Valid; **not built** (Issue 29) | none |
| 0017 Canonical processing order | Valid (impl `canonical-sort.ts`, fixture-pinned) | none |
| 0018 Cross-zone Platinum escalation | Valid as design; **not built** (Issue 32) | none |
| 0019 Day Plan approval SLA | **Superseded** ✓ (banner) | fix README title |
| 0020 SLA pauses component-only | **Superseded** ✓ (Vehicle Unavailability now pauses) | fix README title |
| 0021 Repeat failure new cycle | Valid (impl 08) | none |
| 0022 SE Planner soft bias | **Amend** — implemented as binary preference, not weighted | add impl note (cross-ref CONTEXT (e)) |
| 0023 Activity Status derived | Valid (impl 15) | none |
| 0024 Action-triggered heartbeat | **Historical/superseded** — HEARTBEAT_STALE removed (handoff 2026-06-22); **missing from README** | add to README, Superseded status |
| 0025 Foundation skeleton infra | Valid; **missing from README** | add to README |

### Missing ADRs created during Issues 13–21
**None were written — this is the gap.** Decisions living only in progress docs: override-reason free-text (13b), soft-state supersede-on-advance + geofence-radius + Prisma conflict-port (15), verification plant-geofence deferral + markAutoRecovery (18/19), planner binary-bias (14a). Minimum two new ADRs: **0026 "Soft-state resolution & geofence presence model"** and **0027 "Override reason is free-text in v1"**, plus the CONTEXT edits in §2.

---

# 5. Issue Backlog Review (Issues 22–50)

| Issue | Type | UI? | Mobile? | Note |
|---|---|---|---|---|
| 22 Component Request flow + WAITING_COMPONENT | Mixed | component-requests | resubmit/receipt | vertical; keep |
| 23 Component Request oversight | Mixed | ZM read-only + escalation | — | keep |
| 24 409 Conflict + Shadow Use | Mixed | shadow-use queue | 409 message | keep |
| 25 SE Management + availability | Admin-UI-heavy mixed | page | — | keep; don't defer UI |
| 26 Leave + SOFT_UNAVAILABLE | Mixed | admin | leave request | keep |
| 27 Role backup cascade + CSM acting | Mixed | acting banner, dashboards 02/03 | — | maps to v2 02/03 |
| 28 Vehicle Unavailability + dual SLA | Mixed | readiness 10, unavailability 11 | report | maps to v2 10/11 |
| 29 Intra-day CRITICAL + Accept/Decline | Mixed | intraday queue 13 | accept/decline | maps to v2 13 + mobile |
| 30 Intra-day timeout retry | Backend-heavy | queue states | — | merge UI with 29 |
| 31 ZM manual same-day update | Mixed | admin | — | keep |
| 32 Cross-zone Platinum escalation | Mixed | couldn't-assign queue | — | keep |
| 33 Install Ticket create + CSV | Mixed | create UI + CSV | — | keep |
| 34 Install lifecycle + verification | Mixed | — | install form | keep |
| 35 Non-Op dual-confirmation | Mixed | admin | — | keep |
| 36 Recovery Ticket lifecycle | Mixed | admin | collect | keep |
| 37 Recovery closure authority | Mixed | ZM decision queue | — | keep |
| 38 Expense Vouchers | Mixed | review | voucher | keep |
| 39–44 Reports | Admin-UI-heavy + backend MV | screens 21–25 | — | maps to v2 21–25; split MV/UI |
| 45 Plants Admin UI | UI-only | yes | — | keep |
| 46 Company Update API+UI | Mixed | yes | — | keep |
| 47 RequestActor seam | Backend-only | — | — | keep |
| 48 deal_type ownership | done | — | — | — |
| 49 Device deal_type column + tagging | Mixed | settings | — | keep |
| 50 Test isolation | Backend/test-only | — | — | keep |

### Missing UI / mobile work (structural)
- **No Mobile App Shell issue** and **no owner for the deferred mobile halves of 11/12/15/16/18/21.** Every issue 22–38 with a mobile AC hits the same wall (no shell to host the screen).
- **Reports (39–44)** bundle heavy chart-UI with backend MV work.

### Recommendations
1. **Create a Mobile Foundation issue** (RN shell, bottom-tab nav, component kit, offline-aware client) — prerequisite for every mobile AC; make 22–38's mobile ACs blocked-by it.
2. **File the M-series mobile UI issues** (per UI-RECOVERY-PLAN.md) for the orphaned halves of 11/12/15/16/18/21.
3. **Split 39–44** into `Na` (backend MV) + `Nb` (report UI), mirroring 13a/b, 14a/b.
4. **Don't split 22–37** — already vertical; enforce the parity gate so their UI/mobile ACs aren't deferred.
5. **Reprioritize per UI-RECOVERY-PLAN.md** (Phase 0 foundations → field loop → manager ops → warehouse).

---

# 6. UI Recovery Alignment

- **Missing admin screens:** 02/03/04/05 dashboards, 09 read-only ticket, 10 readiness, 11 vehicle-unavailability, 13 intra-day queue, 15 SE activity, 17 component-blocked, 18 component-requests, 19 shadow-use, 20 warehouse-stock, 21–25 reports, 27 help (~18).
- **Partial admin screens:** 01 dashboard (cards stubbed), 07 tickets, 08/28 ticket detail (4 of 6 tabs stub), 12 batch schedule (no KPI strip), 26 settings.
- **Missing mobile screens:** all 10.
- **Complete:** 00 login, 14 verification-review, 16 SE planner.

### Screenshots that should become acceptance criteria
| Screenshot | AC for issue |
|---|---|
| `v2-reference/17-component-blocked-queue.png` | 21 |
| `v2-reference/18-component-requests.png` | 22/23 |
| `v2-reference/19-shadow-use-queue.png` | 24 |
| `v2-reference/20-warehouse-stock.png`, `05-dashboard-warehouse.png` | 21 |
| `v2-reference/15-se-activity.png` | 25 |
| `v2-reference/10-readiness.png`, `11-vehicle-unavailability.png` | 28 |
| `v2-reference/13-intraday-queue.png` | 29/30 |
| `v2-reference/02/03-dashboard-csm/central.png` | 27 |
| `v2-reference/21–25` (reports) | 39–43, 44 |
| `mobile/home-dashboard.png.png`, `tickets-priority-view`, `ticket-detail-*`, `troubleshooting`, `verification`, `inventory`, `vouchers` | Mobile foundation + M-series |

### Which future issues should reference screenshots
**All of 21–44 plus the M-series.** workflow.md already mandates this for screen-touching issues; the gap is that issue *files* don't name the specific image. Each issue's "What to build" should add a "Reference: `docs/ui/.../<file>`" line.

---

# 7. Future TDD Guidance

### Must be updated before Issue 22 begins
1. **CLAUDE.md** — add the Surfacing rule + parity gate (§3). Highest leverage; first doc the next agent reads.
2. **INDEX.md** — flip 18/19 to done; file the **Mobile Foundation** issue + M-series; link UI-RECOVERY-PLAN.md.
3. **Issue 22 file** — add the screenshot reference line (`v2-reference/18-component-requests.png`); split its mobile AC to a tracked owner (Mobile Foundation must land first).

### What future agents must be required to read
`CONTEXT.md → ADRs (historical) → PRD → workflow → backend design → the issue → its progress doc → **the named v2/mobile reference image** → existing UI code.`
(domain.md already encodes this order; the change is making the image read non-skippable via CLAUDE.md.)

### Should UI parity be a mandatory gate?
**Yes — but scoped.** A **per-issue gate, not a phase switch** (the objective is explicitly *not* UI-first development): an issue with in-scope UI/mobile ACs cannot be marked done with those ACs deferred unless a linked follow-up owns them and the blocker is a true external integration. This enforces the existing-but-ignored workflow.md UI rules without reordering the backend-led TDD cadence.

---

# Prioritized Action Plan — edit order & why

| # | Document | Edit | Why this order |
|---|---|---|---|
| **1** | **CLAUDE.md** | Add Surfacing rule + parity gate + mandatory screenshot read | Highest-leverage; first doc every agent reads; it's what's letting UI be deferred. Cheap, immediate. |
| **2** | **INDEX.md** | Flip 18/19→done; file Mobile Foundation + M-series; link UI-RECOVERY-PLAN.md | Backlog is "live truth"; without mobile issues the parity gate has nowhere to send deferred work. Unblocks 22–38 mobile ACs. |
| **3** | **docs/agents/workflow.md** | Distinguish "defer external integration (OK)" from "defer implemented-backend UI (NOT OK)"; add parity-gate clause | Removes the rule ambiguity that justified backend-first deferral. |
| **4** | **Issue files 21–44 + M-series** | Add "Reference: `docs/ui/.../<image>`"; split deferred UI/mobile ACs to tracked owners | Makes the screenshot an enforceable AC input. Do Issue 22 before it starts; batch the rest. |
| **5** | **docs/adr/README.md** | Add 0024/0025; add Status column; fix stale titles | Prevents agents being misled by the index (bodies already correct). Low effort. |
| **6** | **CONTEXT.md** | Add the 5 domain reconciliations (override free-text, soft-state supersede, geofence radius, verification fallback, planner binary bias) | Closes the only genuine domain drift from 13–21. Must precede issues touching those areas (22, 25, 28). |
| **7** | **New ADR-0026 / 0027** | Document soft-state/geofence + override-reason decisions | Governance completeness; can trail the CONTEXT edits. |
| **8** | **PRD + workflow doc** | Add supersession banners (no rewrite) | Lowest urgency — domain.md already makes CONTEXT win; banners are hygiene. |
| **9** | **docs/backend/table-wise** | Add "deferred tables / dangling FKs" reconciliation note | Prevents schema confusion when 22–37 add inventory/role/escalation tables. |

**One-line summary:** the rules to do this right already exist in `workflow.md`/`domain.md`; the fix is to **make them an enforced per-issue gate via CLAUDE.md, give the deferred mobile/UI work tracked owners in INDEX.md, and bind each screen-issue to its v2 reference image** — then let the existing backend-led TDD cadence continue, surfacing each implemented slice in the apps as it lands.
