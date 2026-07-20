# 13 — Dialogs & Overlays

> Part of the [UI Redevelopment Handoff](20-master-index.md). Previous: [12 — Tables](12-tables.md) · Next: [14 — Design System](14-design-system.md).

Shared primitives: `Modal` (centered, z-50) and `Sheet` (slide-over, z-40) — both `role="dialog" aria-modal="true"`, Escape + backdrop close, gradient header, footer button row. See [07 — Components](07-components.md).

## Modal inventory

| # | Dialog | Kind | Trigger | Content / actions | On confirm |
|---|---|---|---|---|---|
| 1 | **Run ingestion now?** | Modal | TopBar "Run Ingestion Now" (OH) | warning copy (3–4 min VPN run); Cancel / **Run now** (`run-ingestion-confirm`) | `apiRunPipeline` → success toast + `emitIngestionComplete` |
| 2 | **Adjust stock — <component> (<zone>)** | Modal | WarehouseDashboard stock row "Adjust" | 3 number Fields (On hand / Reserved / Low-stock threshold); Cancel / **Save** (`stock-save`) | `apiSetWarehouseStock` → reload stock |
| 3 | **Manually close Recovery Ticket** | Modal | TicketDetailDrawer Overview (managers, RECOVERY, non-terminal) | mandatory reason textarea (`recovery-close-reason`); Cancel / **Close ticket** (danger, `recovery-close-confirm`, disabled until reason) | `apiManualCloseRecovery` → navigate `/tickets` |
| 4 | **Mark device Non-Operational** | hand-rolled `role="dialog" aria-label="Mark Non-Operational"` (not shared Modal) | NonOperationalQueuePage header CTA | Device ID, Reason select, OTHER free-text, RECURRING-device Recovery-Ticket warning + mandatory acknowledge checkbox; Cancel / **Mark device Non-Operational** (disabled until valid) | `apiRequestNonOp` → reload queue |
| 5 | **Expense proof** (lightbox) | Modal (`max-w-2xl`) | 📎 photo button on voucher line item | full-size image | close only |
| 6 | **Escalate verification** | inline `role="dialog" aria-label="Escalate verification"` block (below table, not overlay) | "Escalate" on fraud rows | reason textarea (`aria-label="Escalation reason"`); **Escalate** (disabled until reason) / Cancel | `apiEscalateVerification` → refetch |

## Confirm-in-place patterns (dialog-equivalent, no overlay)

- **ON_SITE conflict banner** (ScheduleDetailPage, `onsite-conflict-banner`, `role="alert"`): an override that hits an ON_SITE conflict is *held*; banner shows message + affected tickets + **Confirm override** (re-sends with `confirm: true`) / Cancel. The SE's ON_SITE state is never silently cleared — this two-step confirm is a business rule.
- **Inline expanding row forms** (reject reason, ship details, dispute reason, VU confirm-date, leave reject, voucher reject/clarify, schedule override forms) — see [11 — Forms](11-forms.md) #5–#19.
- **`window.prompt` flows** (CrossZone approve/deny/defer; NonOp override-confirm; Recovery reschedule/close-failed) — legacy; slated for Modal (#72). Payload semantics must survive any replacement.

## Other overlays

- **Toasts** — ToastProvider host, fixed bottom-right, `role="status"`, tone-tinted, 4 s.
- **Sidebar mobile drawer + scrim** — see [04 — Layout](04-layout.md).
- **Collapsed-rail nav tooltip** — body portal, `role="tooltip"`, z-60.
- **Custom Select / DropdownMenu popups** — outside-click/Escape close; z-20.
- **TicketDetailDrawer** — routed inline `aside`, *not* an overlay (list stays visible/mounted). Keep it route-driven (`/tickets/:ticketId`) in any redesign.

## Known gaps (acceptable to fix in redesign, not contracts)

Neither Modal nor Sheet traps focus or restores focus on close; body scroll is not locked behind overlays. Improving this is welcome as long as roles/labels/testids and open/close triggers stay identical.
