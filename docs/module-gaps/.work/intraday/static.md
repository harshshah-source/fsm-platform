> **CAVEAT (measured 2026-09-02):** the `audit` column follows only ONE delegation hop — it reports "no" whenever the audit write sits in a shared private helper. Verified false-positive rates: scheduling 11/11, tickets 8/10, cross-zone 6/6, vouchers 0/0, ingestion 0/3. Error is one-directional (under-detects, never invents), so "yes" is trustworthy and every "no" must be checked at `file:line`. The `guard` column can be off by one decorator. Never infer a UI facade from skeleton.md "no data hook" — admin pages use `useEffect` + `apps/admin/src/api/`, not react-query.

# static facts — Intra-day Re-plan Queue (intraday)
columns: guard = @Roles/@Public on the handler · audit = withAudit/record/auditLog.create in the reached service · status = writes a *status/state* field · tx = $transaction

| endpoint | file:line | guard | audit | status-write | tx |
|---|---|---|---|---|---|
| `GET /api/intraday-insertions` | apps/backend/src/intraday/intraday-insertion.controller.ts:44 | ...MANAGER_ROLES | no | no | no |
| `POST /api/intraday-insertions/fire` | apps/backend/src/intraday/intraday-insertion.controller.ts:51 | ...MANAGER_ROLES | no | yes | no |
| `GET /api/intraday-insertions/:id/available-ses` | apps/backend/src/intraday/intraday-insertion.controller.ts:71 | ...MANAGER_ROLES | no | yes | no |
| `POST /api/intraday-insertions/:id/manual-assign` | apps/backend/src/intraday/intraday-insertion.controller.ts:79 | ...MANAGER_ROLES | no | yes | no |

**totals:** 4 endpoints · 0 with no @Roles at handler or class · 0 @Public · 2 write-verb endpoints with no audit write in the reached method

## prisma models plausibly owned (name match on module keywords)
- `IntradayInsertion :532`

## spine edges owned by this module
| id | from | to | carrier | receiver | reverse | ev |
|---|---|---|---|---|---|---|
| E-18 | tickets · CRITICAL Ticket · arrives mid-day | intraday | cron sweep `assignCriticalForZone` | cron `criticalAssignTick` | ticketId, zoneId, tier, candidate SEs | `/intraday` IntradayQueuePage.tsx · ZM | `manual-assign` :79 | E2 `intraday/intraday-insertion.service.ts:172` · `scheduling/business-sweep-scheduler.service.ts:229` | intraday | OK |
| E-19 | intraday · Insertion · assigned | notifications (SE phone) | `notifications.notify` outside tx — in-app only, same UNAVAILABLE push seam as E-05 | auto-assign / manual-assign | insertionId, ticketId, plant, new stop order | in-app NotificationsScreen.tsx · SE (no push) | `intraday-updates/remove` :75 | E2 `intraday/intraday-insertion.service.ts:343,465,498` · `notifications/notification-channel.gateway.ts:37` | notifications | PARTIAL — S3 |
| E-20 | tickets (mobile) · SE cannot do a stop · declines | intraday | **a human remembers** — accept/decline endpoints were deleted with the offer machinery | *(none)* | ticketId, seId, decline reason | *(blank — no SE-side decline control, no ZM decline queue)* | none | E2 `intraday/intraday-insertion.controller.ts:36` ("`accept`, `decline` and `sweep-timeouts` are gone") | intraday | BROKEN — S4 (C1/C2) |

## env flags referenced in this module
_none_
