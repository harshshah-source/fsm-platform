/*
 * Ad-hoc manual snapshot-ingestion run (one chunk batch, 90 rows), bypassing the HTTP trigger.
 *   Usage (from apps/backend): node scripts/run-ingest.cjs
 * Requires a built backend (dist/) and AutoPlant VPN/creds configured. Real write path — goes
 * through PrismaService.onModuleInit like any other entrypoint (the #130 build guard applies).
 */
require('dotenv/config');
const { AutoPlantMysqlClient, readAutoPlantMysqlConfig } = require('../dist/ingestion/autoplant/autoplant-mysql.client');
const { AutoPlantSourceReader } = require('../dist/ingestion/autoplant/autoplant-source-reader');
const { SnapshotIngestionWorker } = require('../dist/ingestion/snapshot-ingestion.worker');
const { SnapshotRunService } = require('../dist/ingestion/snapshot-run.service');
const { SnapshotIngestionService } = require('../dist/ingestion/snapshot-ingestion.service');
const { PrismaService } = require('../dist/prisma/prisma.service');
(async () => {
  const cfg = readAutoPlantMysqlConfig();
  const client = new AutoPlantMysqlClient();
  const prisma = new PrismaService();
  await prisma.onModuleInit();
  const reader = new AutoPlantSourceReader({ query: (sql, params) => client.query(sql, params), widgetsSchema: cfg.dbWidgets });
  const worker = new SnapshotIngestionWorker(new SnapshotRunService(prisma), new SnapshotIngestionService(prisma), reader, prisma);
  const t0 = Date.now();
  const r = await worker.run({ chunkSize: 90 });
  console.log(`RUN ${r.status}: runId=${r.runId} chunks=${r.chunks} ok=${r.succeeded} failed=${r.failed} inserted=${r.inserted} in ${((Date.now()-t0)/1000).toFixed(1)}s`);
  await client.onModuleDestroy(); await prisma.onModuleDestroy?.();
})().catch(e => { console.error('THREW:', e.message); process.exit(1); });
