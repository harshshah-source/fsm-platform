# engineers

STATUS: gaps  updated 2026-09-02
COMPLETE: 62%  ->  74% after backlog
GAPS: 5 (S4 0 · S3 2 · S2 2 · S1/S0 1)  DANGEROUS 2 · needs-verify 0
EST: not yet estimated (S4 has not run)
VERDICT: Availability and leave reach dispatch correctly, but a manager cannot undo a mistake — an engineer put on leave in error cannot be given the day back by anyone.

## The picture
The carrier this module was suspected of lacking turned out to exist and to be a live read, so the
recommender does see availability changes. Chasing an overlap bug found something worse: two leave windows
on the same day get identical sort keys with no tie-break, so a manager's later correction silently loses to
the older row. The screen shows the correction sitting on top while the recommender keeps excluding the
engineer. Two-line fix, high blast radius. Leave decisions themselves leave almost no audit trail.

## What matters, ranked
- 🟠 a manager cannot revoke approved leave — the oldest window silently wins, so a mistaken absence is unfixable while the UI shows it corrected (ENG-G6, S3, DANGEROUS, reproduced 3/3)
- 🟠 leave approve and reject leave no usable audit record; reject writes **zero** audit rows, so a denial cannot be reconstructed (ENG-G1, S3, DANGEROUS, confirmed live)
- 🟠 planner intent writes change what dispatch does but are unaudited — the effect is recorded, the cause is not (ENG-G2, S3, DANGEROUS)
- 🟠 nothing prevents overlapping or duplicate leave windows for one engineer (ENG-G4, S2, three overlapping windows all persisted)
- 🟢 **cross-zone and wrong-role writes are all refused server-side** — that question is now closed for this module
- 🟢 the availability → dispatch carrier is real and live-read, not a stale view; the spine's omission was a map error, not a broken hand-off
- ⚠ ENG-G7 is a fixture gap, not a product gap: the seeded engineer persona has no `engineer_master` row. It blocked walks across several modules and belongs in dev-process, never the feature backlog
- ⚠ LOW confidence, **borrowed** anchors; cross-check split 15.72× — the widest in the survey, because this module's cost is control-shaped and the top-down check assumes screens

## Numbers
| | |
|---|---|
| functionally complete | 62% now → 74% after backlog |
| backlog | — |
| cheapest big fix | — |
| engineering size / risk | — — **not a schedule** |

## Not finished / needs you
- **needs-verify:** none
- **your call:** none
- **not walked:** none recorded

## All gaps, one line each
| id | sev | ⚠ | what (plain words) | type | size | P50 | conf |
|---|---|---|---|---|---|---|---|
| ENG-G1 | S3 | ☠ | Leave approve and reject leave no audit record | FIX | — | — | MED |
| ENG-G2 | S3 | ☠ | Planner intent writes change dispatch but are unaudited | FIX | — | — | MED |
| ENG-G3 | S2 |  | Spine map names no edge for this module though two live carriers | REFACTOR | — | — | HIGH |
| ENG-G4 | S2 |  | Nothing stops overlapping or duplicate leave requests per SE | NEW | — | — | MED |
| ENG-G5 | S1 |  | Availability reason is free text, no enumerated reason code | NEW | — | — | MED |

Evidence: `.work/engineers/` · estimate: `.work/engineers/estimate.json`
