# ingestion

STATUS: gaps  updated 2026-09-02
COMPLETE: 56%  ->  78% after backlog
GAPS: 7 (S4 0 · S3 4 · S2 2 · S1/S0 1)  DANGEROUS 2 · needs-verify 0
EST: not yet estimated (S4 has not run)
VERDICT: A failing ingestion run is visible; an ingestion run that simply stops is not — and every health signal that is currently red is dropped before it reaches the screen.

## The picture
This module feeds every work item in the platform and nobody sits in front of it, so the only question that
matters is whether silent failure surfaces. A run that fails does: the heartbeat reaper and the banner are
genuinely well built. A pipeline that stops does not — every detector counts runs that happened, so zero runs
reads as healthy rather than unknown. Worse, the admin client drops three whole sections of the health
payload, and all three are red right now: reconciliation off by 15,594 vehicles, 3,376 devices missing, sync 21 hours stale.

## What matters, ranked
- 🟠 departed devices silently close tickets and no role — Operations Head included — ever sees it (ING-01, S3, DANGEROUS, five not-found checks recorded)
- 🟠 if the ingestion cron stops firing nothing alerts: a 25-hour-old snapshot renders as the calm healthy line, reporting healthy rather than unknown (ING-03, S3, confirmed live)
- 🟠 manual sync, pipeline and snapshot triggers write no audit row at all (ING-05, S3, DANGEROUS) — guard verified real, audit verified absent
- 🟠 the health page drops connectivity, freshness age and drift; all three sections are red in the live payload and none reaches a pixel (ING-02, S3, confirmed live) — **the cheapest big win in the survey: one client edit unlocks three capabilities**
- 🟠 warehouse and engineer roles get no freshness banner at all, silently swallowed (ING-08, S2, confirmed live)
- 🟢 **failure detection is genuinely good** — the heartbeat reaper, shared streak derivation and the every-page banner all work; this module fails on absence, not on error
- ⚠ ING-09 is dev-process, not backlog: the running backend predates uncommitted work, so one section is untestable until a restart on HEAD
- ⚠ LOW confidence, **borrowed** anchors; cross-check split 3.76× — the narrowest here, because this module's cost genuinely is partly screen-shaped

## Numbers
| | |
|---|---|
| functionally complete | 56% now → 78% after backlog |
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
| ING-01 | S3 | ☠ | Departed devices silently close tickets, no manager ever sees it | COMPLETE | — | — | MED |
| ING-02 | S3 |  | Integration health page drops connectivity, freshness age, drift sections | COMPLETE | — | — | MED |
| ING-03 | S3 |  | If the ingestion cron stops firing, nothing ever alerts | NEW | — | — | MED |
| ING-05 | S3 | ☠ | Manual sync, pipeline and snapshot triggers write no audit row | FIX | — | — | MED |
| ING-04 | S2 |  | Run history endpoint exists but no screen reads it | COMPLETE | — | — | MED |
| ING-06 | S2 |  | Reaped run records no reason, so a wedge looks like a plain | FIX | — | — | MED |
| ING-07 | S1 |  | Partition maintenance ships off by default in every environment | NEW | — | — | MED |

Evidence: `.work/ingestion/` · estimate: `.work/ingestion/estimate.json`
