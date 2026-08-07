import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EXCLUDE_DEACTIVATED_PLANTS, FLEET_COUNT_COLUMNS } from '../dashboard/dashboard.service';
import { AutoPlantHealthService, readReconMaxDrift } from '../ingestion/autoplant/health.service';

/**
 * KPI reconciliation (#217 AC-10/AC-11).
 *
 * Four identities that must hold over the whole live database. Each is evaluated by independent
 * queries — grouped differently, or reading a different table — and then compared in TypeScript.
 * Comparing two differently-shaped reads is the entire value: an identity checked by one query
 * against itself proves nothing.
 *
 * **Every count here comes from the imported `FLEET_COUNT_COLUMNS`.** Restating the predicates locally
 * would produce a checker that verifies its own spelling rather than the dashboard's — which is the
 * defect class #176 closed, reintroduced with extra steps. The one place this file writes its own
 * predicate is the SLA-bucket split, and that predicate is copied verbatim from the fragment's
 * `inactiveOperational` filter and is asserted against it by identity 4 itself.
 *
 * Scope is deliberately **pan-India and unrestricted by zone**: this is a reconciliation instrument
 * for Operations Head, and an identity that only holds inside one zone's slice is not the identity the
 * dashboard's headline strip depends on.
 */

/**
 * `UNAVAILABLE` is distinct from `FAIL` — it means the identity could not be evaluated at all (most
 * commonly: AutoPlant is unconfigured in this environment, or the VPN is down), not that the two
 * sides disagreed. Rendering that as FAIL would tell an operator on a dev box "your data is wrong"
 * when the true answer is "this check needs the source connection, which isn't available here".
 */
export type IdentityStatus = 'PASS' | 'FAIL' | 'UNAVAILABLE';

export interface IdentityTerm {
  label: string;
  value: number;
  /** How this side was measured — the point of the panel is that the two sides were measured differently. */
  measuredBy: string;
}

export interface ReconciliationIdentity {
  key: string;
  name: string;
  /** The identity in plain arithmetic, as an operator would say it aloud. */
  statement: string;
  status: IdentityStatus;
  left: IdentityTerm;
  right: IdentityTerm;
  /** `left - right`. Signed, so the direction of the drift is legible. Zero on PASS. */
  difference: number;
  /** Named, ranked candidate explanations. Populated only on FAIL — a passing identity needs no story. */
  likelySources: string[];
  /** Populated only on UNAVAILABLE — why this identity could not be evaluated. */
  unavailableReason?: string;
  /** Developer Mode only: the statements that produced each side. */
  sql?: { left: string; right: string };
}

export interface ReconciliationReport {
  checkedAt: string;
  /**
   * `PASS` unless something actually disagreed. An UNAVAILABLE identity (AutoPlant unconfigured) does
   * NOT flip this to FAIL — "we couldn't check" is not the same claim as "we checked and it's wrong",
   * and conflating them would make every dev/test/CI run report the whole panel as broken.
   */
  status: 'PASS' | 'FAIL';
  identities: ReconciliationIdentity[];
  /** Server-side wall time for the whole reconciliation sweep, ms. */
  durationMs: number;
}

interface RawCounts {
  mirroredDevices: number;
  operationalDevices: number;
  warehouseDevices: number;
  inactiveOperational: number;
  healthyOperational: number;
}

const ZERO: RawCounts = {
  mirroredDevices: 0,
  operationalDevices: 0,
  warehouseDevices: 0,
  inactiveOperational: 0,
  healthyOperational: 0,
};

/** The scope every identity is stated over: mirrored device state on a live (non-deactivated) plant. */
const SCOPE = Prisma.sql`
  FROM device_states ds
  JOIN plants p ON p.plant_id = ds.plant_id
  WHERE true ${EXCLUDE_DEACTIVATED_PLANTS}`;

const FLEET_SQL = Prisma.sql`SELECT ${FLEET_COUNT_COLUMNS} ${SCOPE}`;
const BY_ZONE_SQL = Prisma.sql`SELECT p.zone_id::text AS "key", ${FLEET_COUNT_COLUMNS} ${SCOPE} GROUP BY p.zone_id`;
const BY_COMPANY_SQL = Prisma.sql`SELECT ds.company_id::text AS "key", ${FLEET_COUNT_COLUMNS} ${SCOPE} GROUP BY ds.company_id`;
const BY_BUCKET_SQL = Prisma.sql`
  SELECT ds.sla_bucket::text AS "key", COUNT(*)::int AS "count"
  ${SCOPE} AND ds.is_departed = false AND ds.is_inactive = true AND ds.sla_bucket IS NOT NULL
  GROUP BY ds.sla_bucket`;

/**
 * Identity 6 (#217 S2) — the dispatch-run ledger's own self-consistency, added when the `batches` and
 * `dispatchRuns` datasets landed. Deliberately NOT a device-population identity like the five above:
 * `dispatch_runs.batches` is a COUNTER stamped once at run finish (`batch-assignment.service.ts`), and
 * `plant_batch_assignments` rows are never deleted — only their `status` changes (AUTO_ASSIGNED →
 * OVERRIDDEN/COMPLETED/PARTIAL) — so the counter and the surviving row count must agree forever, for
 * every run whose batches carry that run's id. This is the STABLE half of run attribution: individual
 * TICKETS within a batch can later be removed by a ZM override (`batch_assignment_tickets.removed_at`),
 * which would make a ticket-count identity chronically noisy from legitimate business action — the
 * batch ROW itself is not removable, so this identity has no such false-positive source.
 */
const RUN_BATCH_LEDGER_SQL = Prisma.sql`SELECT COALESCE(SUM(batches), 0)::int AS "total" FROM dispatch_runs`;
const RUN_BATCH_ROWS_SQL = Prisma.sql`
  SELECT COUNT(*)::int AS "total" FROM plant_batch_assignments WHERE run_id IS NOT NULL`;

@Injectable()
export class ReconciliationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly autoplantHealth: AutoPlantHealthService,
  ) {}

  async run(developerMode: boolean): Promise<ReconciliationReport> {
    const startedAt = Date.now();

    const [fleetRows, zoneRows, companyRows, bucketRows, ledgerRows, batchRowsCount, autoplant, lifecycle] =
      await Promise.all([
        this.prisma.$queryRaw<RawCounts[]>(FLEET_SQL),
        this.prisma.$queryRaw<Array<RawCounts & { key: string | null }>>(BY_ZONE_SQL),
        this.prisma.$queryRaw<Array<RawCounts & { key: string | null }>>(BY_COMPANY_SQL),
        this.prisma.$queryRaw<Array<{ key: string; count: number }>>(BY_BUCKET_SQL),
        this.prisma.$queryRaw<Array<{ total: number }>>(RUN_BATCH_LEDGER_SQL),
        this.prisma.$queryRaw<Array<{ total: number }>>(RUN_BATCH_ROWS_SQL),
        // #217 S3 — reuses AutoPlantHealthService.reconciliationHealth() verbatim (the same COUNT(*)
        // reads /api/integration/health already shows), rather than a second AutoPlant query path. It
        // is the DBA <100-row cap that makes a bulk per-row AutoPlant dataset the wrong shape here — see
        // the issue file — so this stays count-only, exactly like every other AutoPlant read in the app.
        this.autoplantHealth.reconciliationHealth(),
        // #218 — same posture as the line above: the health service owns the predicate, this panel
        // folds the result in. Unlike identities 7–8 this one needs no AutoPlant read, so it stays
        // evaluable (never UNAVAILABLE) even with the source down.
        this.autoplantHealth.lifecycleHealth(),
      ]);

    const fleet = fleetRows[0] ?? ZERO;
    const sum = (rows: RawCounts[], field: keyof RawCounts) => rows.reduce((a, r) => a + (r[field] ?? 0), 0);
    const zoneOperational = sum(zoneRows, 'operationalDevices');
    const companyOperational = sum(companyRows, 'operationalDevices');
    const bucketTotal = bucketRows.reduce((a, r) => a + r.count, 0);

    const identities: ReconciliationIdentity[] = [
      this.identity({
        key: 'zoneRollup',
        name: 'Zone roll-up matches the fleet KPI strip',
        statement: 'Σ zone.operationalDevices = fleet.operationalDevices',
        left: {
          label: 'Σ zones',
          value: zoneOperational,
          measuredBy: `${zoneRows.length} rows grouped by plants.zone_id`,
        },
        right: { label: 'Fleet KPI strip', value: fleet.operationalDevices, measuredBy: 'one ungrouped aggregate' },
        likelySources: [
          'A device_states row whose plant_id points at a plant that no longer exists — the inner JOIN drops it from BOTH sides, so this identity holding does not prove it is absent (see the mirrored-total identity).',
          'A plant deactivated between the two queries: they are issued concurrently, not in one snapshot transaction.',
          'A zone row with a NULL zone_id would group into its own bucket rather than vanish — if that appears, plants.zone_id has become nullable, which the schema forbids.',
        ],
        sql: developerMode ? { left: BY_ZONE_SQL.text, right: FLEET_SQL.text } : undefined,
      }),
      this.identity({
        key: 'companyRollup',
        name: 'Company roll-up matches the fleet KPI strip',
        statement: 'Σ company.operationalDevices = fleet.operationalDevices',
        left: {
          label: 'Σ companies',
          value: companyOperational,
          measuredBy: `${companyRows.length} rows grouped by device_states.company_id`,
        },
        right: { label: 'Fleet KPI strip', value: fleet.operationalDevices, measuredBy: 'one ungrouped aggregate' },
        likelySources: [
          'device_states.company_id is a denormalised copy written by the recompute; if it disagrees with vehicles.company_id, the company grouping and the zone grouping partition the same rows differently.',
          'Devices with a NULL company_id group together rather than disappear — a large single anonymous group here means the denormalisation did not run for those rows.',
          'A master sync running concurrently with this check re-parents vehicles mid-sweep.',
        ],
        sql: developerMode ? { left: BY_COMPANY_SQL.text, right: FLEET_SQL.text } : undefined,
      }),
      this.identity({
        key: 'mirroredPartition',
        name: 'Operational + warehouse partitions the mirrored fleet',
        statement: 'operationalDevices + warehouseDevices = mirroredDevices',
        left: {
          label: 'Operational + warehouse',
          value: fleet.operationalDevices + fleet.warehouseDevices,
          measuredBy: 'two FILTER clauses on is_departed',
        },
        right: { label: 'Mirrored', value: fleet.mirroredDevices, measuredBy: 'unfiltered COUNT(*)' },
        likelySources: [
          'is_departed is NULL for some rows — a three-valued column cannot partition a set into two FILTERs, and both filters would drop those rows. The column is NOT NULL DEFAULT false, so this failing means a migration changed that.',
        ],
        sql: developerMode ? { left: FLEET_SQL.text, right: FLEET_SQL.text } : undefined,
      }),
      this.identity({
        key: 'operationalPartition',
        name: 'Healthy + inactive partitions the operational fleet',
        statement: 'healthyOperational + inactiveOperational = operationalDevices',
        left: {
          label: 'Healthy + inactive',
          value: fleet.healthyOperational + fleet.inactiveOperational,
          measuredBy: 'complementary FILTER clauses over the non-departed set',
        },
        right: { label: 'Operational', value: fleet.operationalDevices, measuredBy: 'is_departed = false' },
        likelySources: [
          'The two predicates are literal complements within one SQL fragment, so a mismatch here is not a data problem — it means FLEET_COUNT_COLUMNS itself has been edited such that healthy is no longer NOT(inactive).',
        ],
        sql: developerMode ? { left: FLEET_SQL.text, right: FLEET_SQL.text } : undefined,
      }),
      this.identity({
        key: 'bucketRollup',
        name: 'SLA buckets account for every inactive device',
        statement: 'Σ byBucket = inactiveOperational',
        left: {
          label: 'Σ SLA buckets',
          value: bucketTotal,
          measuredBy: `${bucketRows.length} buckets grouped by device_states.sla_bucket`,
        },
        right: {
          label: 'Inactive operational',
          value: fleet.inactiveOperational,
          measuredBy: 'the inactiveOperational FILTER clause',
        },
        likelySources: [
          'A device with is_inactive = true and a NULL sla_bucket: the bucket query drops it and so does the inactive FILTER, so a mismatch means the two spellings of "inactive" have diverged.',
          'A bucket value present in the data but absent from the SlaBucket enum — impossible while the column is the enum type.',
          'The recompute ran between the two concurrent queries and re-bucketed devices.',
        ],
        sql: developerMode ? { left: BY_BUCKET_SQL.text, right: FLEET_SQL.text } : undefined,
      }),
      this.identity({
        key: 'dispatchBatchLedger',
        name: 'Dispatch run ledger matches its own batch rows',
        statement: 'Σ dispatch_runs.batches = COUNT(plant_batch_assignments WHERE run_id IS NOT NULL)',
        left: {
          label: 'Run ledger Σ batches',
          value: ledgerRows[0]?.total ?? 0,
          measuredBy: 'SUM(dispatch_runs.batches) — the counter each run stamped at finish',
        },
        right: {
          label: 'Live batch rows',
          value: batchRowsCount[0]?.total ?? 0,
          measuredBy: 'COUNT(plant_batch_assignments) WHERE run_id IS NOT NULL — rows are never deleted, only re-statused',
        },
        likelySources: [
          'A batch row whose run_id was nulled by ON DELETE SET NULL because its dispatch_runs parent was deleted — dispatch_runs has no deletion path today, so this would be new.',
          'A run that crashed mid-write between incrementing `batches` and committing its batch rows — the transactional dispatch (#100) makes this a single transaction, so this would mean that guarantee broke.',
          'Direct data manipulation (a manual DB fix, a seed script) that touched one table without the other.',
        ],
        sql: developerMode ? { left: RUN_BATCH_LEDGER_SQL.text, right: RUN_BATCH_ROWS_SQL.text } : undefined,
      }),
      this.identity({
        key: 'lifecycleConsistency',
        name: 'Source status agrees with the departure ledger',
        statement: 'COUNT(device_states WHERE (vehicles.status is operational) <> (NOT is_departed)) = 0',
        left: {
          label: 'Devices contradicting themselves',
          value: lifecycle.drift,
          measuredBy:
            `per-row XOR of vehicles.status against device_states.is_departed, excluding ${lifecycle.missingFromSource} ` +
            'device(s) with an open ABSENT_FROM_READ departure — their source row is gone, so the mirror is frozen by design',
        },
        right: {
          label: 'Expected',
          value: 0,
          measuredBy:
            'a constant: both columns are written from the same master-sync read, so any disagreement is a defect rather than a tolerance to tune',
        },
        likelySources: [
          'The lifecycle pass is not running. `MasterSyncService.reconcileDepartures` returns early when its DeviceDepartureService is not injected, leaving entity_stats.departures at {0,0,0} with no error — check `lifecycle.quietRuns` on /api/integration/health, which counts consecutive SUCCESS syncs that moved nothing.',
          'The absence guard is tripping every run: above the max-absence ratio the whole absence pass is abandoned, so genuine departures are never recorded and the drift climbs silently.',
          'A device whose source row vanished AFTER it was departed for an observed status — it carries reason SOURCE_STATUS, so it is not excluded here, but its mirror can never refresh either.',
          'Direct data manipulation that set device_states.is_departed without an accompanying device_departures row (or vice versa) — the two are kept in step only by DeviceStateService.recompute.',
        ],
        // Both sides come from one aggregate in AutoPlantHealthService; there is no second statement.
        sql: developerMode
          ? { left: 'AutoPlantHealthService.lifecycleHealth() — see health.service.ts', right: 'constant 0' }
          : undefined,
      }),
      ...this.autoplantIdentities(autoplant, developerMode),
    ];

    return {
      checkedAt: new Date().toISOString(),
      // UNAVAILABLE does not flip this to FAIL — see the ReconciliationReport.status docstring.
      status: identities.every((i) => i.status !== 'FAIL') ? 'PASS' : 'FAIL',
      identities,
      durationMs: Date.now() - startedAt,
    };
  }

  /**
   * Identities 7–8 (#217 S3) — AutoPlant source-vs-FSM row counts, entirely from
   * `AutoPlantHealthService.reconciliationHealth()`. When AutoPlant is unconfigured (every dev/test/CI
   * box, and any deployment that hasn't opted in) both come back UNAVAILABLE with the service's own
   * `error` string, rather than a fabricated PASS/FAIL over data that was never read.
   */
  private autoplantIdentities(
    health: Awaited<ReturnType<AutoPlantHealthService['reconciliationHealth']>>,
    developerMode: boolean,
  ): ReconciliationIdentity[] {
    const specs: Array<{ key: string; name: string; entity: 'plants' | 'vehicles'; table: string }> = [
      { key: 'autoplantPlantsCount', name: 'AutoPlant plants match FSM', entity: 'plants', table: 'plants' },
      { key: 'autoplantVehiclesCount', name: 'AutoPlant vehicles match FSM', entity: 'vehicles', table: 'vehicles' },
    ];

    return specs.map(({ key, name, entity, table }) => {
      const statement = `AutoPlant ${entity} (in scope) = FSM ${table} (mirrored), within ${readReconMaxDrift()} row(s)`;
      const row = health.entities.find((e) => e.entity === entity);

      if (!row) {
        return {
          key,
          name,
          statement,
          status: 'UNAVAILABLE',
          left: { label: `AutoPlant ${entity} (source)`, value: 0, measuredBy: 'unavailable' },
          right: { label: `FSM ${table} (mirrored)`, value: 0, measuredBy: 'unavailable' },
          difference: 0,
          likelySources: [],
          unavailableReason:
            health.error ?? 'AutoPlant source counts unavailable in this environment.',
        };
      }

      const withinTolerance = Math.abs(row.drift) <= health.maxDriftAllowed;
      return {
        key,
        name,
        statement,
        status: withinTolerance ? 'PASS' : 'FAIL',
        left: {
          label: `AutoPlant ${entity} (source)`,
          value: row.sourceCount,
          measuredBy: `live COUNT(*) over AutoPlant, the SAME scope filter the master sync reads with (Issue 97 Slice 5)`,
        },
        right: {
          label: `FSM ${table} (mirrored)`,
          value: row.fsmCount,
          measuredBy: `COUNT(*) over ${table}`,
        },
        difference: row.drift,
        likelySources: withinTolerance
          ? []
          : [
              'The zone-mapping backlog (SYSTEM-STATE §5) — a plant the crosswalk cannot yet place is still counted source-side but may be excluded from a downstream FSM read, depending on which one this is.',
              'A master sync is running concurrently with this check — the two counts are read at slightly different instants, not in one transaction.',
              'The master sync\'s own scope filter (ACTIVE plants) drifted from what this identity assumes — check master-sync.service.ts against master-mapping.ts\'s MasterSyncScope.',
            ],
        sql: developerMode
          ? {
              left: `AutoPlantMasterSource.count${entity === 'plants' ? 'Plants' : 'VehicleMasters'}() — reuses the master sync's own filter fragments, never a second spelling`,
              right: `SELECT COUNT(*) FROM ${table}`,
            }
          : undefined,
      };
    });
  }

  /** Compare the two sides and attach the story only when there is one to tell. */
  private identity(
    spec: Omit<ReconciliationIdentity, 'status' | 'difference'> & { likelySources: string[] },
  ): ReconciliationIdentity {
    const difference = spec.left.value - spec.right.value;
    const status: IdentityStatus = difference === 0 ? 'PASS' : 'FAIL';
    return {
      ...spec,
      status,
      difference,
      likelySources: status === 'FAIL' ? spec.likelySources : [],
    };
  }
}
