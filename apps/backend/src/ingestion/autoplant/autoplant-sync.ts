import 'dotenv/config';
import { DeviceStateService } from '../../device-state/device-state.service';
import { seedOrgReferenceData } from '../../org/org-seed';
import { PrismaService } from '../../prisma/prisma.service';
import type { SettingsService } from '../../settings/settings.service';
import { SnapshotIngestionService } from '../snapshot-ingestion.service';
import { SnapshotIngestionWorker } from '../snapshot-ingestion.worker';
import { SnapshotRunService } from '../snapshot-run.service';
import { AutoPlantMasterSource } from './autoplant-master-source';
import { AutoPlantMysqlClient, readAutoPlantMysqlConfig } from './autoplant-mysql.client';
import { AutoPlantSourceReader } from './autoplant-source-reader';
import { MappingTableZoneResolver } from './mapping-table-zone-resolver';
import { MasterSyncRunService } from './master-sync-run.service';
import { MasterSyncService } from './master-sync.service';

/**
 * Standalone first-light runner for the AutoPlant → FSM pipeline (mirrors `autoplant-ping.ts`). Builds
 * the production services by hand (like the Book8 harness) so the pipeline can be driven with one
 * command, no server/auth needed. All reads are bounded < 100 rows/query (DBA cap) and read-only.
 *
 *   npm run autoplant:sync            # masters only — org graph + pending zone-mapping queue (light)
 *   npm run autoplant:sync pipeline   # + telemetry drain + device-state recompute (heavier)
 *
 * Seeds the operational zones (incl. UNZONED) first so the mapping-table resolver can land pending
 * plants. FSM-owned data is never clobbered (anti-drift); a re-run is idempotent.
 */
const CHUNK = Math.max(1, Math.min(99, Number(process.env.AUTOPLANT_SNAPSHOT_CHUNK_SIZE) || 90));
const settingsStub = { get: async () => 24 } as unknown as SettingsService;

async function main(): Promise<void> {
  const cfg = readAutoPlantMysqlConfig();
  if (!cfg) {
    // eslint-disable-next-line no-console
    console.error('AutoPlant MySQL not configured — set AUTOPLANT_MYSQL_* in .env and connect to the VPN.');
    process.exitCode = 1;
    return;
  }
  const full = process.argv.includes('pipeline');
  const client = new AutoPlantMysqlClient();
  const prisma = new PrismaService();
  await prisma.onModuleInit();

  try {
    // eslint-disable-next-line no-console
    console.log('Seeding operational zones (idempotent) …');
    await seedOrgReferenceData(prisma as never);

    const query = ((sql: string, params?: readonly unknown[]) => client.query(sql, params)) as never;
    const source = new AutoPlantMasterSource({
      query,
      mastersSchema: cfg.dbMasters,
      // MUST match ingestion.module's wiring: without it the device-identity join is skipped and the
      // sync writes NULL device_type/imsi_no over good values (mapDevice mirrors both).
      widgetsSchema: cfg.dbWidgets,
      plantStatuses: ['ACTIVE'],
      deploymentStatuses: ['DEPLOYED'],
    });
    const masterSync = new MasterSyncService(
      prisma,
      new MasterSyncRunService(prisma),
      source,
      new MappingTableZoneResolver(prisma),
      { plantStatuses: ['ACTIVE'] },
    );

    // eslint-disable-next-line no-console
    console.log('── master-sync (ACTIVE plants / DEPLOYED vehicles, paginated ≤ ' + CHUNK + ') …');
    const master = await masterSync.sync();
    // eslint-disable-next-line no-console
    console.log(`master-sync ${master.status}`, master.stats);

    // Show the pending zone-mapping queue that this sync populated (the admin's next action).
    const pending = await prisma.zoneMapping.findMany({
      where: { status: 'PENDING' },
      orderBy: { seenCount: 'desc' },
      take: 20,
    });
    // eslint-disable-next-line no-console
    console.log(`\nPending zone values to map (top ${pending.length}):`);
    // eslint-disable-next-line no-console
    console.table(
      pending.map((p) => ({ key: p.sourceValueKey, raw: p.sourceValueRaw, plants: p.seenCount })),
    );

    if (full) {
      const snapRuns = new SnapshotRunService(prisma);
      const reader = new AutoPlantSourceReader({
        query,
        widgetsSchema: cfg.dbWidgets, // tb_vehiclemaster lives in ap_widgets; pool default is ap_masters
        offsetMinutes: process.env.AUTOPLANT_SOURCE_UTC_OFFSET_MIN
          ? Number(process.env.AUTOPLANT_SOURCE_UTC_OFFSET_MIN)
          : undefined,
      });
      const worker = new SnapshotIngestionWorker(snapRuns, new SnapshotIngestionService(prisma), reader, prisma);
      // eslint-disable-next-line no-console
      console.log(`\n── snapshot ingest (telemetry, chunk ≤ ${CHUNK}) …`);
      const snap = await worker.run({ chunkSize: CHUNK });
      // eslint-disable-next-line no-console
      console.log(`snapshot ${snap.status}: ${snap.inserted} pings over ${snap.chunks} chunks`);

      // eslint-disable-next-line no-console
      console.log('\n── device-state recompute …');
      const ds = await new DeviceStateService(prisma, settingsStub).recompute();
      // eslint-disable-next-line no-console
      console.log(`device-state upserted ${ds.upserted}`);
    } else {
      // eslint-disable-next-line no-console
      console.log('\n(masters only — run `npm run autoplant:sync pipeline` to drain telemetry + recompute)');
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('❌ sync failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await client.onModuleDestroy();
    await prisma.onModuleDestroy();
  }
}

void main();
