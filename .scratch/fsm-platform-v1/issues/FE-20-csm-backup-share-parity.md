# FE-20 — CSM Backup-Share report parity

Status: ready-for-agent
Type: AFK · Frontend · Phase F5
Effort: S

> Governed by `DESIGN-SYSTEM.md` §5.1/5.6. Global DoD applies.

## What to build

Reskin `CsmApprovalSharePage` to the design system: `MetricCard`s + `BarChartCard` bound to the existing
CSM backup-share data (Issue 27 AC#5). Operations-Head-only.

## Dependencies

- FE-05

## Acceptance criteria

- [ ] `MetricCard`s + `BarChartCard` render existing share data
- [ ] Ops-Head-only gating + existing API preserved

## Reusable components introduced

- (consumes FE-05)

## Affected pages

- `CsmApprovalSharePage` (**[RP]**)

## Reference

- (report; follows reports chart conventions `21`/`24`)

## Verification

- `csm-approval-share.test.tsx` green
