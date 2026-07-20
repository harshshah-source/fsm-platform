/*
 * Ad-hoc DB explorer — scheduling cycle for a plant by name.
 *   Usage (from apps/backend):
 *     node scripts/db-explore.cjs DEPOT_GGU        # cycle summary for every plant of that name
 *     node scripts/db-explore.cjs DEPOT_GGU 734    # drill into one plant_id
 * Requires a built backend (dist/) — run `npm run build` first if dist is stale.
 */
require('dotenv/config');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('../dist/generated/prisma/client');

const NAME = process.argv[2] || 'DEPOT_GGU';
const ONLY = process.argv[3] ? BigInt(process.argv[3]) : null;
const n = (v) => (typeof v === 'bigint' ? Number(v) : v);

function tally(rows, key) {
  const m = {};
  for (const r of rows) {
    const k = typeof key === 'function' ? key(r) : r[key];
    m[k] = (m[k] || 0) + 1;
  }
  return m;
}

(async () => {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  await prisma.$connect();

  let plants = await prisma.plant.findMany({
    where: { name: { equals: NAME, mode: 'insensitive' } },
    include: { zone: true },
    orderBy: { plantId: 'asc' },
  });
  if (ONLY) plants = plants.filter((p) => p.plantId === ONLY);

  console.log(`\nPlants named "${NAME}": ${plants.length}`);
  for (const p of plants) {
    console.log(
      `  plant_id=${n(p.plantId)}  zone=${p.zone?.name}(${n(p.zoneId)})  code=${p.masterPlantCode}  status=${p.status}`,
    );
  }

  for (const p of plants) {
    const pid = p.plantId;
    const tickets = await prisma.ticket.findMany({ where: { plantId: pid } });
    if (tickets.length === 0 && !ONLY) continue; // skip empty duplicate rows unless drilling

    console.log(`\n========== plant_id ${n(pid)} — ${p.name} ==========`);
    console.log(`TICKETS ${tickets.length}`);
    console.log('  status          :', tally(tickets, 'status'));
    console.log('  assignmentState :', tally(tickets, 'assignmentState'));
    console.log('  workType        :', tally(tickets, 'workType'));

    const recs = await prisma.recommendation.findMany({
      where: { ticketId: { in: tickets.map((t) => t.ticketId) } },
    });
    console.log(`RECOMMENDATIONS ${recs.length}`);
    console.log('  status :', tally(recs, 'status'));
    console.log('  reason :', tally(recs, (r) => (r.scoreBreakdown && r.scoreBreakdown.reason) || '(dispatched)'));

    const batches = await prisma.plantBatchAssignment.findMany({
      where: { plantId: pid },
      include: { schedule: true, tickets: true },
      orderBy: { batchId: 'asc' },
    });
    console.log(`BATCH ASSIGNMENTS ${batches.length}`);
    for (const b of batches) {
      const d = b.schedule?.dateFrom?.toISOString?.().slice(0, 10);
      console.log(
        `  batch#${n(b.batchId)} status=${b.status} SE=${b.seId.slice(0, 8)} schedule#${n(b.scheduleId)} date=${d} schedStatus=${b.schedule?.status} tickets=${b.tickets.length}`,
      );
    }
  }

  await prisma.$disconnect();
})().catch((e) => {
  console.error('THREW:', e);
  process.exit(1);
});
