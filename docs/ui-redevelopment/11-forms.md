# 11 — Forms

> Part of the [UI Redevelopment Handoff](20-master-index.md). Previous: [10 — API](10-api.md) · Next: [12 — Tables](12-tables.md).

## Conventions (apply to every form)

- **No form library.** Controlled `useState` per field or one form object with a `set(key)(value)` helper.
- **Validation**: client side is minimal — required-field presence gates a `canSubmit`/`valid` boolean that disables the submit Button; occasional regex (`/^\d+$/` device id). **Authoritative validation is server-side**; backend error `code`s map to operator messages via `ERROR_MESSAGE` records. Do not move validation client-side during redesign.
- **Submission**: async handler sets `submitting` → Button `loading` → on success clear form + `role="status"` message (or toast) + reload list; on failure `role="alert"` message.
- **Field markup**: `Field` (label wrapper) + `Input` / `FilterSelect` / raw `<textarea>`; ids wired to `htmlFor`. Labels are test contracts.
- **Mandatory reason** is the platform's audit signature: Confirm buttons stay disabled until `reason.trim()` is non-empty.

## Full form inventory

| # | Form | Page / component | Fields | Validation gate | Submit → API | Feedback |
|---|---|---|---|---|---|---|
| 1 | Login | LoginPage | email, password (show/hide), remember-me (decorative) | none client-side | `useAuth().login` → `/auth/login` | error map INVALID_CREDENTIALS / SERVICE_UNAVAILABLE; sessionExpired notice |
| 2 | Act as ZM | TopBar | zone number input | numeric, non-empty | `setActingZone` (no API; header on later calls) | amber acting banner |
| 3 | Adjust stock | WarehouseDashboard **Modal** | onHand, reserved, lowStockThreshold (number) | none (numbers coerced) | `apiSetWarehouseStock` | reload stock; page error on failure |
| 4 | Recovery manual close | TicketDetailDrawer **Modal** | reason textarea (`recovery-close-reason`) | reason required | `apiManualCloseRecovery` | navigate to /tickets; error state |
| 5 | Batch override — Reorder | ScheduleDetailPage (inline per stop) | position number + ReasonInput | position + reason | `apiOverrideBatch {action:'REORDER'}` | refetch; ON_SITE conflict banner → confirm |
| 6 | Batch override — Swap SE | " | SePicker + ReasonInput | SE + reason | `{action:'SWAP_SE'}` | " |
| 7 | Batch override — Split batch | " | ticket checkboxes + SePicker + ReasonInput | ≥1 ticket + SE + reason | `{action:'SPLIT_BATCH'}` | " |
| 8 | Ticket override — Remove / Defer / Reassign | ScheduleDetailPage (inline per ticket) | ReasonInput (+ date for Defer, SePicker for Reassign) | per-action + reason | `{action:'REMOVE_TICKET'|'DEFER_TICKET'|'REASSIGN'}` | " |
| 9 | Set availability | SeManagementPage detail panel (ZM/CSM only) | status select (ON_LEAVE/OFF_SHIFT/WEEKLY_OFF/SOFT_UNAVAILABLE), window start* / end datetime-local, reason | windowStart required | `apiSetAvailability` | detail + list reload |
| 10 | Add Service Engineer | SeManagementDirectoryPage | name*, phone*, email*, address, zone* (locked for ZM), coverageType*, dailyCapacity* | all required present | `createSe` | success `role="status"`; `SeApiError.code` → 15-entry message map |
| 11 | Edit SE details | " (side panel) | name, phone, email, address, dailyCapacity | none | `updateSe` | "Saved." status; code map |
| 12 | Add SE coverage | " (side panel) | plant select (zone plants), coverageType | plant picked | `addSeCoverage` | list reload; code map (e.g. COVERAGE_EXISTS) |
| 13 | Reject leave | LeaveRequestsPage (inline row) | reason input | reason required | `apiRejectLeave` | row reload |
| 14 | Mark Non-Operational | NonOperationalQueuePage **modal** | deviceId*, reason select*, free text (when OTHER)*, acknowledge checkbox (when RECURRING + retrieval reason)* | `/^\d+$/` device + reason + OTHER-text + ack | `apiRequestNonOp` | queue reload; warning box `role="alert"` |
| 15 | Confirm VU date | VehicleUnavailabilityPage (inline row) | expected datetime-local | non-empty | `apiConfirmVuDate` | reload |
| 16 | Reject component request | ComponentRequestsPage (inline row) | rejection reason | required | `apiRejectRequest` | reload |
| 17 | Mark shipped | " (inline row) | trackingRef*, deliveryDestination select (SE_LOCATION/PLANT_WAREHOUSE) | trackingRef required | `apiShipRequest` | reload |
| 18 | Dispute shadow use | ShadowUseQueuePage (inline row) | dispute reason | required | `apiDisputeShadowUse` | reload |
| 19 | Voucher reject / clarification | VoucherReviewPage (inline row) | reason/comment input | required | `apiReviewVoucher(REJECT\|NEEDS_CLARIFICATION)` | reload |
| 20 | Finance export + Mark PAID | VoucherReviewPage (OH toolbar) | month YYYY-MM, batchRef, row checkboxes | selection non-empty for PAID | `apiExportVouchers` (CSV download) / `apiMarkVouchersPaid` | reload |
| 21 | Single install | InstallCreatePage | vehicleNo*, plant*, company*, deviceType*, deviceId*, simId, targetDate, notes | 5 required | `createInstall` | "Created install ticket <id>"; `InstallApiError.code` → 12-entry map |
| 22 | CSV bulk install | InstallCreatePage | CSV textarea | non-empty | `uploadInstallCsv` | batch summary; `CSV_VALIDATION_FAILED` → row-error DataTable |
| 23 | Escalate verification | VerificationReviewPage (inline dialog block) | reason textarea | required | `apiEscalateVerification` | refetch |
| 24 | Territory add | TerritoryPage | SE select, state/region/district cascade | SE + ≥state | `apiAddTerritory` (most-specific level) | territory reload |
| 25 | Settings CRUD (×8 sections) | `settings/sections.tsx` | per-section create/upsert forms (zones, plants, users, companies [+edit], SE coverage, SLA rules, scoring weights, common kit) | required presence | `org.*` create/upsert | optimistic list append / reload; "Failed to load" errors |
| 26 | Assign SE (critical cluster) | CriticalQueue (dashboard) | SE FilterSelect | SE picked | `apiAssignTicket` per ticket | `onAssigned` refetch |
| 27 | Planner intent | PlannerPage | plant select + drop/click on cell | plant picked | `apiCreatePlannerEntry` | grid refetch |

## `window.prompt` forms (legacy — replacement with Modal filed as follow-up #72; behaviorally still forms)

| Where | Prompts | API |
|---|---|---|
| CrossZonePage Approve | target zone id, SE id | `apiCrossZoneApprove` |
| CrossZonePage Deny / Defer | reason / review date + reason | `apiCrossZoneDeny` / `apiCrossZoneDefer` |
| NonOperationalQueuePage Override-confirm (OH) | reason | `apiOverrideConfirmNonOp` |
| RecoveryDecisionQueuePage Reschedule / Close failed | SE id / reason | `apiRescheduleRecovery` / `apiCloseFailedRecovery` |

A redesign may replace these prompts with proper dialogs (that is the filed intent), **but the mandatory-reason semantics and the API payloads must stay identical**.
