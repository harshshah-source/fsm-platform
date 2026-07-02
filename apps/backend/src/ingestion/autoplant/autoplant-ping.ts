import 'dotenv/config';
import { AutoPlantMysqlClient, readAutoPlantMysqlConfig } from './autoplant-mysql.client';

/**
 * Standalone connectivity smoke check for the AutoPlant read-only MySQL source (Issue 04).
 * Build first, then run:
 *   node -r dotenv/config dist/ingestion/autoplant/autoplant-ping.js
 * or via the package script:  npm run autoplant:ping
 *
 * Confirms the app can reach AutoPlant over VPN and read tb_vehiclemaster. Read-only; no ingestion.
 */
async function main(): Promise<void> {
  const cfg = readAutoPlantMysqlConfig();
  if (!cfg) {
    // eslint-disable-next-line no-console
    console.error(
      'AutoPlant MySQL is not configured. Set AUTOPLANT_MYSQL_HOST/USER/PASSWORD/DATABASE ' +
        '(+ optional AUTOPLANT_MYSQL_PORT, AUTOPLANT_MYSQL_SSL) in .env and connect to the VPN.',
    );
    process.exitCode = 1;
    return;
  }

  // eslint-disable-next-line no-console
  console.log(
    `Connecting to AutoPlant MySQL ${cfg.user}@${cfg.host}:${cfg.port} ` +
      `(widgets=${cfg.dbWidgets}, masters=${cfg.dbMasters}, ssl=${cfg.ssl}) …`,
  );
  const client = new AutoPlantMysqlClient();
  try {
    const { vehicleRows } = await client.ping();
    // eslint-disable-next-line no-console
    console.log(`✅ ap_widgets reachable. ${cfg.dbWidgets}.tb_vehiclemaster rows = ${vehicleRows.toLocaleString()}`);

    // Prove the masters schema is reachable too (schema-qualified — masters is not the default DB).
    const plantRows = await client.query(`SELECT COUNT(*) AS n FROM \`${cfg.dbMasters}\`.mst_plant`);
    const plantCount = Number((plantRows[0] as { n?: number | string })?.n ?? 0);
    // eslint-disable-next-line no-console
    console.log(`✅ ap_masters reachable. ${cfg.dbMasters}.mst_plant rows = ${plantCount.toLocaleString()}`);

    const sample = await client.query(
      'SELECT vehicle_no, device_id, DEVICE_TYPE, latest_gps_datetime ' +
        'FROM tb_vehiclemaster WHERE gpssignal IS NOT NULL LIMIT 3',
    );
    // eslint-disable-next-line no-console
    console.table(sample);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('❌ AutoPlant connection failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await client.onModuleDestroy();
  }
}

void main();
