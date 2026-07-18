import type { MasterSourceCounts } from './health.service';
import type { MasterSyncSource } from './master-sync.service';
import type {
  MstCompanyRow,
  MstPlantRow,
  MstTransporterRow,
  VehicleMasterMasterRow,
} from './master-mapping';

/**
 * The production `MasterSyncSource` over AutoPlant `ap_masters` (Phase 4). Read-only, schema-qualified
 * SELECTs through `AutoPlantMysqlClient` (the connection defaults to `ap_widgets`, so masters are
 * qualified with the configured `ap_masters` schema). Column names are the authoritative DESCRIBEs in
 * `docs/autoplant/` — not inferred from sample rows.
 *
 * Three facts the production schema forced:
 *   • `mst_plant.master_plant_id` / `master_plant_code` are a DISTINCT parent reference (≠ the plant's
 *     own `plant_id`/`plant_code`) — those are what FSM mirrors as `master_plant_*`.
 *   • `mst_vehicle.company_id` is unreliable (0 in production); a vehicle's authoritative company is its
 *     plant's company, so `readVehicleMasters` resolves it via `LEFT JOIN mst_plant … p.company_id`.
 *   • Device identity (`DEVICE_TYPE`, `IMSI_NO`) is not in `ap_masters` at all — it lives one schema
 *     over on `ap_widgets.tb_vehiclemaster`, so `readVehicleMasters` reaches across the boundary for
 *     it. Only STATIC attributes are taken from there; live trip/telemetry state stays on the
 *     30-min snapshot path (see the note on `readVehicleMasters`).
 *
 * **Bounded reads (DBA "< 100 rows/query" cap).** Production is large (59k vehicles / 27k plants), and
 * the read-only account is capped at under 100 rows per query. Every read is therefore keyset-paginated
 * on the table's primary key at `pageSize` (default 90) and concatenated — never a single unbounded
 * SELECT. Source-side status filters (`plantStatuses` / `deploymentStatuses`) also push the fleet scope
 * into SQL so we page ~1k ACTIVE plants / ~18k DEPLOYED vehicles instead of the whole tables; the
 * authoritative in-memory scope (`MasterSyncScope`) still applies on top (defence in depth).
 */
export interface AutoPlantMasterSourceDeps {
  /** Read-only query into the AutoPlant MySQL (satisfied by `AutoPlantMysqlClient.query`). */
  query: <T>(sql: string, params?: readonly unknown[]) => Promise<T[]>;
  /** The `ap_masters` schema name (from `AutoPlantMysqlConfig.dbMasters`) — never hard-coded. */
  mastersSchema: string;
  /**
   * The `ap_widgets` schema name (from `AutoPlantMysqlConfig.dbWidgets`) — enables the device-identity
   * enrichment join in `readVehicleMasters` (DEVICE_TYPE / IMSI_NO, which exist only there). Omit and
   * the join is skipped and both columns read NULL: the shape unit tests use when they stub `query`.
   */
  widgetsSchema?: string;
  /** Rows per physical query — kept < 100 for the DBA cap. Default 90. */
  pageSize?: number;
  /** `mst_plant.status` values to read (SQL filter). Empty ⇒ no status filter. Default `['ACTIVE']`. */
  plantStatuses?: string[];
  /** `mst_vehicle.deployment_status` values to read (SQL filter). Empty ⇒ no filter. Default `['DEPLOYED']`. */
  deploymentStatuses?: string[];
}

/** Keep the first row per key, preserving order — dedup helper for the composite-PK plant fan-out. */
function dedupBy<T>(rows: T[], keyOf: (row: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    const k = keyOf(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

export class AutoPlantMasterSource implements MasterSyncSource, MasterSourceCounts {
  private readonly query: AutoPlantMasterSourceDeps['query'];
  private readonly mastersSchema: string;
  private readonly widgetsSchema: string | undefined;
  private readonly pageSize: number;
  private readonly plantStatuses: string[];
  private readonly deploymentStatuses: string[];

  constructor(deps: AutoPlantMasterSourceDeps) {
    this.query = deps.query;
    this.mastersSchema = deps.mastersSchema;
    this.widgetsSchema = deps.widgetsSchema;
    this.pageSize = Math.max(1, Math.min(99, deps.pageSize ?? 90));
    this.plantStatuses = deps.plantStatuses ?? ['ACTIVE'];
    this.deploymentStatuses = deps.deploymentStatuses ?? ['DEPLOYED'];
  }

  /** Backtick-qualify a masters table with the configured schema (defence-in-depth against the default schema). */
  private table(name: string): string {
    return `\`${this.mastersSchema}\`.\`${name}\``;
  }

  /** Backtick-qualify the widgets telemetry table (device-identity enrichment source). */
  private widgetsTable(name: string): string {
    return `\`${this.widgetsSchema}\`.\`${name}\``;
  }

  /** Build an `IN (?, ?, …)` predicate for a status filter, or null when the filter is empty. */
  private inClause(column: string, values: string[]): { sql: string; params: string[] } | null {
    if (values.length === 0) return null;
    return { sql: `${column} IN (${values.map(() => '?').join(', ')})`, params: [...values] };
  }

  /**
   * Keyset-paginate a SELECT on a single ascending key column, concatenating pages of ≤ `pageSize`.
   * `keyColumn` is the (qualified) PK used for both ORDER BY and the `> cursor` continuation; `keyOf`
   * pulls the cursor value from the last row. `where` (already parametrised) is ANDed on every page.
   */
  private async pageAll<T>(opts: {
    select: string;
    from: string;
    where: { sql: string; params: unknown[] } | null;
    keyColumn: string;
    keyOf: (row: T) => string | number;
  }): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | number | null = null;
    for (;;) {
      const conds: string[] = [];
      const params: unknown[] = [];
      if (opts.where) {
        conds.push(`(${opts.where.sql})`);
        params.push(...opts.where.params);
      }
      if (cursor !== null) {
        conds.push(`${opts.keyColumn} > ?`);
        params.push(cursor);
      }
      const whereSql = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
      const sql =
        `SELECT ${opts.select} FROM ${opts.from}${whereSql} ` +
        `ORDER BY ${opts.keyColumn} LIMIT ${this.pageSize}`;
      const page = await this.query<T>(sql, params);
      out.push(...page);
      if (page.length < this.pageSize) break;
      cursor = opts.keyOf(page[page.length - 1]);
    }
    return out;
  }

  /** Single-row COUNT for a reconciliation read (Issue 97 Slice 5 / review A6) — one physical query. */
  private async countOne(select: string, from: string, where: { sql: string; params: string[] } | null): Promise<number> {
    const whereSql = where ? ` WHERE ${where.sql}` : '';
    const rows = await this.query<{ c: number | string }>(
      `SELECT ${select} AS c FROM ${from}${whereSql}`,
      where?.params ?? [],
    );
    return Number(rows[0]?.c ?? 0);
  }

  /**
   * Distinct in-scope plants — DISTINCT plant_id mirrors `readPlants`' composite-PK dedup, and the
   * status filter is the same `inClause` the paged read uses, so this count can never diverge from
   * what a sync would actually upsert.
   */
  countPlants(): Promise<number> {
    return this.countOne(
      'COUNT(DISTINCT plant_id)',
      this.table('mst_plant'),
      this.inClause('status', this.plantStatuses),
    );
  }

  /** In-scope vehicle-master rows under the same deployment filter (no join — a count needs no company). */
  countVehicleMasters(): Promise<number> {
    return this.countOne(
      'COUNT(*)',
      this.table('mst_vehicle'),
      this.inClause('deployment_status', this.deploymentStatuses),
    );
  }

  readCompanies(): Promise<MstCompanyRow[]> {
    return this.pageAll<MstCompanyRow>({
      select: 'company_id, company_name, company_type, status',
      from: this.table('mst_company'),
      where: null,
      keyColumn: 'company_id',
      keyOf: (r) => Number(r.company_id),
    });
  }

  readTransporters(): Promise<MstTransporterRow[]> {
    return this.pageAll<MstTransporterRow>({
      select: 'transporter_id, company_id, transporter_name, status',
      from: this.table('mst_transporter'),
      where: null,
      keyColumn: 'transporter_id',
      keyOf: (r) => String(r.transporter_id),
    });
  }

  async readPlants(): Promise<MstPlantRow[]> {
    const rows = await this.pageAll<MstPlantRow>({
      select:
        'plant_id, company_id, plant_name, zone_id, zone_name, region_id, region_name, ' +
        'plant_state, plant_district, master_plant_id, master_plant_code, status',
      from: this.table('mst_plant'),
      where: this.inClause('status', this.plantStatuses),
      keyColumn: 'plant_id',
      keyOf: (r) => Number(r.plant_id),
    });
    // `mst_plant`'s PK is COMPOSITE (plant_id, plant_code) → a plant_id repeats once per plant_code.
    // FSM keys plants on plant_id alone (sourcePlantId), so dedup to one row per plant_id here — keeps
    // the pending zone-mapping seen_count honest and avoids redundant upserts downstream.
    return dedupBy(rows, (r) => String(r.plant_id));
  }

  readVehicleMasters(): Promise<VehicleMasterMasterRow[]> {
    // Company via the plant (p.company_id) — mst_vehicle.company_id is 0/unreliable in production.
    // The plant join is a GROUP-BY-plant_id SUBQUERY (not a raw join): `mst_plant`'s composite PK
    // (plant_id, plant_code) would otherwise fan each vehicle out per plant_code — inflating the read
    // ~2× and making a vehicle's company nondeterministic (last plant_code's company wins). Keyset on
    // the natural PK v.vehicle_no; deployment scope pushed into SQL.
    //
    // DEVICE_TYPE / IMSI_NO have no home in `mst_vehicle` — they live across the schema boundary on
    // `ap_widgets.tb_vehiclemaster`, so they are joined in here (this read previously hardcoded
    // `NULL AS device_type`, which left devices.device_type NULL for the whole fleet — 0 of 20,935 on
    // 2026-07-17 — while mapDevice dutifully mirrored the NULL back on every sync).
    //
    // The join is safe and free: `tb_vehiclemaster.vehicle_no` is the PK and verified unique on
    // production (60,601 rows / 60,601 distinct), so it cannot fan a vehicle out; and it rides the
    // SAME paged queries, so the DBA's <100-rows/query cap and the query count are both unchanged.
    // Verified 2026-07-17: all 15,674 DEPLOYED vehicles match a widgets row (100% join coverage).
    //
    // Only STATIC device identity is taken from widgets here. `TRIP_CREATION_DATETIME` is deliberately
    // NOT read on this path: it is current-trip state (18.4% of the DEPLOYED fleet changes it per day),
    // so it rides the 30-min snapshot tick onto `device_states` instead — a daily sync would leave it
    // ~2,600 vehicles/day stale. Keep the lifecycle split; do not "tidy" it back together.
    //
    // No enrichment when `widgetsSchema` is unset (unit tests stubbing `query`): both columns read NULL,
    // exactly as before. When it IS set, a widgets outage fails the run rather than degrading it — that
    // is deliberate. Since mapDevice MIRRORS these columns, a run that silently substituted NULLs would
    // wipe device_type/imsi_no across the fleet; a failed run writes nothing and is visible in the ledger.
    const enrich = this.widgetsSchema !== undefined;
    return this.pageAll<VehicleMasterMasterRow>({
      select:
        'v.vehicle_no AS vehicle_no, v.device_id AS device_id, v.plant_id AS plant_id, ' +
        'p.company_id AS company_id, v.transporter_id AS transporter_id, ' +
        'v.deployment_status AS deployment_status, ' +
        (enrich ? 'w.DEVICE_TYPE AS device_type, w.IMSI_NO AS imsi_no' : 'NULL AS device_type, NULL AS imsi_no'),
      from:
        `${this.table('mst_vehicle')} v LEFT JOIN ` +
        `(SELECT plant_id, MIN(company_id) AS company_id FROM ${this.table('mst_plant')} GROUP BY plant_id) p ` +
        'ON p.plant_id = v.plant_id' +
        (enrich ? ` LEFT JOIN ${this.widgetsTable('tb_vehiclemaster')} w ON w.vehicle_no = v.vehicle_no` : ''),
      where: this.inClause('v.deployment_status', this.deploymentStatuses),
      keyColumn: 'v.vehicle_no',
      keyOf: (r) => r.vehicle_no,
    });
  }
}
