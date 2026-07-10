# ADR-0024: SE Activity Ping Is Action-Triggered, Not a Fixed-Interval Timer

## Status

Accepted — **the "Recommender Hard Filter (15 min)" consumer below is superseded by CONTEXT.md
Decisions §3 & §16 (revised 2026-06-09)**: activity-ping staleness is NOT a Hard Filter and never
gates candidate scoring. The **action-triggered ping mechanism** and the **1h `OFFLINE` Activity
Status display label** remain in force.

## Context

The SE mobile app must signal to the backend when an SE is actively using the app. Originally this
fed two consumers; only the second survives:

1. ~~**Recommender Hard Filter (15 min):** intra-day candidate scoring skips any SE whose
   `last_activity_at` is older than 15 min.~~ **Removed (2026-06-09).** Pings never gate scoring;
   intra-day unreachability is handled by the Acceptance Timeout + reroute (ADR-0016, CONTEXT §16).
2. **SE Activity Status (1 h):** the derived `OFFLINE` label on the Zonal Manager dashboard flips when no activity ping has been recorded for 1 h. This means "app not recently used" — not "SE is not working."

Two implementation approaches were considered:

- **Fixed-interval timer:** the app sends a signal every ~N minutes regardless of SE activity.
- **Action-triggered:** any user-initiated action in the app updates `last_activity_at` on the backend.

## Decision

Use **action-triggered SE Activity Pings**. Any SE-initiated app action updates `ENGINEER_MASTER.last_activity_at`. No fixed background timer is used.

Actions that trigger a ping: opening a Ticket, tapping VIEWED / ON_SITE / TROUBLESHOOT_STARTED, submitting a form, confirming component receipt, scanning a QR code, refreshing the app, syncing queued offline actions, or any other deliberate user event.

Background processes (offline queue auto-sync, push notification receipt) do **not** trigger an activity ping — only deliberate user actions count.

**Activity pings are for dashboard visibility and audit only.** They must not auto-clear Soft States. An absent ping does not mean the SE has left a vehicle or stopped working — the SE may be working offline or in a no-network area.

## Consequences

- `ENGINEER_MASTER.last_activity_at` reflects the last time the SE actively used the app, not merely that their device was powered on or the app was foregrounded.
- A completely idle SE — phone pocketed, app open but untouched — goes stale at the 15-min mark for **display purposes only** and is **not** excluded from intra-day candidate scoring (correction 2026-06-09; CONTEXT §3, §16). An SE who has stopped interacting with the app may simply be working offline or in a no-network area; if genuinely unreachable they won't tap Accept, and the Acceptance Timeout reroutes the insertion (ADR-0016).
- **ON_SITE and TROUBLESHOOT_STARTED Soft States do not expire by time and are not cleared by activity ping absence.** Those states are resolved only by explicit SE or ZM actions (see CONTEXT.md → Soft State). A missing activity ping while ON_SITE simply means the SE has not sent a recent app event — they may be on-site with no connectivity.
- **Amends ADR-0016:** the phrase "updated by mobile app every ~5 min" is superseded by this decision. The 15-min and 1-hour thresholds in ADR-0016 remain unchanged; only the update mechanism changes. The field is renamed from `last_heartbeat_at` to `last_activity_at`.
- **Terminology:** the concept was previously called "Heartbeat." That term is replaced by **SE Activity Ping** throughout the domain model to avoid implying a continuous background signal. "Heartbeat" must not be used in code, UI, or documentation going forward.
- On React Native / Expo, this avoids iOS background execution constraints that make reliable fixed-interval timers difficult without special entitlements.
- Automated background tasks (offline queue flush, push notification handlers) must explicitly not call the activity-ping endpoint.
- Reports that show "SE was last active at HH:MM" derive from `last_activity_at` and accurately reflect deliberate user activity.
