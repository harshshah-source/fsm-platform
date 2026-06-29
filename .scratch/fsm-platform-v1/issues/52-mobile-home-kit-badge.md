# 52 — SE mobile Home: Van Stock + Common-Kit badge  [SUPERSEDED]

Status: superseded → #55
Type: AFK · Mobile

## Superseded

This issue (the SE Home Common-Kit badge, a partial of Issue 21 AC#5) is **superseded by #55**
(M1: SE Home), whose acceptance criteria render the Common-Kit badge from `/api/me/van-stock` in full
("closes Issue 21 AC#5 UI; supersedes 52"). The van-stock list itself is owned by #60 (M6: Stock).

**Why:** #52 predated the consolidated M-series Home/Stock split. Keeping it as a separate slice would
duplicate #55's kit-badge AC and #60's van-stock list. No scope is lost — every #52 behaviour lives in
#55 (Home kit badge) and #60 (Stock list).

**Do not implement #52.** Build #55 + #60 instead. Retained (not deleted) to preserve project history
and the original INDEX reference.

## Replacement mapping

- Common-Kit badge on Home → **#55** (AC: "Common-Kit status badge rendered from `/api/me/van-stock`").
- Van-stock list / completeness → **#60** (M6: Stock / Inventory).

## Blocked by

- (none — superseded)
