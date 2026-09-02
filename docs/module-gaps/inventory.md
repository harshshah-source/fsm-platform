# inventory

STATUS: estimated  updated 2026-09-02
COMPLETE: 61%  ->  74% after backlog
GAPS: 9 (S4 0 · S3 3 · S2 4 · S1/S0 2)  DANGEROUS 3 · needs-verify 3
EST: P50 22.65M · P80 45.29M TEQ · size L · risk HIGH · conf LOW · basis borrowed
VERDICT: Parts consumption never actually happens over the API, so van stock, the Common Kit check, and the parts-blocked queue are all working off numbers that never move.

## The picture
Inventory looks about two-thirds built, but the one path that is supposed to move stock — consuming components on a ticket — silently no-ops on every submission, because the field that would carry the parts used is never populated and both consumption loops iterate an array that is always empty. Everything downstream of that (Common Kit always reading complete, the Component-Blocked queue never firing, the already-built verification rollback having no rows to roll back) is a consequence of the same one gap, not a separate cost. The disputed-shadow-use gap sits latent right behind it and could not be confirmed independently, because the whole inventory data surface is empty in the dev DB — that is reported honestly, not hidden. Where the module does hold, it holds well: every warehouse write guard rejected ZM, CSM and SE at runtime.

## What matters, ranked
- 🔴 no HTTP field for consumed parts; van stock never depletes (INV-G8, S3, dangerous, confirmed live)
- 🟠 disputed shadow use never gives the van stock back (INV-G1, S3, latent behind INV-G8, not falsified — unreachable, needs a seeded fixture to settle)
- 🟠 recovered device never re-enters any stock ledger (INV-G2, S3, needs-verify)
- 🟢 every warehouse write guard held under live testing — 403 for ZM, CSM and SE, reproduced end to end
- ⚠ basis borrowed: every anchor here comes from 272 runs on a different TypeScript/Prisma repo, never measured on fsm-platform
- ⚠ cross-check split ~8.4x (top-down 2.70M vs bottom-up 22.65M) — the top-down check assumes cost is screen-shaped, but these gaps are domain/data/integration-shaped, so it undercounts badly
- ⚠ INV-G6 and INV-G8 are both over the doc's own 3M "one gap" ceiling — treat each as needing a split before anyone commits to it as a single unit
- ⚠ weak anchor: 1.74M TEQ of this estimate rests on cohorts with n<10 (integration n=6, data n=4)

## Numbers
| | |
|---|---|
| functionally complete | 61% now → 74% after backlog |
| backlog | P50 22.65M / P80 45.29M TEQ · conf LOW |
| cheapest big fix | INV-G8 at 9.38M — no HTTP field for consumed parts; van stock never depletes |
| engineering size / risk | L / HIGH — **not a schedule** |

## Not finished / needs you
- **needs-verify:** INV-G1, INV-G2, INV-G4
- **your call:** none
- **not walked:** INV-G1 arithmetic (van stock before/after a WM dispute) — blocked by INV-G8 and by an empty se_van_stock; needs the fixture named in gaps-INV-G1.md; INV-G2 recovery receipt -> warehouse stock — recovery/awaiting-receipt len=0, no COLLECTED ticket to receipt; INV-G4 7-day stale-request escalation — zero component requests exist in any lens, nothing old enough; INV-H2 / INV-G3 ship-notification hand-off (check 8) — no request can reach SHIPPED with zero requests seeded; check 3 persist for C1, C2, C3, C5, C7, C9, C10 — every inventory write path needs a seeded row this DB does not have; no WM/OH mutation attempted, to leave stock uncorrupted; C6 GPS/SIM serial verification (INV-G6) — S2 NOT_STARTED, walking can only re-prove an absence; browser walk of ShadowUseQueuePage / ComponentRequestsPage / mobile StockScreen — ~708k TEQ, and every one of them would render the same empty lists the API returned; disclosure sweep on inventory admin screens — no browser walk taken this stage
- **⚠ weak anchor:** 1.74M TEQ of this estimate rests on cohorts with n<10
- **⚠ cross-check split:** top-down 2.70M vs bottom-up 22.65M (8.39×) — module is LOW-CONFIDENCE

## All gaps, one line each
| id | sev | ⚠ | what (plain words) | type | size | P50 | conf |
|---|---|---|---|---|---|---|---|
| INV-G1 | S3 | ☠ | disputed shadow use never gives the van stock back | FIX | — | — | HIGH |
| INV-G2 | S3 | ☠ | recovered device never re-enters any stock ledger | COMPLETE | — | — | MED |
| INV-G8 | S3 | ☠ | no HTTP field for consumed parts; van stock never depletes | COMPLETE | L | 6.30M | HIGH |
| INV-G3 | S2 |  | SE gets no alert when a part ships; ZM none on reject | INTEGRATION | M | 2.64M | HIGH |
| INV-G4 | S2 | ? | stale component requests never escalate to a manager | NEW | — | — | MED |
| INV-G5 | S2 |  | zonal manager cannot see the disputes escalated to them | NEW | M | 2.76M | HIGH |
| INV-G6 | S2 |  | no serial check of fitted GPS/SIM against the ticket | NEW | L | 3.74M | MED |
| INV-G7 | S1 |  | engineer learns kit is short only by opening the app | NEW | — | — | MED |
| INV-N1 | S0 | ✗ | warehouse write guard is WM+OH and holds at runtime | FIX | — | — | HIGH |

Evidence: `.work/inventory/` · estimate: `.work/inventory/estimate.json`
