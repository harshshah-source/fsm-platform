# auth-access

STATUS: estimated  updated 2026-09-02
COMPLETE: 50%  ->  67% after backlog
GAPS: 11 (S4 0 · S3 5 · S2 4 · S1/S0 2)  DANGEROUS 5 · needs-verify 2
EST: P50 36.97M · P80 73.95M TEQ · size XL · risk HIGH · conf LOW · basis borrowed
VERDICT: Acting-as-another-manager is not scoped at all in practice — any CSM or Ops Head can silently see, and in most write paths silently change, a zone that isn't theirs, while the screen tells them they're safely boxed in.

## The picture
Auth-access is half built: login/refresh/logout are a solid spine, but the acting-scope capability that the whole zone model leans on is unenforced where it matters most. The headline lack is the gate itself — `role_unavailability` has never held a row, so the "only act when the real manager is unavailable" rule never actually fires, and zone input isn't validated (a bad zone silently reverts to pan-India). The capability score is worse than the spine suggests: session mechanics work end to end, but scoping, audit attribution, and read/write parity around acting all fail, and one of the three failures (AA-11) means even a "correctly" acting manager can write outside their zone.

## What matters, ranked
- 🟠 Any CSM or Ops Head can act in any zone while that ZM merely exists (AA-01, S3, ☠) — `role_unavailability` holds zero rows ever, so the gate never closes; zone `99` is accepted silently, zone `abc` NaNs and the header is dropped, leaving pan-India data on screen while the operator believes they're zoned. Missing is **when**, not **who** — a ZM sending the same header stayed correctly clamped, and WM got 403.
- 🟠 Acting-scope writes carry no acting attribution, and the report that should catch it can't (AA-02 folds AA-03, S3, ☠) — paired audit rows #34793 (CSM acting, NULL) vs #34794 (OH acting, stamped) prove it; `acted_as_role` is non-null on exactly 1 of 34,758 rows. The backup-share report reading ~0% has a second, independent cause layered on top — 30 of 31 `acting_zone` rows in it come from bulk-unassign, where that column means the *target* zone, not an acting session — so fixing AA-02 alone will not fix the report.
- 🟠 Acting narrows reads but never writes (AA-11, S3, ☠) — only 5 controllers inject the acting scope; a CSM "acting in zone 2" closed a zone-1 ticket for real.
- 🟠 Login has no rate limit, no lockout, no attempt counter (AA-04, S3, ☠) — 12 wrong passwords in 548ms, then the correct one succeeds instantly.
- 🟢 Session mechanics genuinely work end to end — refresh rotation, replay rejection, and logout revocation all reproduce correctly.
- ⚠ basis borrowed — every TEQ figure here comes from a 272-run cohort measured on a different repo (TS/Next/Prisma ERP), never on fsm-platform.
- ⚠ cross-check split 10.27× (top-down 3.60M vs bottom-up 36.97M) — top-down prices this as screen work; these gaps are control-shaped (permission gates, audit columns, a missing scope check), not screen-shaped, so the two numbers don't average into one.
- ⚠ 2.26M TEQ of this estimate sits on weak (n<10) cohorts — AA-06's integration lane is n=6, its data lane n=4 — and AA-01, AA-06, AA-07 each price over 3M as a single line despite being multi-part control fixes, not one gap apiece.

## Numbers
| | |
|---|---|
| functionally complete | 50% now → 67% after backlog |
| backlog | P50 36.97M / P80 73.95M TEQ · conf LOW |
| cheapest big fix | AA-02 at 2.16M — Acting-scope writes recorded as if the manager did them himself |
| engineering size / risk | XL / HIGH — **not a schedule** |

## Not finished / needs you
- **needs-verify:** AA-08, AA-09
- **your call:** none
- **not walked:** AA-08 sidebar nav while acting — rendered-screen only; one browser walk ~708k TEQ (login csm@fsm.test, enter acting from the TopBar zone picker, screenshot Sidebar + Manager Dashboard); AA-09 acting banner label 'Zone 2' vs 'South' — same single browser walk as AA-08; AA-05 no admin page writes POST /api/role-unavailability — C4 asymmetry already E2-settled by S2 static read; walking the absent page can only re-prove an absence; AA-06 >24h ZM heartbeat auto-activation — S2 resolved C8 to NOT_STARTED; E2-settled, no walk owed; The other 10 of the 11 literal actedAsRole:null controller sites — one (tickets auto-recovery-close) was walked end to end and the mechanism is a shared literal, so the remaining 10 are the same defect; walking each would create real state changes (leave approvals, intraday reassignments, device writes) for no new evidence; Mobile login shell (apps/mobile/src/auth/LoginScreen.tsx) — no Expo client running on this box; the SE persona also has 0 seeded day-plan rows (shared primer), so an SE session walk is UNTESTABLE until a day plan is created; X-Device-Id one-device rule (auth.controller.ts:27) — no client sends a stable device id, so the rule is inert by construction; confirming inertness live would need a second real client
- **⚠ weak anchor:** 2.26M TEQ of this estimate rests on cohorts with n<10
- **⚠ cross-check split:** top-down 3.60M vs bottom-up 36.97M (10.27×) — module is LOW-CONFIDENCE

## All gaps, one line each
| id | sev | ⚠ | what (plain words) | type | size | P50 | conf |
|---|---|---|---|---|---|---|---|
| AA-01 | S3 | ☠ | Any CSM or Ops Head can act in any zone while that | SECURITY | L | 5.12M | HIGH |
| AA-02 | S3 | ☠ | Acting-scope writes recorded as if the manager did them himself | FIX | M | 1.50M | HIGH |
| AA-03 | S3 | ☠ | Backup-share report reads zero CSM backup in every zone | FIX | — | — | HIGH |
| AA-04 | S3 | ☠ | Login has no rate limit, no lockout, no attempt counter | SECURITY | S | 2.12M | HIGH |
| AA-11 | S3 | ☠ | Acting narrows five read screens; every write stays pan-India | FIX | L | 2.76M | HIGH |
| AA-05 | S2 |  | No page to mark a manager unavailable; cascade table only writable by | NEW | M | 2.11M | MED |
| AA-06 | S2 |  | Nobody is told when a manager goes missing for a day | NEW | L | 5.84M | MED |
| AA-07 | S2 |  | Entering and leaving acting mode leaves no trace anywhere | NEW | M | 3.09M | HIGH |
| AA-10 | S2 |  | No audit row for login, logout or failed sign-in | SECURITY | S | 1.99M | HIGH |
| AA-08 | S1 | ? | Sidebar keeps own-role menu while acting as zone manager | UX | — | — | MED |
| AA-09 | S1 | ? | Acting banner shows a zone number, not the name | UX | — | — | MED |

Evidence: `.work/auth-access/` · estimate: `.work/auth-access/estimate.json`
