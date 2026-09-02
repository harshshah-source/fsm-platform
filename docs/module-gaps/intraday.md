# intraday

STATUS: estimated  updated 2026-09-02
COMPLETE: 75%  ->  94% after backlog
GAPS: 11 (S4 0 · S3 2 · S2 4 · S1/S0 5)  DANGEROUS 0 · needs-verify 1
EST: P50 29.70M · P80 59.41M TEQ · size XXL · risk HIGH · conf LOW · basis borrowed
VERDICT: The intra-day re-plan queue works for managers but the engineer hand-off depends on a push notification path that's dead, and the queue itself has no pagination or refresh.

## The picture
Spine is 75% and mostly holds: role gating and the zone clamp are genuinely correct (reproduced at
E4), and the retired §21 accept/decline offer path is about three-quarters clean — a walk of 1,936
live insertion rows found zero sitting in a retired state, so the dead-default worry did not pan out.
What's left is cheaper and duller than feared (dead schema, a dead `acceptanceDeadline` payload, three
alive-but-unwired write routes) except for one real hole: under §21 the engineer is *told*, not asked,
so the whole hand-off now rides on a push notification reaching their phone — and that adapter is
dead (priced once in `notifications`, not here). On top, the admin queue screen has no pagination
(552 rows for one ZM, unfiltered) and needs verification on whether it ever refreshes after mount —
those two must be fixed together, since polling an unbounded payload only makes it worse.

## What matters, ranked
S4 / S3 / DANGEROUS / one-way doors only. Worst first. <=8 bullets. Always one 🟢 that works.
- 🟠 engineer is never told a CRITICAL stop was added mid-shift (INTRA-G1, S3) — under §21 the SE is
  told, not asked, so the whole hand-off rides on a push notification reaching their phone, and that
  adapter is dead. Priced once in `notifications` (policy P11) — referenced, not re-priced here.
- 🟠 admin bell is dead; manager alert has no screen at all (INTRA-G2, S3)
- one-way door: engineer cannot flag one stop, only whole-day unavailable (INTRA-G4, S2, your-call) —
  a genuine new field-reality gap, not the retired §21 accept/decline; needs a product decision before
  it's priced further
- 🟢 role gate + zone clamp on intra-day are real and correct — reproduced at E4: all six routes
  return 403 for `se.north` and `wm`, and zone-scoped rows came back correctly bounded
- ⚠ weak anchor: 1.45M TEQ of INTRA-G1's integration lane rests on a cohort of n=6 (n<10)
- ⚠ cross-check split: top-down 7.20M vs bottom-up 29.70M (4.13×) — these gaps are carrier- and
  data-shaped (a dead push adapter, dead schema, unbounded queries), not screen-shaped, so top-down
  undercounts; don't average the two
- ⚠ over-3M gaps aren't one gap each: INTRA-G1 (5.60M) bundles integration+ui+api, and INTRA-G4
  (4.39M) bundles domain+api+ui — split each before scheduling

## Numbers
| | |
|---|---|
| functionally complete | 75% now → 94% after backlog |
| backlog | P50 29.70M / P80 59.41M TEQ · conf LOW |
| cheapest big fix | INTRA-G2 at 4.45M — admin bell is dead; manager alert has no screen at all |
| engineering size / risk | XXL / HIGH — **not a schedule** |

## Not finished / needs you
- **needs-verify:** INTRA-G3
- **your call:** INTRA-G4
- **not walked:** H1 push-adapter delivery of INTRADAY_DIRECT_ASSIGNED to an SE phone — deliberately not re-priced: shared gap owned by `notifications` (standing rule, policy P11). INTRA-G1 references it.; H2 manual-assign persistence (check 3) — needs a write + re-GET against a real ESCALATION_REQUIRED row (773 exist). Not walked: out of this walker's assigned four units. Cost ~4k TEQ, 1 record mutated.; H4 ASSIGNED_DIRECT has no downstream consumer (O3) — needs a read of the system-efficiency report as ZM/OH to confirm only ESCALATION_REQUIRED is counted. Not walked: out of scope for this walk. Cost ~2k TEQ.; INTRA-G3 refresh behaviour of the Intra-day Queue screen — NEEDS-VERIFY, one browser walk ~708k TEQ.; INTRA-G2 admin bell / manager alert screen — screen-shaped, not walked; browser only.; INTRA-G4 per-stop 'I cannot do this one' on mobile — no SE day plan seeded (`/me/tickets` = 0 rows); UNTESTABLE without a fixture.; INTRA-G5 raw ACCEPTED enum label on manager-assigned rows — screen-shaped; note that the live table holds ZERO ACCEPTED rows (1936 rows are ASSIGNED_DIRECT or ESCALATION_REQUIRED only), so the unlabelled branch may be unreachable in practice — re-check before pricing.; INTRA-G8 escalation dropped when zone.zonalManagerUserId is null — UNTESTABLE: all seeded zones have a ZM. Fixture: a zone row with zonalManagerUserId NULL.; INTRA-G9 stale comment at apps/admin/src/api/schedules.ts:436 — E2 is sufficient, no walk needed.; Zone-clamp fallthrough for a ZONAL_MANAGER with zone_id NULL (intraday-insertion.service.ts:479) — UNTESTABLE with seeded data. Fixture: a ZONAL_MANAGER user row with zone_id NULL.
- **⚠ weak anchor:** 1.45M TEQ of this estimate rests on cohorts with n<10
- **⚠ cross-check split:** top-down 7.20M vs bottom-up 29.70M (4.13×) — module is LOW-CONFIDENCE

## All gaps, one line each
| id | sev | ⚠ | what (plain words) | type | size | P50 | conf |
|---|---|---|---|---|---|---|---|
| INTRA-G1 | S3 |  | engineer is never told a CRITICAL stop was added mid-shift | INTEGRATION | L | 5.60M | MED |
| INTRA-G2 | S3 |  | admin bell is dead; manager alert has no screen at all | COMPLETE | M | 2.71M | MED |
| INTRA-G3 | S2 | ? | intra-day queue never refreshes; manager must reload the page | UX | — | — | MED |
| INTRA-G4 | S2 |  | engineer cannot flag one stop; only whole-day unavailable | NEW | XL | 4.39M | MED |
| INTRA-G8 | S2 |  | escalation alert silently dropped when a zone has no manager | FIX | M | 1.28M | HIGH |
| INTRA-G10 | S2 |  | queue returns all history unpaginated and unfiltered - 552 rows for one | FIX | M | 1.27M | HIGH |
| INTRA-G5 | S1 |  | manager-assigned rows show raw ACCEPTED enum with no label | FIX | S | 0.42M | HIGH |
| INTRA-G6 | S1 | ✗ | retired offer residue is schema-only - no live row sits in a | REFACTOR | — | — | HIGH |
| INTRA-G7 | S1 |  | three same-day-update write routes are LIVE and manager-callable with zero callers | REFACTOR | M | 1.17M | HIGH |
| INTRA-G9 | S1 |  | admin comment claims the on-site conflict gate is inert; it is live | FIX | XS | 0.43M | HIGH |
| INTRA-G0-PERMS | S0 | ✗ | role gate + zone clamp on intra-day are real; no gap | NA | — | — | HIGH |

Evidence: `.work/intraday/` · estimate: `.work/intraday/estimate.json`
