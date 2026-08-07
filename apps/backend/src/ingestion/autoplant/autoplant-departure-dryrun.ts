import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { DeviceDepartureService } from '../../device-departure/device-departure.service';
import {
  buildStandDownRows,
  readStandDownPathArg,
  toStandDownCsv,
} from '../../device-departure/stand-down-export';
import { PrismaService } from '../../prisma/prisma.service';
import { AutoPlantMasterSource } from './autoplant-master-source';
import { AutoPlantMysqlClient, readAutoPlantMysqlConfig } from './autoplant-mysql.client';

/**
 * Issue 128 — device-departure DRY-RUN PREVIEW. READ-ONLY: this tool NEVER writes — not to FSM, not
 * to AutoPlant. It exists to inspect what the live departure pass WOULD do, never to apply it (the
 * live pass runs inside master-sync itself). Named `*-dryrun` for exactly this reason.
 *
 *   npm run autoplant:departure-dryrun
 *
 * Runs the exact detection the live master-sync would (`DeviceDepartureService.reconcile`, but with
 * `dryRun: true`), so it computes and PRINTS the plan without writing a single row — no
 * `device_departures` inserts, no ticket cancellations, no mirror mutation. AutoPlant is read with
 * SELECT + `LIMIT ≤ 90` only (the DBA cap); FSM is read-only. Nothing is applied — the operator
 * reviews these counts and approves before the live pass (Slice 3).
 *
 * Faithfulness to the live pass:
 *  - `observed` = every device_id the widened all-status `mst_vehicle` read returns → its verbatim
 *    deployment_status (membership is what separates observed-non-operational from absent).
 *  - `syncedPlantIds` = FSM plant_ids of the ACTIVE source plants (what the live plant sync covers) —
 *    bounds the inferred ABSENT_FROM_READ path exactly as production does.
 *  - `widgetsSchema` is deliberately omitted: the departure logic needs only mst_vehicle columns, so
 *    the dry-run has no dependency on ap_widgets (device_type/imsi enrichment is irrelevant here).
 *
 * **#218c — optional stand-down export.**
 *
 *   npm run autoplant:departure-dryrun -- --export-standdown <path.csv>
 *
 * Off by default; the tool's behaviour is otherwise byte-identical. When given, it writes the
 * live-batch stand-down list (FIX-PLAN §7.5) to a LOCAL FILE — still no database write anywhere. It
 * is folded in here rather than shipped as its own command for one reason: the export needs the
 * departure plan, the plan needs the full ~26k-row source read, and that read is capped at 90 rows
 * per query by the AutoPlant DBA. Running it twice would cost a second full read AND risk the two
 * disagreeing, since the fleet churns ~150 vehicles/day. Deriving both from ONE read also pins the
 * absence cohort **exactly** — at Gate 3 it could only be estimated at ~300.
 */

async function main(): Promise<void> {
  // Parsed before anything expensive: a mistyped flag must not surface after a ~26k-row source read.
  let standDownPath: string | null;
  try {
    standDownPath = readStandDownPathArg(process.argv.slice(2));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
    return;
  }

  const cfg = readAutoPlantMysqlConfig();
  if (!cfg) {
    // eslint-disable-next-line no-console
    console.error('AutoPlant MySQL not configured — set AUTOPLANT_MYSQL_* in .env and connect to the VPN.');
    process.exitCode = 1;
    return;
  }

  const client = new AutoPlantMysqlClient();
  // #130 — a read-only diagnostic must never be blocked by the version lock it may be run to inspect:
  // warnOnly evaluates the guard and WARNs on a stale/skewed build, but never writes or throws.
  const prisma = new PrismaService({ warnOnly: true });
  await prisma.onModuleInit();

  try {
    const query = ((sql: string, params?: readonly unknown[]) => client.query(sql, params)) as never;
    const source = new AutoPlantMasterSource({
      query,
      mastersSchema: cfg.dbMasters,
      plantStatuses: ['ACTIVE'],
      deploymentStatuses: [], // widened read — every status, so departures are OBSERVED
    });

    // 1. ACTIVE source plants → FSM plant_ids (the live sync's syncedPlantIds scope).
    // eslint-disable-next-line no-console
    console.log('Reading ACTIVE plants from AutoPlant (mst_plant, ≤90/query) …');
    const plants = await source.readPlants();
    const activeSourcePlantIds = [
      ...new Set(plants.map((p) => BigInt(p.plant_id)).map((b) => b.toString())),
    ].map((s) => BigInt(s));
    const fsmPlants = await prisma.plant.findMany({
      where: { sourcePlantId: { in: activeSourcePlantIds } },
      select: { plantId: true, sourcePlantId: true, name: true, zoneId: true },
    });
    const syncedPlantIds = fsmPlants.map((p) => p.plantId);

    // 2. Widened all-status vehicle read → observed (device_id → verbatim status).
    // eslint-disable-next-line no-console
    console.log('Reading ALL-status vehicles from AutoPlant (mst_vehicle, ≤90/query) — this is the big read …');
    const vehicles = await source.readVehicleMasters();
    const observed = new Map<string, string | null>();
    const statusCounts = new Map<string, number>();
    for (const v of vehicles) {
      const deviceId = String(v.device_id ?? '').trim();
      if (deviceId !== '') observed.set(deviceId, v.deployment_status);
      const s = (v.deployment_status ?? 'NULL').toString();
      statusCounts.set(s, (statusCounts.get(s) ?? 0) + 1);
    }
    // eslint-disable-next-line no-console
    console.log(
      `\nSource read: ${vehicles.length} vehicle rows · ${observed.size} distinct device_ids · ` +
        `${plants.length} ACTIVE plants (${fsmPlants.length} known to FSM).`,
    );
    // eslint-disable-next-line no-console
    console.log('Source deployment_status distribution (widened read):');
    // eslint-disable-next-line no-console
    console.table([...statusCounts.entries()].sort((a, b) => b[1] - a[1]).map(([status, n]) => ({ status, rows: n })));

    // 3. DRY-RUN reconcile — computes the plan, writes NOTHING.
    const departures = new DeviceDepartureService(prisma);
    const result = await departures.reconcile({ observed, syncedPlantIds, dryRun: true });

    // 4. Report.
    const plan = result.plan ?? [];
    const inScope = syncedPlantIds.length; // count of FSM plants in the absence scope
    // eslint-disable-next-line no-console
    console.log('\n════════════════════ DRY-RUN RESULT (nothing written) ════════════════════');
    // eslint-disable-next-line no-console
    console.table([
      { metric: 'devices → DEPARTED (would open)', value: result.departed },
      { metric: '  · of which SOURCE_STATUS (observed non-operational)', value: plan.filter((r) => r.reason === 'SOURCE_STATUS').length },
      { metric: '  · of which ABSENT_FROM_READ (inferred, guard-gated)', value: plan.filter((r) => r.reason === 'ABSENT_FROM_READ').length },
      { metric: 'open tickets → CANCELLED (DEVICE_UNDEPLOYED)', value: result.cancelledTickets },
      { metric: 'active departures → RESTORED (re-deployed)', value: result.restored },
      { metric: 'absence candidates considered', value: result.absentCandidates },
      { metric: 'ABSENCE GUARD TRIPPED?', value: result.guardTripped ? 'YES — absence path marked NOTHING' : 'no' },
      { metric: 'FSM plants in absence scope (syncedPlantIds)', value: inScope },
    ]);

    // By observed status.
    const byStatus = new Map<string, number>();
    for (const r of plan) byStatus.set(r.observedStatus, (byStatus.get(r.observedStatus) ?? 0) + 1);
    // eslint-disable-next-line no-console
    console.log('\nWould-depart by observed status:');
    // eslint-disable-next-line no-console
    console.table([...byStatus.entries()].sort((a, b) => b[1] - a[1]).map(([status, n]) => ({ observedStatus: status, devices: n })));

    // By zone (join plan.plantId → FSM plant → zone).
    const planPlantIds = [...new Set(plan.map((r) => r.plantId).filter((p): p is bigint => p !== null).map((b) => b.toString()))].map((s) => BigInt(s));
    const planPlants = await prisma.plant.findMany({
      where: { plantId: { in: planPlantIds } },
      select: { plantId: true, name: true, zone: { select: { name: true } } },
    });
    const zoneByPlant = new Map(planPlants.map((p) => [p.plantId.toString(), p.zone?.name ?? '(no zone)']));
    const nameByPlant = new Map(planPlants.map((p) => [p.plantId.toString(), p.name]));
    const byZone = new Map<string, number>();
    const byPlant = new Map<string, number>();
    let nullPlant = 0;
    for (const r of plan) {
      if (r.plantId === null) { nullPlant++; continue; }
      const key = r.plantId.toString();
      const zone = zoneByPlant.get(key) ?? '(unknown)';
      byZone.set(zone, (byZone.get(zone) ?? 0) + 1);
      const pname = `${nameByPlant.get(key) ?? key} [${key}]`;
      byPlant.set(pname, (byPlant.get(pname) ?? 0) + 1);
    }
    // eslint-disable-next-line no-console
    console.log(`\nWould-depart by zone${nullPlant > 0 ? ` (+${nullPlant} with no current fitment/plant)` : ''}:`);
    // eslint-disable-next-line no-console
    console.table([...byZone.entries()].sort((a, b) => b[1] - a[1]).map(([zone, n]) => ({ zone, devices: n })));
    // eslint-disable-next-line no-console
    console.log('\nTop 25 plants by would-depart count:');
    // eslint-disable-next-line no-console
    console.table([...byPlant.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([plant, n]) => ({ plant, devices: n })));

    // 5. #218c — optional live-batch stand-down export, from THIS read's plan.
    if (standDownPath !== null) {
      const standDown = await buildStandDownRows(prisma, plan.map((r) => r.deviceId));
      writeFileSync(standDownPath, `${toStandDownCsv(standDown)}\n`, 'utf8');
      const byReason = new Map<string, number>();
      const reasonByDevice = new Map(plan.map((r) => [r.deviceId, r.reason]));
      for (const row of standDown) {
        const reason = reasonByDevice.get(row.deviceId) ?? 'UNKNOWN';
        byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
      }
      // eslint-disable-next-line no-console
      console.log(
        `\n📄 STAND-DOWN LIST — ${standDown.length} live-batch ticket(s) on visits dispatch should stand ` +
          `down → ${standDownPath}`,
      );
      // Both cohorts come from the same read, so this count is EXACT — no estimate for the absence side.
      // eslint-disable-next-line no-console
      console.table([...byReason.entries()].sort((a, b) => b[1] - a[1]).map(([reason, n]) => ({ departureReason: reason, liveTickets: n })));
      // eslint-disable-next-line no-console
      console.log(
        `   (of ${result.cancelledTickets} tickets the window would close in total — the rest are backlog ` +
          `with no live batch assignment, so no visit is standing on them.)`,
      );
    }

    // eslint-disable-next-line no-console
    console.log(
      `\n✅ DRY RUN ONLY — nothing was written to any database.${standDownPath !== null ? ' The only write was the local CSV above.' : ''} Review the counts above and approve before the live pass.`,
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('❌ dry-run failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await client.onModuleDestroy();
    await prisma.onModuleDestroy();
  }
}

void main();
