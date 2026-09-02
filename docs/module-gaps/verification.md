# verification

STATUS: estimated  updated 2026-09-02
COMPLETE: 69%  ->  92% after backlog
GAPS: 8 (S4 0 · S3 3 · S2 4 · S1/S0 1)  DANGEROUS 1 · needs-verify 2
EST: P50 22.19M · P80 44.37M TEQ · size L · risk HIGH · conf LOW · basis borrowed
VERDICT: The module that judges whether field work really happened cannot scope its own fraud list, and an escalation once made can never be taken back.

## The picture
The write paths are correctly guarded, audited and transactional — reproduced live. The problem is a single
omission in one file: the fraud-flag read declares no zone scope at all, while the same service clamps its
three neighbours. Three clamps and one gap, and the gap is the fraud list. It stays code-evidence rather
than a reproduced leak because the module holds **zero rows** in this database, which also blocked the
ledger-divergence check — zero equalling zero is not agreement, and was not recorded as one.

## What matters, ranked
- 🟠 the fraud-flag list is not zone-scoped, so any manager reads every zone's flags (V-02, S3, DANGEROUS) — the same service clamps `review()` and `forTicket()`, making this a one-line omission rather than a design gap
- 🟠 no un-escalate exists: a wrongly escalated ticket must either stand or be laundered through an unrelated close (V-04, S3, DANGEROUS, five not-found checks recorded)
- 🟠 marking auto-recovery on a no-pings row leaves the run verdict stale, so two ledgers disagree (V-01, S3, DANGEROUS)
- 🟠 the fraud-flags endpoint is built and tested but no screen calls it (V-03, S2)
- 🟠 an auto-recovery close needs no reason and no confirmation (V-07, S2)
- 🟢 **both write endpoints are correctly guarded, audited and transactional** — 403 for engineer and warehouse roles, reproduced live
- ⚠ V-01 and V-02 stay needs-verify **honestly**: all four managers got empty lists, so the leak's effect is unproven even though its cause is plain in source. Two or three seeded verification runs would settle both
- ⚠ LOW confidence, **borrowed** anchors; cross-check split 5.76×; V-04 and V-05 exceed the "over 3M is not one gap" line

## Numbers
| | |
|---|---|
| functionally complete | 69% now → 92% after backlog |
| backlog | P50 22.19M / P80 44.37M TEQ · conf LOW |
| cheapest big fix | V-04 at 4.86M — No un-escalate: a wrongly escalated ticket cannot be returned |
| engineering size / risk | L / HIGH — **not a schedule** |

## Not finished / needs you
- **needs-verify:** V-01, V-02
- **your call:** none
- **not walked:** V-02 zone leak at E4 — fraud-flags returned 0 rows to every manager role, so the cross-zone read could not be reproduced. Needs one VerificationRun with fraudFlag=true on a zone-2 plant, then GET as zm.north. Cost: 1 seed row + one ~2k TEQ call.; V-01 ledger divergence at E4 — /reports/efficiency, /reports/fleet-uptime and /reports/verification-outcomes all returned zero verification counts. Needs one FAILED_NO_PINGS run, a mark-auto-recovery POST, and a re-read of both reports. Cost: 1 seed row + three ~2k TEQ calls.; Check 3 (persist) for every capability C1-C7 — no VerificationRun exists anywhere in the dev DB, so nothing can be written and re-read. This single fixture gap (V-08) blocks the persist check module-wide.; Zone clamp on GET /verification/review — both ZMs returned 0 rows; the clamp is E2-visible in source at verification-query.service.ts:174 but was not reproduced. Same fixture as V-01 settles it.; V-03 (fraud-flags endpoint has no UI consumer) — screen-only claim. NEEDS-VERIFY: would require loading /verification as zm.north and confirming no control anywhere reaches fraud-flags. Cost: one browser walk ~708k TEQ.; V-07 (auto-recovery close needs no confirmation dialog) — screen-only claim about the Mark auto-recovery control on VerificationReviewPage. NEEDS-VERIFY by browser; the API half is settled (no reason field server-side). Cost: one browser walk ~708k TEQ.; V-06 rendered appearance — that the 'overdue' chip actually paints on a stalled-watermark row was confirmed from source (VerificationReviewPage.tsx:31 hoursLeft) but not seen. Cost: folded into the same ~708k TEQ browser walk.; Wrong-role check on the three receiving report endpoints (/reports/efficiency, /reports/fleet-uptime, /reports/verification-outcomes) — only read as OH. C7 check 6 left at '?'.; SE mobile VerificationScreen (apps/mobile/src/tickets/verification/VerificationScreen.tsx) — the SE half of the verification surface. Unwalkable: se.north has 0 rows on /me/tickets (shared primer), and no mobile instrument is available in this stage.
- **⚠ weak anchor:** 2.35M TEQ of this estimate rests on cohorts with n<10
- **⚠ cross-check split:** top-down 3.60M vs bottom-up 22.19M (6.16×) — module is LOW-CONFIDENCE

## All gaps, one line each
| id | sev | ⚠ | what (plain words) | type | size | P50 | conf |
|---|---|---|---|---|---|---|---|
| V-01 | S3 | ? | Mark auto-recovery on a no-pings row leaves verdict stale | FIX | — | — | MED |
| V-02 | S3 | ☠ | Fraud-flag list is not zone-scoped; a ZM reads every zone | SECURITY | — | — | HIGH |
| V-04 | S3 |  | No un-escalate: a wrongly escalated ticket cannot be returned | NEW | M | 3.09M | HIGH |
| V-03 | S2 |  | Fraud-flags endpoint built and tested but no screen calls it | COMPLETE | S | 2.17M | MED |
| V-05 | S2 |  | Escalation reason reaches no report, only the audit log | INTEGRATION | M | 4.08M | HIGH |
| V-06 | S2 |  | Countdown shows overdue for windows the sweep will never expire | FIX | M | 2.16M | HIGH |
| V-07 | S2 |  | Auto-recovery close needs no reason and no confirmation | UX | S | 2.11M | MED |
| V-08 | S1 |  | Verification module has zero live rows; every walk is fixture-blocked | DATA | M | 0.69M | HIGH |

Evidence: `.work/verification/` · estimate: `.work/verification/estimate.json`
