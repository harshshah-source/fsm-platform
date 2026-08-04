# 208 — One vocabulary: conform surface labels to the PRD's severity names

Status: ready-for-agent
Type: AFK · Admin + Mobile + Shared
Parent: [#197](./197-mobile-pilot-readiness-remediation-epic.md) · Filed 2026-08-04
Blocked by: nothing (lands cleaner after [#205](./205-contract-typing-shared-enums.md), which makes the maps exhaustive)

## Root cause

Every surface formats enum values independently — mobile has its own acronym-aware formatter, admin
has two different `humanize` helpers plus several raw-token render sites, and the SLA badge derives
its label from a numeric band table rather than the bucket name. Nothing owns cross-surface label
parity, so the same underlying value reaches an SE and their ZM as different words. The PRD does
specify a vocabulary; both surfaces have drifted from it in different directions.

## Findings closed

Audit 2: **C1** (SLA range-vs-severity labels), **C4** (root cause: three renderings), **C5**
(voucher status tones/labels), **C6** (component + schedule status labels), label half of **C3**
(`SOFT_UNAVAILABLE` raw + red).

## Evidence — verified 2026-08-04

**The PRD specifies severity names, for both surfaces**
- `PRD:824-834` — the SLA Bucket Reference table: the **bucket name is the label**, the time range is
  the *definition* column. `PRD:302` and `PRD:93` list the same eight names.
- `PRD:517`/`:484` — mobile Ticket Detail shows an "SLA bucket badge", same vocabulary. **No document
  specifies a different labelling scheme for admin.**
- Mobile is conformant: `ticketDisplay.ts:29-38` renders "Critical", "Long Pending".
- **Admin deviates**: `apps/admin/src/lib/slaBucket.ts:70,79,85` set `BUCKET_LABEL =
  BUCKET_RANGE_LABEL`, built by `:87-105`, so `CRITICAL` renders as `"24–48Hr"`. Rendered via
  `badges.tsx:24,34`.
- The `null` bucket is handled oppositely: mobile renders `"Active"` (`ticketDisplay.ts:30-32`),
  admin renders **nothing** (`badges.tsx:22` returns null).
- ⚠️ **Image/PRD conflict, per `docs/agents/domain.md:37` resolve to the PRD and document:** the
  desktop reference `01-dashboard-zonal-manager.png` labels bucket columns by time range
  (`<4H`, `4-8H`, … `24H CRIT`) **and its band boundaries do not match the PRD's own bands** (PRD has
  8-12h, 12-24h, 24-48h, 48-72h, 3-5d, 5-7d, 7d+). The image is wrong twice over; record it.

**Other divergences**
- Root cause, three renderings of one enum: mobile `"GPS Antenna Issue"`
  (acronym-aware, `troubleshootDisplay.ts:3-11`); admin analytics `"Gps Antenna Issue"`
  (`RootCauseAnalyticsPage.tsx:7`, `DeviceDetailPage.tsx:35`); admin ticket drawer raw
  `GPS_ANTENNA_ISSUE` (`TicketDetailDrawer.tsx:340`, and `:344`/`:347` for subcategory/action).
- Voucher status: `APPROVED` is info-blue on admin (`badges.tsx:88`) and success-green on mobile
  (`voucherDisplay.ts:26`); `DRAFT`/`ZONAL_MANAGER_REVIEW`/`NEEDS_CLARIFICATION`/`PAID` are untoned
  on admin (fall through to neutral, `badges.tsx:131`) but distinctly toned on mobile
  (`voucherDisplay.ts:22-30`); label differs — "Zonal Manager Review" vs "Manager Review"
  (`voucherDisplay.ts:15`).
- Component request: mobile shows the raw token with a binary tone (`StockScreen.tsx:116` —
  `RECEIVED` and `APPROVED` look identical); admin humanizes to "Shipped".
- Schedule status, inconsistent *within admin*: `SchedulesPage.tsx:118` renders `OVERRIDDEN` as
  "ZM Adjusted"; `ScheduleDetailPage.tsx:121` renders the raw token.
- `SOFT_UNAVAILABLE` renders raw on admin with the **critical/red** fallback tone
  (`SeManagementPage.tsx:36,133,286`) versus "Soft Unavailable" on mobile
  (`availabilityDisplay.ts:4-9`) — an SE legitimately using the #87 feature looks like a red alert.
- **No owner exists**: every label-related AC in the tracker (FE-01, FE-04, FE-10, FE-18, #122, #143)
  is scoped to the admin app alone.

## Scope

**In:** a single shared label source for the enums that appear on more than one surface (SLA bucket,
ticket/voucher/component status, root cause, availability status), consumed by both apps; conform
admin's SLA label to the PRD's severity names; make the raw-token render sites use it; record the
reference-image discrepancy.

**Out:** **colour semantics.** Mobile deliberately collapses 8 SLA colours to 2
(`ticketDisplay.ts:4-9`) because a phone is not a dashboard — that stays, and the epic closes it as
won't-fix. Also out: the `workState` vocabulary (#172 decision 3 ratified it as mobile-only) and
anything requiring a new endpoint — #169 item 7's "vocabularies obtainable by a client without
hardcoding" is a *serving* question, this is a *formatting* one.

**Open question for the implementer to raise, not decide:** admin's time-range labels may be
genuinely useful to a dashboard operator scanning a table. If so the answer is an explicit
PRD-deviation record (per `domain.md:37`), **not** silent divergence — escalate rather than assume.

## Acceptance criteria

- [ ] One shared formatter/label module is the source for every cross-surface enum label; neither app
      defines a second one
- [ ] Admin renders SLA buckets by severity name per `PRD:824-834`, or a documented PRD-deviation
      exists — not silence
- [ ] The `null`/ACTIVE bucket is handled the same way on both surfaces
- [ ] No user-visible raw `SCREAMING_SNAKE` token remains on either surface (ticket drawer, component
      pills, availability rows, schedule detail)
- [ ] The same value produces the same words on both surfaces for: SLA bucket, root cause, voucher
      status, component-request status, availability status
- [ ] The reference-image conflict (`01-dashboard-zonal-manager.png` labels *and* band boundaries vs
      `PRD:824-834`) is recorded per `docs/agents/domain.md:37`

## Verification

```bash
cd apps/admin && npx vitest run
cd apps/mobile && npx jest
```
Plus a side-by-side read of one ticket on both surfaces — the check that actually matters here.

## Risk if deferred

An SE and their ZM cannot discuss the same ticket in the same words. "The critical one" means a
severity band on the phone and a time range on the dashboard; a soft-unavailable SE reads as a red
alert to their manager; and a `PAID` voucher looks the same as a draft to the person who paid it.
None of this breaks a workflow outright, which is exactly why it will persist until someone owns it.

## Size estimate

S-M. Mechanical once the shared module exists; the only judgement call is the admin SLA label, which
may need escalating rather than deciding.
