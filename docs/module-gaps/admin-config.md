# admin-config

STATUS: estimated  updated 2026-09-02
COMPLETE: 66%  ->  83% after backlog
GAPS: 13 (S4 2 · S3 4 · S2 3 · S1/S0 1)  DANGEROUS 5 · needs-verify 3
EST: P50 35.89M · P80 71.77M TEQ · size XL · risk HIGH · conf LOW · basis borrowed
VERDICT: The console can mint an account nobody can ever log into and has no working way to explain what a config change was before it was changed, even though everything it refuses to let you do, it refuses correctly.

## The picture
Admin-config is the most complete module surveyed (66% now, 83% after backlog) but its worst gap is a dead end, not a rough edge: account creation succeeds (201) and then the account can never log in, and the one self-service fix — "Forgot Password?" — is a dead `<a href="#">`. The spine and the capability score disagree here: permission enforcement (the spine) is unusually strong for a 57-endpoint module, but the capability to actually finish what the console starts — a usable password, a legible audit trail, an editable user, a reversible plant deactivation — keeps failing, so the module reads far less done in practice than 66% implies.

## What matters, ranked
- 🔴 Console-created account has no password, no invite, no token — 201 on create, 401 on every login after (AC-01, S4, ☠).
- 🔴 Plant deactivation strips day-plan stops and never tells the phone — NEEDS-VERIFY, not walked live because doing it would corrupt other walkers' evidence (AC-02, S4).
- 🟠 No reader can see what a config dial changed FROM and TO, for two independent reasons: the settings service writes no metadata AND the ops-explorer dataset registry projects no metadata column, so the assignment-threshold service's correctly-written `previousHours`/`newHours` is unreadable through the only lens that exists (AC-04, S3, ☠).
- 🟠 Backend can disable a user; the console exposes no control for it at all (AC-06, S3, ☠).
- 🟠 Only OH has any config-audit lens, and it's flag-gated — five separate not-found checks confirm there's no `/audit` route and the audit read API is ticket-scoped only (AC-05, S3).
- 🟠 A user's role or zone can never be changed after creation — no PATCH exists, a one-way door baked into the API shape (AC-07, S2).
- 🟢 Permission enforcement holds: 32 config-write probes produced 32 refusals — unusually strong for a module this size.
- ⚠ cross-check split 5.7× (top-down 6.30M treats this as screen work vs bottom-up 35.89M) — these are control-shaped gaps (missing metadata columns, missing PATCH routes, a dead auth link), not screen-shaped, so don't average the two. Over-3M gaps AC-01, AC-05, AC-07, AC-10 are each multi-part control fixes bundled into one line, not single gaps — don't sum them as if they were.

## Numbers
| | |
|---|---|
| functionally complete | 66% now → 83% after backlog |
| backlog | P50 35.89M / P80 71.77M TEQ · conf LOW |
| cheapest big fix | AC-04 at 1.85M — No reader can see what a config dial changed FROM and TO |
| engineering size / risk | XL / HIGH — **not a schedule** |

## Not finished / needs you
- **needs-verify:** AC-02, AC-08, AC-13
- **your call:** AC-09
- **not walked:** AC-02 / H-AC-3 plant-deactivation -> DayPlanNotificationOutbox hand-off — NOT walked by explicit instruction: a deactivation would corrupt other live walkers' evidence. Fixture: deactivate a plant owning >=1 BatchAssignmentTicket on today's plan, read the outbox, reactivate. Needs an exclusive window on this backend.; AC-03 plant reactivation restores nothing — same blocker as AC-02; cannot be walked without first deactivating.; AC-13 / H-AC-4 'is the threshold read fresh per run or cached?' — needs a real threshold write plus a dispatch run. Forbidden this walk (shared dial). ~8k TEQ in an exclusive window.; AC-10 / C11 Build Health page — never opened; its 'ingestion only, no device-departure' claim stays E1/LOW. Cost: read BuildHealthPage.tsx + one GET on its endpoint, ~3k TEQ.; AC-07 role/zone immutability after user creation — backend has no PATCH for role or zone (only status); not probed live because it would need a second disposable account. Stays E2.; Check 3 (persist) on every config dial except users — no write was made to plants, zones, SLA rules, tiers, scoring weights, common kit or SE coverage, by instruction. Each needs one write + one re-GET in an exclusive window, ~2k TEQ per dial.; Check 8 (downstream) for C1/C2/C3/C4/C5 — which consumer actually reads each dial was not traced live; only C6's threshold was proven to reach a dispatch run's configSnapshot.; Screen-only claims, all NEEDS-VERIFY at ~708k TEQ for one browser walk: (a) Settings -> Users page, whether the create form warns that the account has no password (LoginPage 'Forgot Password?' anchor is already E2-dead); (b) Settings -> Users row, whether any overflow menu hides a disable control that api/org.ts does not expose; (c) Ops Explorer page, whether the auditLogs dataset is offered in its dataset picker to an OH; (d) AssignmentThresholdPage as a ZM, whether canEdit:false renders read-only rather than hiding the control as the controller docstring claims.; AC-08 production value of OPS_EXPLORER_ENABLED — unreadable from this box; off-by-default confirmed in source only.
- **⚠ cross-check split:** top-down 6.30M vs bottom-up 35.89M (5.7×) — module is LOW-CONFIDENCE

## All gaps, one line each
| id | sev | ⚠ | what (plain words) | type | size | P50 | conf |
|---|---|---|---|---|---|---|---|
| AC-01 | S4 | ☠ | Console-created account has no password, cannot ever log in | COMPLETE | L | 7.21M | HIGH |
| AC-02 | S4 | ☠ | Plant deactivation strips day-plan stops, phone never told | INTEGRATION | — | — | HIGH |
| AC-03 | S3 | ☠ | Reactivating a plant restores nothing it cancelled | COMPLETE | — | — | HIGH |
| AC-04 | S3 | ☠ | No reader can see what a config dial changed FROM and TO | FIX | S | 1.12M | HIGH |
| AC-05 | S3 |  | Only OH has any config-audit lens, and it is flag-gated | NEW | M | 3.09M | HIGH |
| AC-06 | S3 | ☠ | Backend can disable a user; the console has no control | COMPLETE | S | 2.03M | HIGH |
| AC-07 | S2 |  | A user's role or zone can never be changed after creation | NEW | M | 3.09M | HIGH |
| AC-08 | S2 | ? | Reconciliation tool defaults off; on in this dev box | INTEGRATION | — | — | MED |
| AC-10 | S2 |  | Build health page shows ingestion only, not device departures | COMPLETE | M | P80 4.69M | LOW |
| AC-09 | S1 |  | Geography reference reads open to every logged-in role | SECURITY | XS | 1.46M | HIGH |
| AC-11 | null | ✗ | NOT A GAP - ZM genuinely cannot write the threshold | — | — | — | HIGH |
| AC-12 | null |  | NOT A GAP - check 6 clean across 32 config write probes | — | — | — | HIGH |
| AC-13 | null | ? | Snapshot carries effective value; fresh-read half unproven | — | — | — | MED |

Evidence: `.work/admin-config/` · estimate: `.work/admin-config/estimate.json`
