# scheduling

STATUS: gaps  updated 2026-09-02
COMPLETE: 57%  ->  67% after backlog
GAPS: 7 (S4 2 · S3 1 · S2 2 · S1/S0 2)  DANGEROUS 2 · needs-verify 0
EST: not yet estimated (S4 has not run)
VERDICT: Scheduling itself is sound and correctly guarded; what breaks is everything downstream of it — a plan changes and the people affected are never told.

## The picture
The engine works. Every one of the 36 write endpoints refuses the wrong role, reproduced live, and the
suspicion that scheduling fails to announce a changed day plan was **falsified** — this module does queue
the notification. The break is one hop later, in the dead push adapter that `notifications` owns and prices.
What is genuinely missing here is the deactivation path: a plant goes inactive and an engineer already
en route has stops removed with no notice queued at all, because that carrier never enqueues.

## What matters, ranked
- 🔴 a plant deactivation silently strips stops from a live day plan, with nothing queued to tell anyone (SCH-02, S4, DANGEROUS) — the outbox it should use already exists
- 🟠 cross-zone assignment notifies the home manager rather than the engineer who must actually go (SCH-05, S3)
- 🟠 the day-plan notification names no ticket and leaks a raw enum to the reader (SCH-09, S2, confirmed live)
- 🟠 the intra-day queue scans the whole audit log unbounded to build itself (SCH-06, S2)
- 🟢 **role gating is genuinely correct** — every scheduling write refused the wrong role under live testing, with 36 of 36 endpoints guarded
- 🟢 SCH-01 falsified: this module does queue the day-plan notice. The failure is the downstream adapter, priced once in `notifications` (P11)
- ⚠ numbers are LOW confidence on a **borrowed** calibration — anchors come from 272 runs on a different repo, never measured on fsm-platform
- ⚠ cross-check split 13.47×, far past the 2× line: top-down assumes screen-shaped cost, this module is carrier-shaped. SCH-02/03/04 each exceed the "over 3M is not one gap" line and must be split before anyone commits

## Numbers
| | |
|---|---|
| functionally complete | 57% now → 67% after backlog |
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
| SCH-01 | S4 | ☠ | SE never told his day plan changed | INTEGRATION | — | — | MED |
| SCH-02 | S4 | ☠ | Plant deactivation silently strips SE stops, no notice | INTEGRATION | — | — | MED |
| SCH-05 | S3 |  | Cross-zone assign tells home ZM, not target SE | INTEGRATION | — | — | MED |
| SCH-03 | S2 |  | Day Plan has no Zone Warehouse pickup stop | COMPLETE | — | — | MED |
| SCH-06 | S2 |  | Intra-day queue scans whole audit log unbounded | PERF | — | — | HIGH |
| SCH-04 | S1 |  | No Schedule Cadence review reminder for ZM | NEW | — | — | MED |
| SCH-07 | S1 |  | Static scanner misreports guards and audit coverage | FIX | — | — | HIGH |

Evidence: `.work/scheduling/` · estimate: `.work/scheduling/estimate.json`
