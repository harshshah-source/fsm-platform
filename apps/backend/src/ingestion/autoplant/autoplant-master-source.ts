import type {
  MasterSyncSource,
} from './master-sync.service';
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
 * Two facts the production schema forced:
 *   • `mst_plant.master_plant_id` / `master_plant_code` are a DISTINCT parent reference (≠ the plant's
 *     own `plant_id`/`plant_code`) — those are what FSM mirrors as `master_plant_*`.
 *   • `mst_vehicle.company_id` is unreliable (0 in production); a vehicle's authoritative company is its
 *     plant's company, so `readVehicleMasters` resolves it via `LEFT JOIN mst_plant … p.company_id`.
 *
 * Reads are full-table for v1 (master tables are small relative to telemetry); chunked / delta reads
 * (`record_updated_date`, blueprint §5.7) are a later optimisation. The pure `master-mapping` layer +
 * `MasterSyncService` consume these rows unchanged.
 */
export interface AutoPlantMasterSourceDeps {
  /** Read-only query into the AutoPlant MySQL (satisfied by `AutoPlantMysqlClient.query`). */
  query: <T>(sql: string, params?: readonly unknown[]) => Promise<T[]>;
  /** The `ap_masters` schema name (from `AutoPlantMysqlConfig.dbMasters`) — never hard-coded. */
  mastersSchema: string;
}

export class AutoPlantMasterSource implements MasterSyncSource {
  private readonly query: AutoPlantMasterSourceDeps['query'];
  private readonly mastersSchema: string;

  constructor(deps: AutoPlantMasterSourceDeps) {
    this.query = deps.query;
    this.mastersSchema = deps.mastersSchema;
  }

  /** Backtick-qualify a masters table with the configured schema (defence-in-depth against the default schema). */
  private table(name: string): string {
    return `\`${this.mastersSchema}\`.\`${name}\``;
  }

  readCompanies(): Promise<MstCompanyRow[]> {
    return this.query<MstCompanyRow>(
      `SELECT company_id, company_name, company_type, status FROM ${this.table('mst_company')}`,
    );
  }

  readTransporters(): Promise<MstTransporterRow[]> {
    return this.query<MstTransporterRow>(
      `SELECT transporter_id, company_id, transporter_name, status FROM ${this.table('mst_transporter')}`,
    );
  }

  readPlants(): Promise<MstPlantRow[]> {
    return this.query<MstPlantRow>(
      'SELECT plant_id, company_id, plant_name, zone_id, zone_name, region_id, region_name, ' +
        'plant_state, plant_district, master_plant_id, master_plant_code, status ' +
        `FROM ${this.table('mst_plant')}`,
    );
  }

  readVehicleMasters(): Promise<VehicleMasterMasterRow[]> {
    // Company via the plant (p.company_id) — mst_vehicle.company_id is 0/unreliable in production.
    // device_type has no home in mst_vehicle (it lives on ap_widgets.tb_vehiclemaster.DEVICE_TYPE, a
    // non-load-bearing enrichment) → NULL here; the Snapshot path still records it per-ping.
    return this.query<VehicleMasterMasterRow>(
      'SELECT v.vehicle_no AS vehicle_no, v.device_id AS device_id, v.plant_id AS plant_id, ' +
        'p.company_id AS company_id, v.transporter_id AS transporter_id, ' +
        'v.deployment_status AS deployment_status, NULL AS device_type ' +
        `FROM ${this.table('mst_vehicle')} v ` +
        `LEFT JOIN ${this.table('mst_plant')} p ON p.plant_id = v.plant_id`,
    );
  }
}
