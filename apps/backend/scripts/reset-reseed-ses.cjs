/*
 * DEV/DEMO reset + reseed of the mock Service-Engineer workforce and their ticket assignments.
 *   Usage (from apps/backend, needs a built dist/):
 *     node scripts/reset-reseed-ses.cjs            # DRY RUN — prints current state + planned actions
 *     node scripts/reset-reseed-ses.cjs --yes      # EXECUTE (transactional)
 *
 * What it does (all in one transaction):
 *   1. RESET ticket assignment  — every ticket with assignment_state <> UNASSIGNED is flipped back to
 *      UNASSIGNED (assigned_se_id cleared), and all dispatch/assignment artifacts are removed:
 *      dispatch_decision_traces, batch_assignment_tickets, plant_batch_assignments, recommendations,
 *      work_schedules, se_planner, intraday_insertions. Dispatch-run ledger rows (dispatch_runs /
 *      dispatch_run_zones) are KEPT as historical audit.
 *   2. WIPE SE workforce        — se_coverage, engineer_master, and every SERVICE_ENGINEER user row.
 *      Zonal Managers are KEPT.
 *   3. RESEED                    — 15 SEs per zone with region-flavoured Indian names, covering each
 *      zone's highest-inactive plants (same in-zone rule as prisma/seed-mock-engineers.ts).
 *
 * Never run against production. Mirrors prisma/seed-mock-engineers.ts — keep the name pools in sync.
 */
require('dotenv/config');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('../dist/generated/prisma/client');

const EXECUTE = process.argv.includes('--yes');
const SE_PER_ZONE = 15;
const DEFAULT_CAPACITY = 25;
const n = (v) => (typeof v === 'bigint' ? Number(v) : v);

const SE_NAMES_BY_ZONE = {
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

/** Split `items` into `k` contiguous chunks, biggest-first (mirror of seed-mock-engineers.ts). */
function chunk(items, k) {
  const out = Array.from({ length: k }, () => []);
  items.forEach((it, i) => out[Math.min(i, k - 1)].push(it));
  return out.filter((c) => c.length > 0);
}

async function preState(prisma) {
  const [seCount, em, cov, recs, batches, batchTickets, sched, planner, traces, intraday] = await Promise.all([
    prisma.user.count({ where: { role: 'SERVICE_ENGINEER' } }),
    prisma.engineerMaster.count(),
    prisma.seCoverage.count(),
    prisma.recommendation.count(),
    prisma.plantBatchAssignment.count(),
    prisma.batchAssignmentTicket.count(),
    prisma.workSchedule.count(),
    prisma.sePlanner.count(),
    prisma.dispatchDecisionTrace.count(),
    prisma.intradayInsertion.count(),
  ]);
  const assigned = await prisma.ticket.count({ where: { assignmentState: { not: 'UNASSIGNED' } } });
  return { seCount, em, cov, recs, batches, batchTickets, sched, planner, traces, intraday, assigned };
}

async function reseedZone(tx, zone) {
  const zoneId = zone.zoneId;
  const key = (zone.name || '').toLowerCase();
  const namePool = SE_NAMES_BY_ZONE[key] ?? [];

  // Keep the existing ZM; upsert only refreshes its label. Never creates a duplicate.
  const zm = await tx.user.upsert({
    where: { email: `zm-z${zoneId}@mock.fsm` },
    update: {},
    create: {
      name: `ZM Zone ${zoneId} (mock)`, role: 'ZONAL_MANAGER', zoneId,
      phone: `+9198${zoneId}000000`, email: `zm-z${zoneId}@mock.fsm`, status: 'ACTIVE',
    },
  });
  if (zone.zonalManagerUserId == null) {
    await tx.zone.update({ where: { zoneId }, data: { zonalManagerUserId: zm.userId } });
  }

  const topPlants = await tx.$queryRawUnsafe(
    `SELECT p.plant_id, p.name FROM plants p
       LEFT JOIN device_states ds ON ds.plant_id = p.plant_id
      WHERE p.zone_id = $1
      GROUP BY p.plant_id, p.name
     HAVING count(*) FILTER (WHERE ds.is_inactive) > 0
      ORDER BY count(*) FILTER (WHERE ds.is_inactive) DESC
      LIMIT $2`,
    zoneId, SE_PER_ZONE * 2,
  );
  const buckets = chunk(topPlants, SE_PER_ZONE);

  let engineers = 0, coverageRows = 0;
  for (let i = 0; i < SE_PER_ZONE; i++) {
    const plants = buckets[i] ?? [];
    const coverageType = plants.length === 1 ? 'DEDICATED' : 'MULTI_PLANT';
    const name = namePool[i] ?? `SE Z${zoneId}-${i + 1} (mock)`;
    const user = await tx.user.create({
      data: {
        name, role: 'SERVICE_ENGINEER', zoneId,
        phone: `+9197${zoneId}${String(i + 1).padStart(3, '0')}00`,
        email: `se-z${zoneId}-${i + 1}@mock.fsm`, status: 'ACTIVE',
      },
    });
    await tx.engineerMaster.create({
      data: { engineerId: user.userId, coverageType, zoneId, dailyCapacity: DEFAULT_CAPACITY, isActive: true },
    });
    engineers++;
    for (const p of plants) {
      await tx.seCoverage.create({ data: { seId: user.userId, plantId: p.plant_id, coverageType } });
      coverageRows++;
    }
  }
  return { zoneId: n(zoneId), name: zone.name, engineers, coverageRows, covered: n(buckets.flat().length) };
}

(async () => {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  await prisma.$connect();

  const zones = await prisma.zone.findMany({ orderBy: { zoneId: 'asc' } });
  const before = await preState(prisma);

  console.log('\n=== BEFORE ===');
  console.log(`  zones: ${zones.map((z) => `${z.name}(${n(z.zoneId)})`).join(', ')}`);
  console.log(`  SERVICE_ENGINEER users : ${before.seCount}`);
  console.log(`  engineer_master        : ${before.em}`);
  console.log(`  se_coverage            : ${before.cov}`);
  console.log(`  tickets NOT unassigned : ${before.assigned}`);
  console.log(`  recommendations        : ${before.recs}`);
  console.log(`  plant_batch_assignments: ${before.batches}  (batch_tickets ${before.batchTickets})`);
  console.log(`  work_schedules         : ${before.sched}`);
  console.log(`  se_planner             : ${before.planner}`);
  console.log(`  dispatch_decision_traces: ${before.traces}`);
  console.log(`  intraday_insertions    : ${before.intraday}`);

  if (!EXECUTE) {
    console.log('\n=== DRY RUN (no --yes) ===');
    console.log(`  Would flip ${before.assigned} tickets -> UNASSIGNED and delete every artifact above.`);
    console.log(`  Would delete all ${before.seCount} SE users + engineer_master + se_coverage (ZMs kept).`);
    console.log(`  Would reseed ${SE_PER_ZONE} SEs per zone (${zones.length} zones = ${SE_PER_ZONE * zones.length}) with Indian names.`);
    console.log('  Re-run with --yes to execute.');
    await prisma.$disconnect();
    return;
  }

  const result = await prisma.$transaction(async (tx) => {
    // 1) Reset ticket assignment + remove dispatch/assignment artifacts (children first).
    const traces = await tx.dispatchDecisionTrace.deleteMany({});
    const batchTickets = await tx.batchAssignmentTicket.deleteMany({});
    const batches = await tx.plantBatchAssignment.deleteMany({});
    const recs = await tx.recommendation.deleteMany({});
    const sched = await tx.workSchedule.deleteMany({});
    const planner = await tx.sePlanner.deleteMany({});
    const intraday = await tx.intradayInsertion.deleteMany({});
    const tickets = await tx.ticket.updateMany({
      where: { OR: [{ assignmentState: { not: 'UNASSIGNED' } }, { assignedSeId: { not: null } }] },
      data: { assignmentState: 'UNASSIGNED', assignedSeId: null },
    });

    // 2) Wipe the SE workforce (ZMs untouched).
    const cov = await tx.seCoverage.deleteMany({});
    const em = await tx.engineerMaster.deleteMany({});
    const seUsers = await tx.user.deleteMany({ where: { role: 'SERVICE_ENGINEER' } });

    // 3) Reseed 15 Indian-named SEs per zone.
    const perZone = [];
    for (const zone of zones) perZone.push(await reseedZone(tx, zone));

    return { traces, batchTickets, batches, recs, sched, planner, intraday, tickets, cov, em, seUsers, perZone };
  }, { timeout: 120000, maxWait: 20000 });

  console.log('\n=== EXECUTED ===');
  console.log(`  tickets reset -> UNASSIGNED : ${result.tickets.count}`);
  console.log(`  deleted: traces=${result.traces.count} batchTickets=${result.batchTickets.count} batches=${result.batches.count} recs=${result.recs.count} schedules=${result.sched.count} planner=${result.planner.count} intraday=${result.intraday.count}`);
  console.log(`  deleted: se_coverage=${result.cov.count} engineer_master=${result.em.count} se_users=${result.seUsers.count}`);
  console.log('  reseeded per zone:');
  for (const z of result.perZone) {
    console.log(`     ${z.name}(${z.zoneId}): ${z.engineers} SEs, ${z.coverageRows} coverage rows over ${z.covered} plants`);
  }

  const after = await preState(prisma);
  console.log('\n=== AFTER ===');
  console.log(`  SERVICE_ENGINEER users : ${after.seCount}`);
  console.log(`  engineer_master        : ${after.em}`);
  console.log(`  se_coverage            : ${after.cov}`);
  console.log(`  tickets NOT unassigned : ${after.assigned}`);
  console.log(`  recommendations/batches/schedules/traces/intraday : ${after.recs}/${after.batches}/${after.sched}/${after.traces}/${after.intraday}`);

  await prisma.$disconnect();
})().catch((e) => { console.error('THREW:', e); process.exit(1); });
