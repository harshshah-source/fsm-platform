import { $Enums, type PrismaClient } from '../generated/prisma/client';

/**
 * Canonical reference/org seed for downstream slices (Issue 02 AC#7). Idempotent: every row is
 * keyed by a natural key and upserted (or guarded by existence), so re-running never duplicates.
 * This is the dev/test fixture the Recommender (Issue 10), SLA engine (Issue 05), and dashboards
 * (Issue 06) build against. Login accounts stay in the in-memory auth store until that is swapped
 * to Postgres, so this seeds reference data, not credentials.
 */

const SEED_ZONES = ['North', 'South'];

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
  plants: number;
  companies: number;
  slaRules: number;
  scoringWeights: number;
  commonKit: number;
  regions: number;
  districts: number;
}

export async function seedOrgReferenceData(prisma: PrismaClient): Promise<OrgSeedSummary> {
  for (const name of SEED_ZONES) {
    await prisma.zone.upsert({ where: { name }, create: { name }, update: {} });
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

  return {
    zones: SEED_ZONES.length,
    plants: 1,
    companies: SEED_COMPANIES.length,
    slaRules: SEED_SLA_RULES.length,
    scoringWeights: SEED_WEIGHTS.length,
    commonKit: SEED_COMMON_KIT.length,
    regions: regionCount,
    districts: districtCount,
  };
}
