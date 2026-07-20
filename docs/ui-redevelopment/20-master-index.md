# 20 — Master Index · FSM Admin UI Redevelopment Handoff

Complete documentation of the FSM Admin Web Dashboard (`apps/admin`) frontend, written so another AI/engineer can redesign the UI **without reading the code and without breaking functionality**. Generated 2026-07-14 from the source on branch `feat/autoplant-integration`.

## Reading order

**Start here → [21 — AI UI Redevelopment Context](21-ai-ui-redevelopment-context.md)** — the consolidated, self-contained handoff (inventory + usage matrices + per-page redesign permissions + rules + checklist). Then [16 — Business Constraints & DO NOT BREAK](16-business-constraints.md) — the rules every other document assumes.

| # | Document | What it covers |
|---|---|---|
| 21 | [AI UI Redevelopment Context](21-ai-ui-redevelopment-context.md) | **The definitive single-document handoff** — consolidates 01–19 into one contract: component inventory with measured usage counts, page dependency matrix, impact/risk rankings, per-page change permissions, DO-NOT-CHANGE list, phased order, AI rules + checklist |
| 01 | [Project Overview](01-project-overview.md) | Product, domain, roles, full tech stack, folder structure, build system |
| 02 | [Architecture](02-architecture.md) | Provider tree, page recipe, data flow, permission layers, theming/forms approach |
| 03 | [Routing](03-routing.md) | Every route + file + role gate + params + nav entry; cross-page navigation patterns |
| 04 | [Layout](04-layout.md) | AppShell, Sidebar, TopBar, banners, Footer, login layout, split layouts, z-index map |
| 05 | [Modules](05-modules.md) | Feature-module map: pages ↔ components ↔ API modules ↔ hooks |
| 06 | [Pages](06-pages.md) | Every page: purpose, composition, actions, selectors, APIs, states |
| 07 | [Components](07-components.md) | Full inventory of shared + page-local components with props |
| 08 | [Hooks](08-hooks.md) | useApiResource/useAsyncAction/useFilters, context hooks, page-local hooks |
| 09 | [State](09-state.md) | Contexts, pub/sub, storage keys, local-state conventions, derived-state rules |
| 10 | [API](10-api.md) | fetch/401-refresh architecture + every function and endpoint per module |
| 11 | [Forms](11-forms.md) | All 27 forms + 4 prompt flows: fields, validation, submission, feedback |
| 12 | [Tables](12-tables.md) | DataTable contract + every table's columns/sort/filter/paging/actions |
| 13 | [Dialogs](13-dialogs.md) | Every modal/overlay, triggers, confirm-in-place patterns, known gaps |
| 14 | [Design System](14-design-system.md) | Tokens (colors/type/spacing/shadows), SLA ramp, motion, utilities, no-dark-mode |
| 15 | [Dependencies](15-dependencies.md) | UI packages — used, unused-but-installed (Radix/lucide), and deliberately absent |
| 16 | [Business Constraints & DO NOT BREAK](16-business-constraints.md) | API/permission/logic/selector contracts + the 20 hard rules |
| 17 | [File Inventory](17-file-inventory.md) | Every file under `src/` with purpose and exports |
| 18 | [Dependency Graph](18-dependency-graph.md) | Layered graph, cross-cutting flows, page→API matrix, fan-in hotspots |
| 19 | [Roadmap](19-ui-redevelopment-roadmap.md) | Phased redevelopment order (tokens → shell → kit → dashboards → pages → polish) |

## One-paragraph summary for the redesigner

This is a Vite + React 18 + TypeScript SPA styled entirely with Tailwind v4 tokens declared in `src/index.css`, composed from a small hand-rolled component kit (no external UI library in use), routed by one static route table with three layers of role gating, and fed by 36 typed `fetch` modules behind a global 401-refresh interceptor — with **no global data store and no client cache**. The redesign surface is: tokens, the shell, the shared kit, and page composition/markup. The untouchable surface is: routes, role gates, API modules and payloads, contexts/hooks, single-source domain logic in `lib/` + `components/domain`, every `aria-label`/`data-testid`, and the honest "gated placeholder" panels. Verify with `pnpm typecheck`, `pnpm test`, and the `/_kitchensink` + Playwright visual harness after each phase.

## Related repo docs (context beyond the frontend)

- `docs/SYSTEM-STATE-2026-07.md` — platform current state (source of truth)
- `docs/ui/desktop/v2-reference/` — authoritative screen reference images
- `.scratch/fsm-platform-v1/DESIGN-SYSTEM.md` — token derivation + documented omissions
- `CLAUDE.md` — agent workflow rules for this repo
