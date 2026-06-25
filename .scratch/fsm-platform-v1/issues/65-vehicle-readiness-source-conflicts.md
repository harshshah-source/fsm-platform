# 65 — Vehicle readiness source (AutoPlant LR-Date/Next-Trip) + ZM Readiness Conflicts page + AC#6 resolution

Status: ready-for-agent
Type: AFK

## What to build

The vehicle-readiness data source and the ZM readiness-conflict surface — the deferred readiness legs
of Issue 28 (AC#5 hint render, AC#6 conflict resolution) and the Recommender's hardcoded `UNKNOWN`
seam (`recommender.service.ts:111`).

Derive **vehicle readiness** (`READY` / `ON_TRIP` / `STALE` / `UNKNOWN`; `UPCOMING_TRIP` colour hint)
from AutoPlant snapshot fields (**LR Date / Next Trip** + current system time) — the
external-integration seam (AutoPlant DB, Issue 04 ingestion). Feed the derived readiness into the
Recommender Hard Filter (replacing the `UNKNOWN` stub) and the ZM **Readiness** page
(`v2-reference/10-readiness.png`), where `STALE` / `UNKNOWN` surface as readiness-conflict signals the
ZM resolves. Also wire AC#2 **"resurface at expected date"** — re-eligible a VU-paused Ticket for
scheduling at its `expected_from`.

## Authority decision (RESOLVED 2026-06-25 — HITL)

Issue 28 **AC#6** originally named `WAITING_CONFIRMATION` as a readiness-conflict state implying a
per-ticket confirmation gate, contradicting **CONTEXT.md → Hard Filter** (`STALE`/`UNKNOWN` resolved
"via ON_SITE capture or a Vehicle Unavailability Report, **not a per-Ticket confirmation gate**").
**Decision: field path (CONTEXT-aligned).** Drop `WAITING_CONFIRMATION`; **no** new readiness state,
**no** enum/CONTEXT change. The ZM resolves `STALE`/`UNKNOWN` readiness conflicts via the existing
field path (ON_SITE capture or a filed Vehicle Unavailability Report). The Readiness page is a
**signal/visibility** surface, not a confirmation gate. See
`docs/progress/28-vehicle-unavailability-dual-sla.md`. **AutoPlant LR-Date / Next-Trip is the external
seam** — build the readiness derivation against the seam shape and mock the source until AutoPlant data
is wired (Issue 04 lineage).

## Acceptance criteria

- [ ] Vehicle readiness derived from AutoPlant LR-Date / Next-Trip + system time; persisted/queryable (mock the source at the seam)
- [ ] Recommender Hard Filter consumes real readiness (replaces the `UNKNOWN` stub); only `ON_TRIP` drops
- [ ] ZM Readiness page (`10-readiness.png`) lists readiness conflicts (`STALE` / `UNKNOWN`) as **signals** (no confirmation gate)
- [ ] Readiness conflicts cleared via the existing field path (ON_SITE capture or a filed VU report) — no new readiness state
- [ ] VU-paused Ticket resurfaces for scheduling at `expected_from` (Issue 28 AC#2 second leg)

## UI surfaces

- **Admin:** ZM Readiness page (`/readiness/conflicts` or equivalent) — readiness-conflict list + resolution. Owned by this issue.
- **Mobile:** readiness hint *source* feeds Issue 64's Ticket Detail chip.

## Reference

- `docs/ui/desktop/v2-reference/10-readiness.png`

## Blocked by

- #28
- #04
