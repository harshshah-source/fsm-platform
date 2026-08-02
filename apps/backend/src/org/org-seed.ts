import { $Enums, type PrismaClient } from '../generated/prisma/client';
import {
  normalizeZoneKey,
  ZONE_MAPPING_SOURCE_FIELD,
} from '../ingestion/autoplant/mapping-table-zone-resolver';

/**
 * Canonical reference/org seed for downstream slices (Issue 02 AC#7). Idempotent: every row is
 * keyed by a natural key and upserted (or guarded by existence), so re-running never duplicates.
 * This is the dev/test fixture the Recommender (Issue 10), SLA engine (Issue 05), and dashboards
 * (Issue 06) build against. Login accounts stay in the in-memory auth store until that is swapped
 * to Postgres, so this seeds reference data, not credentials.
 */

// Operational zones (FSM-owned partition, ADR-0018 one ZM per zone). UNZONED is the holding zone the
// R6 translation layer lands pending/ambiguous AutoPlant plants in until an admin maps their raw value.
const SEED_ZONES = ['North', 'South', 'East', 'West', 'UNZONED'];

// Canonical zone_name crosswalk (R6). Production evidence (2026-07, ap_masters.mst_plant.zone_name):
// ~98.7% of plants carry one of these four families — "West Zone"/"West"/"WEST" alone cover ~97% —
// so pre-mapping the normalized keys lets a fresh install zone the master with zero admin work.
// Deliberately NOT seeded: "Central" (business decision pending), NA/blank (`__blank__` → UNZONED),
// and junk — those stay on the PENDING discovery queue. Seeding is create-only: a reseed never
// clobbers an Ops remap/IGNORE on an existing row.
const SEED_ZONE_MAPPINGS: { raw: string; zone: string }[] = [
  { raw: 'West Zone', zone: 'West' }, // dominant production spelling of the family
  { raw: 'North', zone: 'North' },
  { raw: 'South', zone: 'South' },
  { raw: 'East', zone: 'East' },
];

// Canonical tier list and order as data (Issue 157 AC-1, PRD canon CONTEXT.md:315 — Platinum > Gold
// > Silver, rank 1 = highest priority). Standalone reference table: no FK from any other model,
// which is what let this fall through — nothing failed loudly when it was never seeded (#185).
const SEED_TIERS: { name: $Enums.CompanyTier; rank: number }[] = [
  { name: 'PLATINUM', rank: 1 },
  { name: 'GOLD', rank: 2 },
  { name: 'SILVER', rank: 3 },
];

const SEED_COMPANIES: { name: string; tier: $Enums.CompanyTier; rank: string }[] = [
  { name: 'Acme Logistics', tier: 'PLATINUM', rank: 'A' },
  { name: 'Globex Transport', tier: 'GOLD', rank: 'B' },
  { name: 'Initech Freight', tier: 'SILVER', rank: 'C' },
];

const SEED_SLA_RULES: {
  scope: string;
  key: string;
  submit: number;
  verify: number;
  escalate: number;
}[] = [
  { scope: 'company_tier', key: 'PLATINUM', submit: 30, verify: 60, escalate: 120 },
  { scope: 'company_tier', key: 'GOLD', submit: 60, verify: 120, escalate: 240 },
  { scope: 'company_tier', key: 'SILVER', submit: 120, verify: 240, escalate: 480 },
];

const SEED_WEIGHT_SET = 'v1';
// Within-(Tier×Bucket)-cell weighted-score components (ADR-0003 layer 4, read by the Recommender,
// Issue 10). company_tier/device_bucket are the upstream gates, kept for back-compat / reporting.
const SEED_WEIGHTS: { component: string; weight: number }[] = [
  { component: 'company_tier', weight: 0.4 },
  { component: 'device_bucket', weight: 0.3 },
  { component: 'sla_urgency', weight: 0.3 },
  { component: 'company_priority_rank', weight: 0.4 },
  { component: 'dispatch_urgency', weight: 0.3 },
  { component: 'repeat_failure_penalty', weight: 0.2 },
  { component: 'distance', weight: 0.1 },
];

// componentId is a placeholder until component_master lands (Issue 21); the kit list itself is
// the canonical "cables / SIM / antenna / fuse" from the AC.
const SEED_COMMON_KIT: { componentId: number; minQty: number; name: string }[] = [
  { componentId: 1, minQty: 1, name: 'Cable' },
  { componentId: 2, minQty: 1, name: 'SIM' },
  { componentId: 3, minQty: 1, name: 'Antenna' },
  { componentId: 4, minQty: 2, name: 'Fuse' },
];

// Representative admin geography for the Floating-SE territory selector (Issue 09). A real but small
// subset — the full ~700-district authoritative load is a separate reference-data task. The
// resolution logic (plant_eligible_floating_se MV) is independent of this breadth.
const SEED_GEOGRAPHY: { state: string; regions: { name: string; districts: string[] }[] }[] = [
  {
    state: 'Maharashtra',
    regions: [
      { name: 'Konkan', districts: ['Mumbai City', 'Mumbai Suburban', 'Thane', 'Raigad'] },
      { name: 'Vidarbha', districts: ['Nagpur', 'Amravati'] },
      { name: 'Western Maharashtra', districts: ['Pune', 'Kolhapur'] },
    ],
  },
  {
    state: 'Gujarat',
    regions: [
      { name: 'Saurashtra', districts: ['Rajkot', 'Jamnagar'] },
      { name: 'South Gujarat', districts: ['Surat', 'Valsad'] },
    ],
  },
  {
    state: 'Karnataka',
    regions: [{ name: 'Bangalore Division', districts: ['Bengaluru Urban', 'Bengaluru Rural'] }],
  },
];

export interface OrgSeedSummary {
  zones: number;
  zoneMappings: number;
  plants: number;
  companies: number;
  tiers: number;
  slaRules: number;
  scoringWeights: number;
  commonKit: number;
  regions: number;
  districts: number;
}

export async function seedOrgReferenceData(prisma: PrismaClient): Promise<OrgSeedSummary> {
  const zoneIdByName = new Map<string, bigint>();
  for (const name of SEED_ZONES) {
    const zone = await prisma.zone.upsert({ where: { name }, create: { name }, update: {} });
    zoneIdByName.set(name, zone.zoneId);
  }

  // Canonical zone_name → zone crosswalk rows (MAPPED). The seed only ever decides where no admin
  // decision exists: it creates absent rows as MAPPED and promotes PENDING (undecided, sync-discovered)
  // rows, but never touches a MAPPED (remapped) or IGNORED row — an Ops decision survives every reseed.
  for (const m of SEED_ZONE_MAPPINGS) {
    const key = normalizeZoneKey(m.raw);
    await prisma.zoneMapping.upsert({
      where: {
        sourceField_sourceValueKey: {
          sourceField: ZONE_MAPPING_SOURCE_FIELD,
          sourceValueKey: key,
        },
      },
      create: {
        sourceField: ZONE_MAPPING_SOURCE_FIELD,
        sourceValueKey: key,
        sourceValueRaw: m.raw,
        fsmZoneId: zoneIdByName.get(m.zone)!,
        status: 'MAPPED',
      },
      update: {},
    });
    await prisma.zoneMapping.updateMany({
      where: { sourceField: ZONE_MAPPING_SOURCE_FIELD, sourceValueKey: key, status: 'PENDING' },
      data: { fsmZoneId: zoneIdByName.get(m.zone)!, status: 'MAPPED' },
    });
  }

  const north = await prisma.zone.findUniqueOrThrow({ where: { name: 'North' } });

  // Plant name is not unique, so guard by (name, zone) before creating.
  const plantName = 'North Plant 1';
  const existingPlant = await prisma.plant.findFirst({
    where: { name: plantName, zoneId: north.zoneId },
  });
  if (!existingPlant) {
    await prisma.plant.create({ data: { name: plantName, zoneId: north.zoneId } });
  }

  for (const t of SEED_TIERS) {
    await prisma.tier.upsert({
      where: { name: t.name },
      create: { name: t.name, rank: t.rank },
      update: { rank: t.rank },
    });
  }

  // Company name is not unique either — guard by name.
  for (const c of SEED_COMPANIES) {
    const exists = await prisma.company.findFirst({ where: { name: c.name } });
    if (!exists) {
      await prisma.company.create({
        data: { name: c.name, companyTier: c.tier, companyPriorityRank: c.rank },
      });
    }
  }

  for (const r of SEED_SLA_RULES) {
    await prisma.slaRuleConfig.upsert({
      where: { scope_key: { scope: r.scope, key: r.key } },
      create: {
        scope: r.scope,
        key: r.key,
        submitWithinMinutes: r.submit,
        verifyWithinMinutes: r.verify,
        escalateAfterMinutes: r.escalate,
      },
      update: {
        submitWithinMinutes: r.submit,
        verifyWithinMinutes: r.verify,
        escalateAfterMinutes: r.escalate,
      },
    });
  }

  for (const w of SEED_WEIGHTS) {
    await prisma.priorityRuleConfig.upsert({
      where: {
        weightSetRef_component: { weightSetRef: SEED_WEIGHT_SET, component: w.component },
      },
      create: { weightSetRef: SEED_WEIGHT_SET, component: w.component, weight: w.weight },
      update: { weight: w.weight },
    });
  }

  for (const k of SEED_COMMON_KIT) {
    // The kit component must exist in component_master (Issue 21 FK).
    await prisma.componentMaster.upsert({
      where: { componentId: BigInt(k.componentId) },
      create: { componentId: BigInt(k.componentId), name: k.name },
      update: {},
    });
    await prisma.commonKitDefinition.upsert({
      where: { componentId: BigInt(k.componentId) },
      create: { componentId: BigInt(k.componentId), minQty: k.minQty },
      update: { minQty: k.minQty },
    });
  }

  // `component_master.component_id` is BIGSERIAL, but the kit rows above are inserted with EXPLICIT
  // ids (1–4) — which does NOT advance the sequence. On a fresh database the next auto-generated id
  // would collide with a seeded one (unique-constraint error). Advance the sequence past the seeded
  // rows so callers that create a component_master without an id (the app, tests) get a free id.
  await prisma.$executeRawUnsafe(
    `SELECT setval(pg_get_serial_sequence('component_master', 'component_id'), (SELECT COALESCE(MAX(component_id), 1) FROM component_master))`,
  );

  // Geography: regions keyed by unique name, districts by (name, state); both upserted idempotently.
  let regionCount = 0;
  let districtCount = 0;
  for (const geo of SEED_GEOGRAPHY) {
    for (const reg of geo.regions) {
      const region = await prisma.region.upsert({
        where: { name: reg.name },
        create: { name: reg.name, state: geo.state },
        update: { state: geo.state },
      });
      regionCount++;
      for (const districtName of reg.districts) {
        await prisma.district.upsert({
          where: { name_state: { name: districtName, state: geo.state } },
          create: { name: districtName, state: geo.state, regionId: region.regionId },
          update: { regionId: region.regionId },
        });
        districtCount++;
      }
    }
  }

  // The `plant_eligible_floating_se` materialized view is created WITH NO DATA (Issue 09 migration),
  // so a brand-new database has an UNPOPULATED matview and any `SELECT` against it raises Postgres
  // 55000 ("has not been populated"). One plain (non-concurrent) refresh populates it — 0 rows is a
  // valid populated state — after which readers work and `REFRESH ... CONCURRENTLY` becomes allowed.
  await prisma.$executeRawUnsafe('REFRESH MATERIALIZED VIEW "plant_eligible_floating_se"');

  return {
    zones: SEED_ZONES.length,
    zoneMappings: SEED_ZONE_MAPPINGS.length,
    plants: 1,
    companies: SEED_COMPANIES.length,
    tiers: SEED_TIERS.length,
    slaRules: SEED_SLA_RULES.length,
    scoringWeights: SEED_WEIGHTS.length,
    commonKit: SEED_COMMON_KIT.length,
    regions: regionCount,
    districts: districtCount,
  };
}
