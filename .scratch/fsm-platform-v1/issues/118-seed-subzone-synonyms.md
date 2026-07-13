# 118 — Seed the AutoPlant sub-zone synonyms in `SEED_ZONE_MAPPINGS`
Status: ready-for-agent
Type: small backend data/seed change

> Source: zone-application session 2026-07-13 (Phase 3). The four sub-zone crosswalk rows
> (`east a`/`east b` → East, `west a`/`west b` → West) were inserted directly into `zone_mappings`
> as MAPPED (one-off data insert — no PENDING rows existed because AutoPlant's `zone_name` is blank
> for the affected plants; values came from the field Excel "SUMMARY REPORT Deployed (3)").
> A fresh install / reseeded DB won't have them.

## Scope

1. Add the four rows to `SEED_ZONE_MAPPINGS` (`apps/backend/src/org/org-seed.ts:25`), same shape as
   the existing four (`West Zone`→West etc.). Seeding is create-only, so re-seeding an existing DB
   never clobbers an Ops remap.
2. Extend `org-seed.e2e-spec.ts` accordingly.
3. Deliberately NOT in scope: "Central" (business decision still pending — `org-seed.ts:22`).

## Evidence

- `zone_mappings` in dev now carries the 4 rows MAPPED (inserted 2026-07-13, see audit trail of the
  session; the 47-plant application itself used `plant_zone_overrides`, not these rows).
- `normalizeZoneKey` (`mapping-table-zone-resolver.ts:33-37`) produces exactly these keys from the
  raw sub-zone strings.
