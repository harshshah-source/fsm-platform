import 'dotenv/config';
import { AutoPlantMysqlClient, readAutoPlantMysqlConfig } from './autoplant-mysql.client';

/**
 * Standalone connectivity smoke check for the AutoPlant read-only MySQL source (Issue 04).
 * Build first, then run:
 *   node -r dotenv/config dist/ingestion/autoplant/autoplant-ping.js
 * or via the package script:  npm run autoplant:ping
 *
 * Confirms the app can reach AutoPlant over VPN and read BOTH schemas it depends on. Read-only; no
 * ingestion.
 *
 * As of 2026-07-17 the widgets read is a HARD check, not the old soft one: `ap_widgets.tb_vehiclemaster`
 * is load-bearing for both pipelines — the snapshot reader scans it for telemetry, and the master sync
 * joins it for device identity (DEVICE_TYPE / IMSI_NO). The previous "grant pending, warn only" framing
 * was stale: the schema reads fine on the production account. If this check fails, the master sync will
 * fail too, so the probe must say so rather than print a reassuring warning.
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
    // Hard check — the live consumer path. ping() counts `<masters>.mst_vehicle` schema-qualified.
    const { vehicleRows } = await client.ping();
    // eslint-disable-next-line no-console
    console.log(`✅ ap_masters reachable. ${cfg.dbMasters}.mst_vehicle rows = ${vehicleRows.toLocaleString()}`);

    const plantRows = await client.query(`SELECT COUNT(*) AS n FROM \`${cfg.dbMasters}\`.mst_plant`);
    const plantCount = Number((plantRows[0] as { n?: number | string })?.n ?? 0);
    // eslint-disable-next-line no-console
    console.log(`✅ ${cfg.dbMasters}.mst_plant rows = ${plantCount.toLocaleString()}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('❌ AutoPlant connection failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
    await client.onModuleDestroy();
    return;
  }

  // Hard check — telemetry + device identity. Schema-qualified so it never leans on the connection
  // default (an unqualified read resolves to ap_masters and fails ER_NO_SUCH_TABLE).
  try {
    const sample = await client.query(
      'SELECT vehicle_no, device_id, DEVICE_TYPE, IMSI_NO, TRIP_CREATION_DATETIME, latest_gps_datetime ' +
        `FROM \`${cfg.dbWidgets}\`.tb_vehiclemaster WHERE gpssignal IS NOT NULL LIMIT 3`,
    );
    // eslint-disable-next-line no-console
    console.log(`✅ ${cfg.dbWidgets}.tb_vehiclemaster readable (telemetry + device identity):`);
    // eslint-disable-next-line no-console
    console.table(sample);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `❌ ${cfg.dbWidgets}.tb_vehiclemaster not readable — BOTH pipelines degrade: snapshot ingestion ` +
        'reads it for telemetry, and master sync joins it for DEVICE_TYPE/IMSI_NO (that run will fail):',
      err instanceof Error ? err.message : err,
    );
    process.exitCode = 1;
  } finally {
    await client.onModuleDestroy();
  }
}

void main();
