# 15 — Dependencies (UI-related)

> Part of the [UI Redevelopment Handoff](20-master-index.md). Previous: [14 — Design System](14-design-system.md) · Next: [16 — Business Constraints](16-business-constraints.md).

From `apps/admin/package.json`.

## Runtime dependencies

| Package | Version | Actually used? | Role |
|---|---|---|---|
| `react` / `react-dom` | ^18.3.1 | ✅ | UI runtime |
| `react-router-dom` | ^6.26.2 | ✅ | Routing (BrowserRouter, nested route, useNavigate/useParams/useSearchParams) |
| `recharts` | ^2.15.4 | ✅ | All charts (via in-repo wrappers only — pages never import recharts directly) |
| `clsx` | ^2.1.1 | ✅ | class composition (via `lib/cn.ts`) |
| `tailwind-merge` | ^3.6.0 | ✅ | conflicting-utility resolution (via `lib/cn.ts`) |
| `@fsm/shared` | workspace:* | ✅ | Shared types/constants: `Role`, `ROLES`, `SessionView`, `LoginRequest/Response`, `SlaBucket`, **`SLA_BANDS`** (bucket thresholds shared with the backend classifier) |
| `@radix-ui/react-dialog` / `react-dropdown-menu` / `react-select` / `react-tabs` / `react-tooltip` | ^1–2.x | ❌ **installed but unused** — zero imports in `src/` | Overlays were hand-rolled instead (env install block at the time). Safe to adopt OR remove during redesign — but if adopted, the existing ARIA role/label contracts must be reproduced |
| `lucide-react` | ^1.21.0 | ❌ **installed but unused** | Icons are hand-rolled in `components/ui/icons.tsx` (documented lucide stand-in) |

## Dev dependencies (UI-relevant)

| Package | Role |
|---|---|
| `tailwindcss` ^4.0.0 + `@tailwindcss/vite` | Styling engine; v4 CSS-first config (`@theme` in index.css — **no tailwind.config.js**) |
| `vite` ^5.4 + `@vitejs/plugin-react` | Build/dev |
| `typescript` ^5.5 | Language |
| `vitest` ^2 + `jsdom` + `@testing-library/react` / `user-event` / `jest-dom` | Unit/integration tests (assert aria-labels + testids) |
| `@playwright/test` + `pixelmatch` + `pngjs` | Visual parity harness (`visual/capture.mjs`, `visual/compare.mjs`) against reference PNGs |

## Notably absent (do not assume during redesign)

No axios, no React Query/SWR, no Redux/Zustand, no react-hook-form/Formik/zod-on-client, no date-fns/dayjs/moment, no MUI/AntD/Chakra/shadcn, no framer-motion, no i18n library (all copy is hardcoded English), no CSS-in-JS.
