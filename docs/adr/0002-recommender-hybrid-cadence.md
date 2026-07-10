# ADR-0002: Recommender Cadence Is Hybrid — Daily Plan + Event-Triggered Re-plan

## Status

Accepted

## Context

The Recommender must balance two competing needs: plan stability (SEs need a coherent route for the day) and responsiveness (CRITICAL devices appearing mid-shift cannot wait until tomorrow). Three cadence models were evaluated: periodic cron (every 15–60 min), pure daily plan, and hybrid.

A periodic cron destroys plant-clustering by constantly reshuffling assignments and gives SEs a moving target. A pure daily plan fails for CRITICAL devices that enter the queue mid-shift — exactly when SLA-deficit emergencies happen.

## Decision

The Recommender runs in two modes:

- **Morning Batch** (~06:30 IST, before shift start): produces a full Day Plan per SE — an ordered, plant-clustered, capacity-bounded list of Tickets — for Zonal Manager review and approval before shift start.
- **Intra-day Re-plan**: fires only on **Qualifying Events**, never on a fixed cron. Today's working set of Qualifying Events:
  - A new Ticket entering `CRITICAL` or `HIGH_CRITICAL` bucket.
  - An SE completing their Day Plan with capacity remaining.
  - An SE going offline or shift-cut.

Unassigned Tickets at midnight roll into the next morning's batch. A new CRITICAL Ticket at 23:50 rolls into the next morning's batch rather than firing a 23:51 re-plan to an off-shift SE.

## Consequences

- "Today's Plan" is a first-class entity on the SE mobile home screen, not a derived view.
- The Recommender requires an explicit, maintained list of Qualifying Events.
- The intra-day path uses the SE Acceptance flow (see ADR-0016) rather than auto-approve.
- Plan stability is preserved for routine work; the system reacts only when reality changes meaningfully.
