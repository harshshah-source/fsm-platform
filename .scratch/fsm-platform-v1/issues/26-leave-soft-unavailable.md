# 26 — Leave request + SOFT_UNAVAILABLE

Status: ready-for-agent
Type: AFK

## What to build

SE-initiated availability flows. **Leave Request**: SE submits from mobile (type ON_LEAVE / WEEKLY_OFF + date range) for ZM approval; ZM receives in-app notification; SE sees PENDING badge. ZM **approves** → SE notified, `se_availability` updated, Recommender excludes the SE for the approved window before batches are generated; ZM **rejects** → SE notified with reason, can revise and resubmit. **SOFT_UNAVAILABLE flag**: SE sets a from/to window from mobile; during it the SE is excluded from intra-day candidate scoring and the ZM is notified; at `to_ts` availability auto-reverts to AVAILABLE.

End-to-end: an SE files leave, the ZM approves it, and the Recommender stops considering that SE for the window.

## Acceptance criteria

- [ ] SE submits leave (ON_LEAVE / WEEKLY_OFF + range); ZM notified; SE sees PENDING
- [ ] ZM approve updates `se_availability` and excludes the SE from candidate scoring for the window
- [ ] ZM reject notifies the SE with reason; SE can revise and resubmit
- [ ] SOFT_UNAVAILABLE window excludes the SE from intra-day scoring and notifies the ZM
- [ ] SOFT_UNAVAILABLE auto-reverts to AVAILABLE at `to_ts`

## Blocked by

- #25
