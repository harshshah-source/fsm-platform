import type { PrismaClient } from '../src/generated/prisma/client';

/**
 * DEV/TEST-ONLY mock SE seed. Service Engineers are normally admin-entered (Phase 4 `/engineers/manage`);
 * this places a realistic mock workforce where inactive devices actually are, so a watched manual funnel
 * run (`run-pipeline` → `dispatch-run`) exercises real recommendation/dispatch instead of an all-
 * UNASSIGNABLE no-op. Never run against production.
 *
 * For each zone plan it: upserts a ZM user (and points the zone's `zonalManagerUserId` at it), then
 * creates `seCount` SEs whose `se_coverage` covers that zone's highest-inactive plants (in-zone only —
 * the same rule `EngineerAdminService` enforces). Idempotent: keyed on stable `*@mock.fsm` emails, so a
 * re-run creates nothing new.
 */

export interface ZoneSeedPlan {
  zoneId: bigint;
  seCount: number;
  dailyCapacity?: number;
}

export interface ZoneSeedResult {
  zoneId: string;
  zmUserId: string;
  engineers: { seId: string; coverageType: string; plants: { plantId: string; name: string }[] }[];
}

export interface SeedSummary {
  zms: number;
  engineers: number;
  coverageRows: number;
  perZone: ZoneSeedResult[];
}

const DEFAULT_CAPACITY = 25;

/** Real ZM names for the four compass zones (canonical Title-Case names per the zones case-insensitive-unique migration). */
const ZM_NAME_BY_ZONE: Record<string, string> = {
  east: 'Suvo Nath',
  north: 'Harsh Raghav',
  south: 'Alla Lokesh',
  west: 'Kalpesh Isame',
};

/**
 * Region-flavoured Indian SE name pools, keyed by lowercased zone name. The i-th SE created in a zone
 * takes the i-th name; a zone with no pool (or more SEs than names) falls back to the generic mock label.
 * Names are illustrative dev/demo data only — enough distinct, realistic names to seed a 15-SE workforce
 * per zone without collisions. Keep in sync with `scripts/reset-reseed-ses.cjs` (the live-DB executor).
 */
const SE_NAMES_BY_ZONE: Record<string, string[]> = {
  north: [
    'Rahul Verma', 'Amit Sharma', 'Vikram Singh', 'Sandeep Chauhan', 'Manish Yadav',
    'Deepak Rana', 'Ankit Malhotra', 'Rohit Bhardwaj', 'Naveen Kumar', 'Gaurav Sethi',
    'Pankaj Tiwari', 'Sumit Chopra', 'Arun Nagpal', 'Vivek Saini', 'Nikhil Grover',
  ],
  south: [
    'Suresh Reddy', 'Karthik Nair', 'Venkatesh Iyer', 'Ramesh Rao', 'Arjun Menon',
    'Praveen Kumar', 'Naveen Krishnan', 'Sathish Babu', 'Harish Gowda', 'Vijay Prabhu',
    'Manoj Pillai', 'Dinesh Raju', 'Ganesh Murthy', 'Srinivas Chari', 'Bharath Shetty',
  ],
  east: [
    'Subhas Das', 'Arnab Ghosh', 'Debasish Roy', 'Sourav Banerjee', 'Rajat Chatterjee',
    'Bikash Mohanty', 'Prasenjit Dutta', 'Tanmoy Sen', 'Sanjib Mishra', 'Abhijit Bose',
    'Pradip Sahoo', 'Kaushik Dey', 'Nirmal Pradhan', 'Sujit Nayak', 'Anup Barman',
  ],
  west: [
    'Kalpesh Patel', 'Nilesh Desai', 'Jignesh Shah', 'Mahesh Joshi', 'Rakesh Mehta',
    'Paresh Trivedi', 'Sagar Gadhavi', 'Bhavin Parmar', 'Hardik Vyas', 'Chirag Modi',
    'Tushar Rane', 'Vishal Kulkarni', 'Yogesh Chavan', 'Ketan Bhatt', 'Nitin Gokhale',
  ],
  unzoned: [
    'Rohan Kapoor', 'Aditya Nair', 'Farhan Ahmed', 'Imran Khan', 'Vikas Choudhary',
    'Sameer Joshi', 'Aakash Menon', 'Rizwan Sheikh', 'Nitesh Kumar', 'Varun Pillai',
    'Ashish Ranjan', 'Zaid Ansari', 'Kunal Bhatt', 'Devendra Rathi', 'Siddharth Rao',
  ],
};

/** Split `items` into `n` contiguous chunks, biggest-first, each non-empty while items remain. */
function chunk<T>(items: T[], n: number): T[][] {
  const out: T[][] = Array.from({ length: n }, () => []);
  items.forEach((it, i) => out[Math.min(i, n - 1)].push(it));
  return out.filter((c) => c.length > 0);
}

export async function seedMockEngineers(prisma: PrismaClient, plans: ZoneSeedPlan[]): Promise<SeedSummary> {
  const summary: SeedSummary = { zms: 0, engineers: 0, coverageRows: 0, perZone: [] };

  for (const plan of plans) {
    const zoneId = plan.zoneId;
    const cap = plan.dailyCapacity ?? DEFAULT_CAPACITY;

    // 1) ZM for the zone (upsert by stable email) + point the zone at it. Name resolves off the
    //    zone's own name so the four compass zones get their real ZM, not a generic mock label.
    const zone = await prisma.zone.findUnique({ where: { zoneId } });
    const zmName = ZM_NAME_BY_ZONE[zone?.name.toLowerCase() ?? ''] ?? `ZM Zone ${zoneId} (mock)`;
    const zm = await prisma.user.upsert({
      where: { email: `zm-z${zoneId}@mock.fsm` },
      update: { name: zmName },
      create: {
        name: zmName,
        role: 'ZONAL_MANAGER',
        zoneId,
        phone: `+9198${zoneId}000000`,
        email: `zm-z${zoneId}@mock.fsm`,
        status: 'ACTIVE',
      },
    });
    summary.zms++;
    if (zone && zone.zonalManagerUserId == null) {
      await prisma.zone.update({ where: { zoneId }, data: { zonalManagerUserId: zm.userId } });
    }

    // 2) The zone's highest-inactive plants (in-zone coverage targets).
    const topPlants = await prisma.$queryRaw<{ plant_id: bigint; name: string }[]>`
      SELECT p.plant_id, p.name
      FROM plants p LEFT JOIN device_states ds ON ds.plant_id = p.plant_id
      WHERE p.zone_id = ${zoneId}
      GROUP BY p.plant_id, p.name
      HAVING count(*) FILTER (WHERE ds.is_inactive) > 0
      ORDER BY count(*) FILTER (WHERE ds.is_inactive) DESC
      LIMIT ${plan.seCount * 2}`;

    // 3) Distribute the top plants across `seCount` SEs (biggest plants to the first SEs).
    const buckets = chunk(topPlants, plan.seCount);
    const namePool = SE_NAMES_BY_ZONE[zone?.name.toLowerCase() ?? ''] ?? [];
    const zoneResult: ZoneSeedResult = { zoneId: String(zoneId), zmUserId: zm.userId, engineers: [] };

    for (let i = 0; i < plan.seCount; i++) {
      const plants = buckets[i] ?? [];
      const coverageType = plants.length === 1 ? 'DEDICATED' : 'MULTI_PLANT';
      const email = `se-z${zoneId}-${i + 1}@mock.fsm`;
      const name = namePool[i] ?? `SE Z${zoneId}-${i + 1} (mock)`;

      const user = await prisma.user.upsert({
        where: { email },
        update: { name },
        create: {
          name,
          role: 'SERVICE_ENGINEER',
          zoneId,
          phone: `+9197${zoneId}${String(i + 1).padStart(3, '0')}00`,
          email,
          status: 'ACTIVE',
        },
      });
      await prisma.engineerMaster.upsert({
        where: { engineerId: user.userId },
        update: { coverageType: coverageType as 'DEDICATED' | 'MULTI_PLANT', dailyCapacity: cap, isActive: true },
        create: { engineerId: user.userId, coverageType: coverageType as 'DEDICATED' | 'MULTI_PLANT', zoneId, dailyCapacity: cap, isActive: true },
      });
      summary.engineers++;

      const covered: { plantId: string; name: string }[] = [];
      for (const p of plants) {
        const existing = await prisma.seCoverage.findUnique({ where: { seId_plantId: { seId: user.userId, plantId: p.plant_id } } });
        if (!existing) {
          await prisma.seCoverage.create({ data: { seId: user.userId, plantId: p.plant_id, coverageType: coverageType as 'DEDICATED' | 'MULTI_PLANT' } });
          summary.coverageRows++;
        }
        covered.push({ plantId: String(p.plant_id), name: p.name });
      }
      zoneResult.engineers.push({ seId: user.userId, coverageType, plants: covered });
    }
    summary.perZone.push(zoneResult);
  }

  return summary;
}
