# 40 — Soft Inactive Count trend

Status: ready-for-agent
Type: AFK

## What to build

The Soft Inactive Count signal and its trend view (part of `/reports`). Recomputed twice daily per zone by the `SoftInactiveCount` worker; this is the intraday operational signal that drives Recommender mode switching. Trend view shows the twice-daily series per zone so Operations Head can monitor the signal over time.

## Acceptance criteria

- [ ] Soft Inactive Count recomputed twice daily per zone
- [ ] Count drives Recommender mode switching
- [ ] Trend view renders the per-zone twice-daily series for Operations Head
- [ ] Served from summary data, not raw per-request scans

## Blocked by

- #05
