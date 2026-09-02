# tickets

STATUS: gaps  updated 2026-09-02
COMPLETE: 54%  ->  69% after backlog
GAPS: 9 (S4 0 · S3 4 · S2 2 · S1/S0 3)  DANGEROUS 3 · needs-verify 0
EST: not yet estimated (S4 has not run)
VERDICT: The manager side of tickets is wired end to end; the engineer side is where the work stops, and one core field-work path returns a 500 every time.

## The picture
Nineteen wrong-role calls found **zero** permission defects, and the manager surfaces all consume their
endpoints properly. The damage is on the engineer side. Reporting a component as unavailable fails with
HTTP 500 on every attempt — a database constraint requires a field no caller ever sets — which makes the
whole component-request hand-off unreachable over the API and explains the empty warehouse queues seen
elsewhere in this survey. Filing vehicle unavailability then makes the ticket vanish from the engineer's own list.

## What matters, ranked
- 🔴 reporting a component unavailable returns HTTP 500 every time, so the warehouse hand-off cannot be reached at all (TKT-02, S3, DANGEROUS, 4/4 reproduced)
- 🟠 vehicle unavailability pauses and resumes the SLA clock with no audit row — the clock can be stopped and nobody can say by whom (TKT-01, S3, DANGEROUS)
- 🟠 the customer confirmation link for a non-operational close is only written to a log, never sent (TKT-09, S3)
- 🟠 filing vehicle unavailability makes the ticket disappear from the engineer's own list (TKT-12, S2, confirmed live)
- 🟠 the engineer's ticket list returns the entire shared pool unpaginated — 521 rows (TKT-11, S2, confirmed live)
- 🟢 **permissions are clean** — 19 wrong-role probes, zero defects, and the zone clamp holds on the audit trail
- 🟢 TKT-03 falsified: server-side submission dedup is real and rejects the duplicate. The weakness is only the mobile client minting a fresh id on retry
- ⚠ LOW confidence, **borrowed** anchors; cross-check split 4.56×; TKT-02/04/07/09 exceed the "over 3M is not one gap" line. Install and recovery lifecycles were never walked — all 100 seeded tickets are TROUBLESHOOT

## Numbers
| | |
|---|---|
| functionally complete | 54% now → 69% after backlog |
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
| TKT-01 | S3 | ☠ | vehicle unavailability pauses and resumes SLA with no audit row | SECURITY | — | — | MED |
| TKT-02 | S3 | ☠ | component request raised with no component identity for warehouse | COMPLETE | — | — | MED |
| TKT-03 | S3 | ☠ | troubleshoot retry mints a new dedup id, no offline queue | FIX | — | — | MED |
| TKT-09 | S3 |  | non operational customer confirmation link is only written to a log | INTEGRATION | — | — | MED |
| TKT-04 | S2 |  | shadow use message on conflict screen can never render | COMPLETE | — | — | MED |
| TKT-05 | S2 |  | troubleshoot form shows nothing when submit fails offline | UX | — | — | MED |
| TKT-06 | S1 |  | no QR or barcode scan shortcut into ticket detail | NEW | — | — | MED |
| TKT-07 | S1 |  | readiness hint on ticket detail is a hardcoded UNKNOWN | COMPLETE | — | — | MED |
| TKT-08 | S1 |  | technical hints hidden entirely when no telemetry snapshot exists | UX | — | — | MED |

Evidence: `.work/tickets/` · estimate: `.work/tickets/estimate.json`
