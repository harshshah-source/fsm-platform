# dashboard

STATUS: estimated  updated 2026-09-02
COMPLETE: 67%  ->  84% after backlog
GAPS: 11 (S4 0 · S3 3 · S2 7 · S1/S0 1)  DANGEROUS 0 · needs-verify 1
EST: P50 45.82M · P80 91.64M TEQ · size XXL · risk HIGH · conf LOW · basis borrowed
VERDICT: The dashboard's zone-scoping is trustworthy, but each of the three roles is missing a different piece of the same page, and the highest-value fix (a one-click assign) is blocked on a backend field that always comes back empty.

## The picture
At 67% complete, the module's spine — row-level zone scoping — is its strongest property, confirmed working on all six dashboard endpoints, not just laid over unclamped data as suspected going in. The headline lack is inverted contents, not a missing lens: ZM alone lacks the critical work queue (DASH-G01) while CSM and OH alone lack the Action Required panel (DASH-G08), so no single role sees the whole page. Capability scoring is worse than the spine suggests: five of nine Action Required card types are permanently dead (DASH-G05) and the one queue ZM does have can't be assigned from, because `suggestedSes` is a hardcoded empty array on all 231 live groups (DASH-G11) — read DASH-G01 and DASH-G11 as one piece of work, not two.

## What matters, ranked
S4 / S3 / DANGEROUS / one-way doors only. Worst first. <=8 bullets. Always one 🟢 that works.
- 🟠 ZM dashboard shows no critical work queue at all — pair with DASH-G11, since the queue's assign button would have nothing to click either (DASH-G01, S3)
- 🟠 Action Required cards are dead counts, click leads nowhere (DASH-G02, S3)
- 🟠 Snapshot Healthy badge is a static literal, not a function of freshness — the predicted red-banner/green-badge clash was NOT observed (live snapshot succeeded); what was found instead is worse: no age threshold exists at all, so a 21-hour-old snapshot still reads healthy (DASH-G04, S3, needs-verify)
- 🟢 Row-level zone scoping works end to end on all six dashboard endpoints: zm.north/zm.south get disjoint single-zone payloads (391 vs 206 tickets), CSM/OH get genuine pan-India aggregates (33 companies, 29,394 devices) that are neither zone's number nor their sum, and zm.north asking for ?zoneId=2 fails closed back to zone 1
- ⚠ three gaps exceed the 3M split threshold and are each priced as one item anyway: DASH-G05 (5 of 9 cards dead), DASH-G06 (trend column), DASH-G11 (suggestedSes) — largest single driver is DASH-G05
- ⚠ cross-check split: top-down 19.80M TEQ (assumes 22 screens each cost one screen) vs bottom-up 45.82M (2.31x) — the screen-shaped assumption breaks because G05/G06/G11 are backend-payload fixes that touch many screens each, not one
- ⚠ weak anchor: 2.11M TEQ rests on "data"-lane cohorts with n=4 (DASH-G05, DASH-G06, DASH-G11 all carry this lane)
- ⚠ basis borrowed: every TEQ figure in this brief comes from 272 runs on a different repo (TS/Next/Prisma ERP), never measured on fsm-platform

## Numbers
| | |
|---|---|
| functionally complete | 67% now → 84% after backlog |
| backlog | P50 45.82M / P80 91.64M TEQ · conf LOW |
| cheapest big fix | DASH-G02 at 1.83M — Action Required cards are dead counts, click leads nowhere |
| engineering size / risk | XXL / HIGH — **not a schedule** |

## Not finished / needs you
- **needs-verify:** DASH-G04
- **your call:** none
- **not walked:** ZM Dashboard (/dashboard as zm.north) — Action Required panel: are the 9 cards rendered as inert <li> with no cursor/hover affordance, and do the 5 unwired ones paint the literal 'coming soon'? (DASH-G02, DASH-G05) — one browser walk ~708k TEQ; ZM Dashboard (/dashboard as zm.north) — 'Snapshot Healthy' green Badge in the DashboardHero action slot, co-rendered with the global SnapshotBanner strip: confirm both are on screen at once, then confirm the badge stays green while the banner is red. (DASH-G04) — needs a FAILED snapshot run FIRST, then one browser walk ~708k TEQ; CSM Dashboard (/dashboard as csm) — same 'Snapshot Healthy' badge at CentralDashboard.tsx:56-58. (DASH-G04) — folded into the walk above, no extra cost; ZM Dashboard — Zone Overview table 'Trend' column: confirm it paints an em-dash rather than being hidden. (DASH-G06) — one browser walk ~708k TEQ, LOW value: the null is already E4 from the payload; ZM Dashboard — Zone Overview table header/toolbar: confirm no export control exists on screen (the docblock claims one is preserved). (DASH-G09, DASH-G08 export half) — one browser walk ~708k TEQ; CSM / OH Dashboard — ScorecardTable toolbar: same missing export control. (DASH-G09) — folded into the walk above; CSM Dashboard (/dashboard as csm) — EscalationQueueList: confirm the rows render flat with no company/plant grouping headers and no assign control. (DASH-G10, DASH-G01) — one browser walk ~708k TEQ; ZM Dashboard — confirm no critical work queue section is painted anywhere on the page, including below the fold and inside any collapsed section. (DASH-G01) — one browser walk ~708k TEQ; this is the ONE screen-only item worth paying for, because it is the module's top gap and only a full-page sweep can prove an absence of paint; Any admin page — confirm ZoneOperatingModeCard / ZoneOperatingModeTable really appear nowhere. (DASH-G07) — the grep is conclusive for the admin bundle; a browser walk would add nothing and is NOT recommended; Disclosure sweep on the ZM dashboard (aria-expanded, <details>, chevrons, overflow menus, clickable rows) — NOT CHECKED, because no browser session was opened. Recorded as a failed sweep per S3, not as '0 found'.
- **⚠ weak anchor:** 2.11M TEQ of this estimate rests on cohorts with n<10
- **⚠ cross-check split:** top-down 19.80M vs bottom-up 45.82M (2.31×) — module is LOW-CONFIDENCE

## All gaps, one line each
| id | sev | ⚠ | what (plain words) | type | size | P50 | conf |
|---|---|---|---|---|---|---|---|
| DASH-G01 | S3 |  | ZM dashboard shows no critical work queue at all | COMPLETE | M | 1.75M | HIGH |
| DASH-G02 | S3 |  | Action Required cards are dead counts, click leads nowhere | COMPLETE | S | 0.99M | HIGH |
| DASH-G04 | S3 | ? | Snapshot Healthy badge is a static literal, not a function of freshness | FIX | — | — | HIGH |
| DASH-G03 | S2 |  | SE picker and assign callback loaded but no component renders them | FIX | — | — | HIGH |
| DASH-G05 | S2 |  | Five of nine Action Required card types permanently return available false | COMPLETE | L | 4.91M | HIGH |
| DASH-G06 | S2 |  | Zone Overview trend-vs-yesterday column can never show a value | COMPLETE | L | 4.32M | HIGH |
| DASH-G07 | S2 |  | Operating-mode card and table built but mounted on no page | COMPLETE | M | 1.05M | HIGH |
| DASH-G08 | S2 |  | CSM and Ops Head dashboards render no Action Required panel | COMPLETE | M | 2.44M | HIGH |
| DASH-G10 | S2 |  | Escalation Queue flattens company/plant grouping the backend supplies | FIX | M | 1.27M | MED |
| DASH-G11 | S2 |  | critical-queue suggestedSes is a hardcoded empty array on every group | COMPLETE | M | 4.12M | HIGH |
| DASH-G09 | S1 |  | Zone Overview docblock promises a CSV export button that is absent | COMPLETE | S | 0.98M | HIGH |

Evidence: `.work/dashboard/` · estimate: `.work/dashboard/estimate.json`
