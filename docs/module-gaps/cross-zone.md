# cross-zone

STATUS: gaps  updated 2026-09-02
COMPLETE: 51%  ->  76% after backlog
GAPS: 10 (S4 0 · S3 5 · S2 3 · S1/S0 2)  DANGEROUS 3 · needs-verify 0
EST: not yet estimated (S4 has not run)
VERDICT: Escalations can be raised and approved, but the zone that has to do the work is never told, and one crash mid-approve leaves a ticket assigned with its escalation still pending.

## The picture
This module exists only to move work across the zone boundary every other module clamps, and that crossing
is where it fails: an approved escalation reaches nobody in the target zone — no notice, no queue row, no
schedule entry — so the receiving side learns of it only by being told a ticket number. The two-phase
approve was confirmed live: the assignment commits, then a separate status write can leave the escalation
PENDING forever. One predicted finding was **falsified** — acting-scope actions here are audited correctly.

## What matters, ranked
- 🟠 approve can assign the ticket and still leave the escalation PENDING, with retry short-circuiting instead of reconciling (CZ-01, S3, DANGEROUS)
- 🟠 the target zone is never told: no notice, no queue row, no schedule (CZ-11, S3, confirmed live) — a hand-off that needs the number spoken aloud is a lookup, not a hand-off
- 🟠 a denied Platinum cannot be re-escalated — the row vanishes and the only authorised role sees no button (CZ-05, S3)
- 🟠 no UI anywhere lets a ZM flag a Gold/Silver ticket cross-zone, though the endpoint is alive (CZ-04, S3) — wiring, not building
- 🟠 approve asks for zone id and engineer id through browser prompt boxes (CZ-06, S2)
- 🟢 CZ-03 falsified: CSM backup actions **are** audited with the acting tag — all five write paths audit through one shared helper
- ⚠ CZ-02 and CZ-06 stay needs-verify — the sweep-orphan race is code-proven (E2) but was not reproducible from outside, and it was not inflated to a walked result
- ⚠ LOW confidence, **borrowed** anchors; cross-check split 6.49×; CZ-05 and CZ-11 exceed the "over 3M is not one gap" line and need splitting first

## Numbers
| | |
|---|---|
| functionally complete | 51% now → 76% after backlog |
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
| CZ-01 | S3 | ☠ | Approve can assign the ticket yet leave the escalation PENDING | FIX | — | — | HIGH |
| CZ-02 | S3 | ☠ | Sweep notify failure hides a Platinum escalation from the CSM forever | FIX | — | — | HIGH |
| CZ-03 | S3 | ☠ | CSM backup actions are audited as the CSM's own, acting tag dropped | FIX | — | — | HIGH |
| CZ-04 | S3 |  | No UI anywhere for a ZM to flag a Gold/Silver ticket cross-zone | COMPLETE | — | — | HIGH |
| CZ-05 | S3 |  | Denied Platinum cannot be re-escalated: row vanishes and no button | COMPLETE | — | — | HIGH |
| CZ-06 | S2 |  | Approve asks for zone id and SE id via browser prompt boxes | UX | — | — | HIGH |
| CZ-07 | S2 |  | Deferred escalations never resurface on their review date | NEW | — | — | MED |
| CZ-08 | S2 |  | No report of who approved what: only the live queue is readable | NEW | — | — | HIGH |
| CZ-09 | S1 |  | Decision notice silently skipped when the home zone has no manager | FIX | — | — | HIGH |
| CZ-10 | S1 |  | Static scanner misses audit written one hop deeper in a helper | REFACTOR | — | — | HIGH |

Evidence: `.work/cross-zone/` · estimate: `.work/cross-zone/estimate.json`
