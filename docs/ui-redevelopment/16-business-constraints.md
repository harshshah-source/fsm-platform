# 16 — Business Constraints (MUST NOT CHANGE) & DO NOT BREAK

> Part of the [UI Redevelopment Handoff](20-master-index.md). Previous: [15 — Dependencies](15-dependencies.md) · Next: [17 — File Inventory](17-file-inventory.md).

Everything here is behavior the backend, the test suite, or the business depends on. The UI may be re-skinned freely **around** these; none of these may change.

## 1. API contracts

- Every function, endpoint, method, query param, and payload shape in [10 — API](10-api.md) is fixed. The backend is live; the UI adapts to it, never vice-versa.
- Error-code vocabularies (`SeApiError`, `InstallApiError`, `LoginError`, `OverrideConflictError`, CSV row-error codes) and the code→message maps.
- The batch-override command vocabulary: `REMOVE_TICKET | DEFER_TICKET | REORDER | SWAP_SE | SPLIT_BATCH | REASSIGN`, each with mandatory `reasonCode`, optional `confirm: true` retry after an ON_SITE conflict.
- Voucher review actions `APPROVE | REJECT | NEEDS_CLARIFICATION`; delivery destinations `SE_LOCATION | PLANT_WAREHOUSE`; settable SE availability `ON_LEAVE | OFF_SHIFT | WEEKLY_OFF | SOFT_UNAVAILABLE`; non-op reason codes incl. `RECOVERY_REASONS`; device sort whitelist; `?status=` voucher views.
- Auth flow: `POST /auth/login` → tokens; `GET /me` → session; single-flight rotating `POST /auth/refresh`; retry-once-on-401; `X-Acting-As-Zone` header on acted-as calls. sessionStorage keys `fsm.accessToken` / `fsm.refreshToken` / `fsm.actingZone` (authHeaders.ts and tokens.ts share literals).

## 2. Authorization & scoping (three mirrored layers — keep all)

- Route gates exactly as tabled in [03 — Routing](03-routing.md) (RoleRoute allowlists; redirect targets `/login` and `/`).
- In-page role gates: Set Availability = ZM/CSM (never OH); Override-confirm non-op = OH; deal-type tagging = OH; voucher Finance view/export/mark-paid = OH; cross-zone decider actions = CSM/OH; stock Adjust = WM/OH; RunIngestionButton = OH (matches backend guard — "do not widen"); ComponentRequestsPage `readOnly` on `/component-requests`.
- Role-scoped nav (`buildNav`) and role-scoped Help content mirror the same rules.
- Server-side zone scoping is authoritative — the client never filters by zone except explicit UI filters; ZM's create-SE zone field is locked to home zone.
- Acting-as-ZM semantics: banner + header + dashboard collapse to ZM variant + sessionStorage persistence + cleared on logout/expiry.

## 3. Business logic living in the frontend (single sources — reuse, never re-derive)

| Rule | Source |
|---|---|
| "Critical+" bucket set and sums (KPI must equal scorecard column sum by construction — Issue 1) | `lib/slaBucket.ts` `CRITICAL_PLUS_BUCKETS`, `criticalPlusCount`, `sumCriticalPlusDevices` |
| Bucket severity order, labels, range labels (derived from shared `SLA_BANDS` — Change #2: no page may hardcode SLA range text), colors (class + hex) | `lib/slaBucket.ts` |
| Elapsed-inactivity + "inactive / total" formatting | `lib/inactiveDuration.ts` |
| Plant code → full name mapping; display-only (plantId stays the key/filter/route everywhere) | `lib/plantNames.ts` + `<PlantName>` |
| Status → tone vocabulary (ticket/component/recovery/install/intraday/assignment) | `components/domain/badges.tsx` `STATUS_TONE` |
| CSV generation (RFC-4180-ish quoting) + download | `lib/csv.ts` |
| Snapshot "stuck" threshold (RUNNING > 15 min) | `SnapshotBanner` |
| WAITING_COMPONENT badge darkens past 7 days; age-chip thresholds 3/7/14 d; awaiting-days tones 3/7 d | ticketBadges / AgeChip / NonOpQueue |
| Login error taxonomy (401 = credentials; network/5xx = service unavailable — "honest errors") | `api/client.ts` |
| RollingNumber trigger = run completion token, not value diff | `RollingNumber.tsx` |
| Local-date formatting in Planner (`isoDate` avoids UTC shift) and its 7-day window | `PlannerPage` |
| Device-list paging geometry (PAGE_SIZE 100, reset-on-filter) | `DeviceDetailPage` |

## 4. Workflow invariants (from CONTEXT/issues — visible in UI copy and structure)

- **Schedules are monitoring-only**: no Approve action, no approval countdown (gate removed by decision — never reintroduce).
- **ON_SITE conflict** on override requires explicit confirm; never silently cleared.
- **Dual confirmation** for non-operational (manager + customer); OH override only after-the-fact with reason; RECURRING device + physical-retrieval reason ⇒ auto Recovery Ticket warning with mandatory acknowledgement.
- **Dual SLA clocks** on vehicle unavailability; the secondary (never-pausing) clock is manager-only *because it renders only on the manager-gated page*.
- **Mandatory reasons** on every destructive/override action (audit trail).
- **Warehouse receipt confirm auto-closes** the Recovery Ticket (single click, no ZM approval).
- **Intraday ZM manual updates need no SE acceptance**; acceptance column is a placeholder for system CRITICAL insertions.
- **Gated placeholders, never fabricated data**: Fleet-Uptime "—" KPIs, Auto-Dispatch efficiency row, Work-type mix, Verification outcomes, SE load-vs-capacity, Warehouse stock KPIs pre-#73, "coming soon" action cards. A redesign must keep the gated/"coming soon" affordances rather than inventing numbers.
- **Soft-inactive trend** endpoint is OH-only; other manager roles see the gated panel, not an error.
- **Deferred-but-visible** affordance: disabled "Draw polygon on map (coming soon)" on TerritoryPage.

## 5. Component & selector contracts (test suite)

- Every `aria-label` and `data-testid` documented in [06 — Pages](06-pages.md) and [12 — Tables](12-tables.md), the `bucket-<BUCKET>` badge testids, `badge-*` flags, tab roles (`tab`/`tablist`/`tabpanel`, `aria-selected`), `role="alert"`/`role="status"` usage, `aria-sort`, `aria-expanded`, `aria-current="page"`, drag payload type `text/plant-id`.
- Import alias `AdminShell` → AppShell (`components/AdminShell.tsx`) is referenced by tests — keep the re-export.
- LoginPage show/hide toggle `aria-label` intentionally excludes the word "password" (keeps `getByLabelText(/password/i)` unambiguous).

## 6. Contexts & providers

Provider tree order (`AuthProvider > BrowserRouter > ToastProvider > AppRoutes`), `installAuthFetch()` before first render, `SidebarProvider` inside AppShell, the `setOnSessionExpired` wiring, and the ingestionEvents pub/sub contract.

## 7. Data transformations & calculations (client-side, keep identical)

- KPI reductions (inactive sums, action-required "live sources" = `available && count > 0`, escalation counts).
- CompanyPlant grouping by companyId; EscalationQueue flatten + severity sort; worst-bucket = first non-zero in `SLA_BUCKETS` order.
- Fleet-uptime trend assembled client-side from n monthly report calls (`recentMonths`); soft-inactive series summed per capture date.
- CSV export column orders (Zone Overview, Company/Plant, voucher Finance export passthrough).
- Voucher `₹` en-IN formatting; over-limit line flagging comes from the API (`overLimit`), UI only styles it.
- Assignment History = lifecycle events with non-null `actorRole`.
- CriticalQueue Assign loops `apiAssignTicket` per ticket in the cluster (sequential awaits).

---

# DO NOT BREAK

The redevelopment is **presentation-only**. Concretely:

1. **Do not rename, remove, or change the signature of any function in `src/api/`** — endpoints, methods, params, payloads, return types, and error classes are backend contracts.
2. **Do not change routes** — paths, the nested `/tickets/:ticketId` drawer route, `?tab=` query params, redirect targets, or the dev-only `/_kitchensink` gating.
3. **Do not change auth** — AuthProvider logic, token storage keys (`fsm.accessToken`, `fsm.refreshToken`, `fsm.actingZone`), `installAuthFetch` timing, single-flight refresh, proactive-refresh scheduling, session-expired flow, or the `X-Acting-As-Zone` header.
4. **Do not change permissions** — RoleRoute allowlists, in-page role checks, `buildNav` role logic, acting-mode behavior. Never widen a gate to "improve UX".
5. **Do not change state management** — no new global store; keep Auth/Toast/Sidebar contexts, the ingestionEvents pub/sub, per-page fetch-on-mount, and reload-after-mutation semantics.
6. **Do not change providers or their nesting order** (`AuthProvider > BrowserRouter > ToastProvider`; `SidebarProvider` inside AppShell).
7. **Do not change hooks' contracts** — `useApiResource`, `useAsyncAction`, `useFilters`, `useAuth`, `useToast(Optional)`, `useSidebar`, `useRollingNumber` signatures and semantics.
8. **Do not change backend payloads** — including override command actions, review actions, reason-code enums, CSV upload header format, and the mandatory-reason fields.
9. **Do not change form validation semantics** — disabled-until-valid gates, mandatory reasons, the RECURRING-device acknowledgement, error-code → message maps. (Moving a `window.prompt` into a proper dialog is allowed — payloads and mandatory-ness identical.)
10. **Do not change or remove any `aria-label` or `data-testid`** — they are the test suite's selector contract (tables, rows, badges `bucket-<B>`/`badge-*`, metrics, buttons, dialogs). Same for ARIA roles (`alert`, `status`, `dialog`, `tab*`, `combobox`, `menu`) and attributes (`aria-sort`, `aria-expanded`, `aria-current`, `aria-selected`).
11. **Do not re-derive single-source domain logic** — Critical+ definition, bucket labels/ranges/colors, plant-name mapping, status→tone map, duration formatting, CSV helpers. Import from `lib/` and `components/domain` instead.
12. **Do not fabricate data for gated panels** — "—" placeholders, "coming soon" cards, and gated EmptyStates must remain honest until their backend sources land.
13. **Do not change component interfaces** (props of shared components in [07](07-components.md)) **unless absolutely required** — pages, tests, and the kitchen sink compose them; additive optional props are the safe path.
14. **Do not remove the `AdminShell` re-export**, the `enterprise-page` container, the MetricStrip grid-cols safelist, or the `prefers-reduced-motion` global rule.
15. **Do not change client-side sorting/paging boundaries** — tickets/non-op ordering is server-owned; the device list is server-paged (100/page, reset-on-filter); DataTable sorting stays opt-in per column.
16. **Do not change navigation side-effects** — row-click destinations, ticket deep-links with tab params, drawer close → `/tickets`, sidebar auto-close on route change, collapse persistence key.
17. **Do not restyle the AutoPlant brand lockup** (`BrandLogo`, `brand-logo` color) — pinned to the legacy reference; and keep the acting banner, snapshot banner, and session-expired notices present and visible.
18. **Do not alter copy that encodes business rules** unless the rule owner signs off — e.g. "monitoring only … no approval gate", dual-clock explanations, recovery auto-close descriptions, the RECURRING warning text.
19. **Do not introduce client caching or optimistic updates** where reload-after-mutation exists today — queues must reflect persisted server state.
20. **Do not break the visual test harness assumptions** — keep `/_kitchensink` rendering every primitive, and keep `pnpm test` / `pnpm typecheck` green after every change.
