# 61 — M7: Vouchers (mobile capture)

Status: ready-for-agent
Type: AFK

## What to build

The SE Vouchers tab (Issue 38 expense-vouchers backend): voucher capture (amount, category, photo of
receipt), submission, and status list. Consumes the Issue 38 voucher endpoints.

## Acceptance criteria

- [ ] Voucher capture form (amount, category, receipt photo) submits to the voucher endpoint
- [ ] Submitted vouchers list with status rendered
- [ ] Photo capture wired via the component kit

## UI surfaces

- **Mobile:** Vouchers tab. Owned by this issue.
- **Admin:** n/a (admin voucher review is Issue 38).

## Reference

- `docs/ui/mobile/vouchers.png.png`

## Blocked by

- #54, #38
