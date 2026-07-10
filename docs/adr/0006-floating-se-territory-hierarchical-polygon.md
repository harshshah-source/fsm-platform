# ADR-0006: Floating SE Territory Combines Hierarchical Geography with Polygon Overlay

## Status

Accepted

## Context

A Floating SE's coverage area cannot be expressed purely by district lists (~700 Indian districts — admin nightmare), purely by polygons (too engineering-heavy, no clean reporting boundary), or purely by administrative hierarchy (cannot express sub-district splits that real Floating-SE patches require). A hybrid is needed.

## Decision

A Floating SE's **Territory** is described by two complementary mechanisms, either or both populated per SE:

- **Hierarchical coverage** — a set of State / Region / District identifiers. Readable, admin-friendly, how operations actually describes an SE's patch.
- **Polygon coverage** — a lat-long polygon (or set of polygons) for cases where hierarchical units are too coarse (e.g., metro Mumbai but not rural Maharashtra).

Membership is the **union**: a Plant is in an SE's Territory if it falls inside any covered District *or* any covered polygon.

Two Floating SEs with overlapping Territories tie-break in the Recommender by: (a) capacity, (b) distance-from-previous-stop, (c) hierarchy_match preferred over polygon_match.

## Consequences

- The backend stack requires **PostGIS** (or equivalent) as a hard dependency for `ST_Contains` / `ST_Within` lookups.
- A precomputed materialised view `plant_eligible_floating_se(plant_id, engineer_id)` refreshed nightly and on coverage edits keeps the hot path an index lookup.
- `Plant.location` must carry both `district_id` and `lat/lon`.
- Admin UX should let the user start hierarchical (tick districts) then optionally draw a polygon.
- Reporting on a Floating SE's coverage area is humanely describable via the hierarchical component.
