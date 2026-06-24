# 22 — Component Request flow + WAITING_COMPONENT pause + resubmit

Status: ready-for-agent
Type: AFK

## What to build

The end-to-end component-unavailable loop. When an SE submits the form with `component_unavailable = true`, the server raises a Component Request to the Warehouse Manager, moves the Failure Cycle to WAITING_COMPONENT, and **pauses the primary SLA** (`pause_reason = WAITING_COMPONENT`). Warehouse Manager queue (`/warehouse/requests`): list sorted by `created_at` desc; row opens Ticket context + SE + component + destination; **Approve** → shipping-details form → **Mark Shipped** (with tracking); **Reject** → mandatory reason (ZM notified). SE receives push on ship, taps **Confirm Receipt** → request RECEIVED → SLA resumes (per Decision §8: resume binds at ZM-confirmed resubmit; `sla_resume_on_receipt` is a config switch) → Troubleshooting Form reopens with a **new** `client_submission_id` for resubmit on the same Ticket. One Failure Cycle can hold multiple submissions. Resubmit ownership: Dedicated/Multi-Plant SE retains soft ownership; Floating SE ownership depends on spare delivery destination.

## Acceptance criteria

- [ ] `component_unavailable = true` raises a Component Request and moves cycle to WAITING_COMPONENT
- [ ] Primary SLA pauses with `pause_reason = WAITING_COMPONENT`
- [ ] WM can Approve → Mark Shipped (with tracking) or Reject (mandatory reason, ZM notified)
- [ ] SE Confirm Receipt sets RECEIVED and resumes SLA per the configured resume trigger
- [ ] Resubmit reopens the form with a new `client_submission_id` on the same Ticket
- [ ] Resubmit ownership rules applied for Dedicated/Multi-Plant vs Floating SE

## UI surfaces

- **Admin:** Warehouse Manager Component Requests queue (`/warehouse/requests`) — list + row drawer
  (Approve → shipping-details form → Mark Shipped; Reject → mandatory reason); Ticket Detail
  **Components** tab shows request status + WAITING_COMPONENT pause. Owned by this issue.
- **Mobile:** SE **Confirm Receipt** action + resubmit form (new `client_submission_id`).
  **Blocked-by Mobile Foundation** — deferred to the M-series; tracked owner: **M4** (Troubleshoot
  form / resubmit) and **M6** (Stock/receipt). Do not close this issue's mobile AC without that link.

## Reference

- `docs/ui/desktop/v2-reference/18-component-requests.png` (WM Component Requests queue)
- `docs/ui/desktop/v2-reference/08-ticket-detail.png` / `28-tickets-drawer.png` (Components tab)
- Mobile: `docs/ui/mobile/troubleshooting.png.png`, `docs/ui/mobile/inventory.png.png`

## Blocked by

- #21
