# 10 — Recommender scoring + Hard Filters + canonical sort

Status: done
Type: AFK
Progress: DONE (2026-06-21) — strict TDD slices 1–6. Backend 62 files / 205 tests, tsc clean.
Decisions: (a) Hard Filters built as pure predicates over an injected readiness seam — vehicle/kit/
availability data (issues 28/21/25) plug in later; the drop logic is real + unit-tested. (b) Scope =
per-ticket recommendation rows (precedence-select + score + reasoning + persist); day-plan grouping/
dispatch is Issue 11. (c) Floating distance-from-previous-stop deferred (needs day-plan geo) — neutral
in scoring for now. See docs/progress/10-recommender-scoring-hard-filters.md.

## What to build

The Recommender's candidate-selection engine (no dispatch yet — that is #11). Strict-precedence routing: Dedicated SE first, Multi-Plant SE second, Floating SE last (Floating engaged when primary is ON_LEAVE/OFF_SHIFT/at-capacity or the plant has no plant-mapped SE). Hard Filters drop ineligible candidates **before** scoring (ON_TRIP readiness, incomplete Common Kit, missing expected components, unavailable SEs). Note: `last_activity_at` staleness is **not** a Hard Filter — activity pings are visibility/audit only and never gate scoring (CONTEXT §3/§16, corrected 2026-06-22; the prior intra-day 15-min `HEARTBEAT_STALE` drop was removed). Then: Company Tier gate → Device Bucket tier within Company Tier → weighted score within each cell (configurable weights: company_priority_rank, vehicle dispatch urgency, repeat-failure penalty, distance) → Plant Cluster Multiplier. Canonical sort: Company Tier → Device Bucket → Company Priority Rank → Oldest Inactive → Device ID. A "why suggested?" reasoning payload (Company Tier, Device Bucket, Priority Rank, Plant Cluster Multiplier) accompanies each recommendation.

## Acceptance criteria

- [x] Strict-precedence routing (Dedicated → Multi-Plant → Floating) with documented fallback conditions
- [x] Hard Filters drop ON_TRIP / incomplete-kit / missing-component / unavailable candidates before scoring
- [x] Canonical candidate sort is deterministic and tested against a mixed input array
- [x] Weighted scoring reads configurable weights from settings; Plant Cluster Multiplier applied
- [x] Each recommendation carries a structured reasoning payload
- [x] `recommendations` rows persisted

## Blocked by

- #09
- #05
