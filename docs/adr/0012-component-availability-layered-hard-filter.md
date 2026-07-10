# ADR-0012: Component Availability Is a Layered Hard Filter — Common Kit Always, Expected Component When Known

## Status

Accepted

## Context

An SE arriving at a plant without the parts needed to fix a device wastes a full travel day. Two filtering options were considered: filter only on per-ticket expected components (misses the risk of a depleted van with the right specialty part but a missing fuse or SIM), or filter only on common kit (ignores obvious predictive signals from repeat-failure history and prior diagnosis).

## Decision

A Ticket passes the component Hard Filter only if **both** conditions hold:

**(i) Common Kit** — the SE must carry the full configurable baseline kit (cables, SIM, antenna, fuse — Admin-defined via `COMMON_KIT_DEFINITION`). A missing kit item grounds the SE for Recommender purposes — no Tickets are assignable until restock.

**(ii) Expected Component** — when a Ticket has one or more `expected_component` rows (populated by: repeat-failure detection, prior partial diagnosis, Install setup, or `WAITING_COMPONENT` resubmit), every expected component must be available in the SE's **van stock** or in the SE's home **Zone Warehouse** (pickable as a morning detour). First-time Troubleshoot Tickets with no signal carry no expected component; this leg is a no-op for them.

Tickets failing either leg do **not disappear** — they enter a **Component-Blocked Queue** on the Zonal Manager dashboard, with missing parts and Warehouse Manager action status visible.

The Recommender's morning batch can plan a Zone Warehouse pickup as the SE's first stop if an expected component is in the warehouse but not the van.

## Consequences

- `COMMON_KIT_DEFINITION` table (Admin) lists kit items.
- `SE_VAN_STOCK` table tracks per-SE current quantities.
- `Ticket.expected_component` becomes a multi-row child table populated by the named triggers.
- A "van missing kit item" condition raises a notification to both the SE and the Warehouse Manager — Common Kit completeness is shared accountability.
- The Component-Blocked Queue gives warehouse purchasing direct visibility into what's costing field productivity.
