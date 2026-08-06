import { Prisma } from '../generated/prisma/client';

/**
 * The Operations Data Explorer dataset registry (#217 AC-6).
 *
 * One entry per investigable dataset. A dataset declares its `FROM`/`JOIN` shape once and its columns
 * with full lineage; the generic query engine (`dataset-query.service.ts`) does everything else. Adding
 * a dataset is therefore an entry in this file — **no new controller, service, route, or admin page**.
 *
 * Two rules make that safe, and both are pinned by test:
 *
 *  1. **Every SQL fragment in this file is code-authored.** Nothing a caller sends is ever interpolated
 *     into SQL. A request names a column by its registry `key`; the engine looks that key up and emits
 *     the registry's own `sql` fragment, or 400s. There is no path from request text to an identifier.
 *  2. **Every column carries its provenance.** `lineage` is not documentation — it is the answer the
 *     tool exists to give, and it is served from the same object the query is built from, so the
 *     "where does this number come from" answer cannot drift from the query that produced it.
 *
 * The `lineage` split mirrors the operator's two audiences: the operational half ships to Operations
 * Head, the `developer` half only when `OPS_EXPLORER_DEVELOPER_MODE` is on, and it is stripped
 * server-side (`serializeDataset`) rather than hidden in the client.
 */

/** Where a value physically comes from. `DERIVED` = computed in SQL from other columns in this row. */
export type SourceSystem = 'FSM_POSTGRES' | 'AUTOPLANT_MYSQL' | 'DERIVED';

export type ColumnType = 'string' | 'number' | 'boolean' | 'date' | 'enum';

/** Lineage that every audience sees. */
export interface OperationalLineage {
  /** One sentence: what this column means in domain terms. */
  definition: string;
  system: SourceSystem;
  /** The table this value lives in (or is derived from), by its physical name. */
  table: string;
  /** What makes the value change, and how often. */
  refreshTrigger: string;
  /** What the column deliberately does NOT reflect — the half an operator cannot infer from the label. */
  excludes?: string[];
}

/** Lineage that only Developer Mode sees. */
export interface DeveloperLineage {
  /** The physical column, or `null` when the value has no single column (a derived expression). */
  column: string | null;
  /** The exact SQL expression selected for this column. */
  expression: string;
  /** Present when the value is computed rather than read — the arithmetic, in source-column terms. */
  formula?: string;
  /** The service/method that owns this reading elsewhere in the app, so two spellings can be compared. */
  ownedBy?: string;
}

export interface DatasetColumn {
  key: string;
  label: string;
  type: ColumnType;
  /**
   * The code-authored SQL expression for this column. Emitted verbatim via `Prisma.raw` **only after**
   * the caller's key has been matched against this registry — see rule 1 above.
   */
  sql: string;
  filterable: boolean;
  sortable: boolean;
  /** Allowed values for `enum` columns; also drives the admin filter builder's value picker. */
  enumValues?: readonly string[];
  /** Included in the dataset's default column selection. Everything else is opt-in via the column picker. */
  defaultVisible: boolean;
  /**
   * Turns this cell into a link on the admin side. `route` is a path template with `:value`
   * substituted by the row's value — deliberately a template rather than a function so the registry
   * stays serializable and the FE needs no per-dataset code.
   *
   * By default `:value` is the cell's OWN displayed value (`column.sql`) — right when the display
   * value already is the link target, e.g. a ticket's UUID. When the display value is something else
   * — a plant's NAME, say, linking into a route that takes a plant ID — set `valueSql` to the code-
   * authored expression for the real target. The query engine projects it as a second, hidden field
   * (`__dd_<key>`) alongside the display value; the row still gets exactly one column definition, one
   * source of truth for both what it shows and where it points. `valueSql` never reaches the client —
   * `serializeDataset` strips it in every mode, same as every other raw SQL fragment.
   */
  drilldown?: { label: string; route: string; valueSql?: string };
  lineage: OperationalLineage & { developer: DeveloperLineage };
}

export interface DatasetDefinition {
  key: string;
  name: string;
  /** What question this dataset answers. Shown under the dataset picker. */
  description: string;
  /** The grain of one row — the single most misread property of any table. */
  grain: string;
  /** `FROM ... JOIN ...`, without the `FROM` keyword. Code-authored, never request-derived. */
  from: string;
  /**
   * Rows this dataset structurally never shows, as a SQL predicate — e.g. a dataset scoped to live
   * plants. Kept separate from user filters so it can be *reported* to the operator as an exclusion
   * rather than silently narrowing their result.
   */
  baseWhere?: { sql: string; reason: string };
  columns: DatasetColumn[];
  /** Column keys the global search scans (ILIKE). Only `string` columns are meaningful here. */
  searchColumns: string[];
  defaultSort: { column: string; direction: 'asc' | 'desc' };
}

// ---------------------------------------------------------------------------------------------
// devices — Slice 1's dataset. Chosen first because it is the widest join in the system (device →
// vehicle → plant → zone / company / transporter) and because it is the population every KPI
// reconciliation identity is stated over, so the explorer and the dashboard can be checked against
// each other from day one.
// ---------------------------------------------------------------------------------------------

/**
 * `is_departed` gets named in the `excludes` of every count-shaped column here on purpose. It is the
 * exact ambiguity that produced #176's live defect — a "total" that silently mixed warehouse and
 * operational devices — and an explorer that repeats the ambiguity would be worse than no explorer.
 */
const DEPARTED_NOTE =
  'A departed device (an open device_departures row) is in a warehouse, not broken: it is excluded from is_inactive, sla_bucket and eligible_for_uptime by DeviceStateService, so it is neither healthy nor inactive.';

const DEVICES: DatasetDefinition = {
  key: 'devices',
  name: 'Devices & device state',
  description:
    'Every device FSM mirrors, joined to its live derived state and its full fitment chain. The population every fleet KPI is computed over.',
  grain: 'One row per device_id.',
  from: `devices d
    LEFT JOIN device_states ds ON ds.device_id = d.device_id
    LEFT JOIN vehicles v ON v.vehicle_id = d.current_vehicle_id
    LEFT JOIN plants p ON p.plant_id = v.plant_id
    LEFT JOIN zones z ON z.zone_id = p.zone_id
    LEFT JOIN company_master c ON c.company_id = v.company_id
    LEFT JOIN transporters t ON t.transporter_id = v.transporter_id`,
  searchColumns: ['deviceId', 'vehicleNo', 'plantName', 'companyName', 'imsiNo', 'deviceType'],
  defaultSort: { column: 'inactivityHours', direction: 'desc' },
  columns: [
    {
      key: 'deviceId',
      label: 'Device ID',
      type: 'string',
      sql: 'd.device_id',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      // No drilldown: `/reports/device` has no single-device deep-link — its URL contract is
      // zoneId/companyId/plantId/bucket/status query params only (`DeviceDetailPage.tsx`), and
      // `deviceId` in the URL is silently ignored. A link that lands on the unfiltered list is worse
      // than no link in a tool whose entire premise is "click through to the real rows".
      lineage: {
        definition:
          'The AutoPlant business identifier for the GPS unit. A string, not a number — leading-zero IMEIs are real and must never be numerically coerced.',
        system: 'AUTOPLANT_MYSQL',
        table: 'devices (mirrored from ap_masters.mst_vehicle)',
        refreshTrigger: 'Daily master sync (ingestion-masters cron, 02:00).',
        developer: {
          column: 'devices.device_id',
          expression: 'd.device_id',
          ownedBy: 'MasterSyncService.mapDevice',
        },
      },
    },
    {
      key: 'deviceType',
      label: 'Device type',
      type: 'string',
      sql: 'd.device_type',
      filterable: true,
      sortable: true,
      defaultVisible: false,
      lineage: {
        definition: 'Hardware model, read from AutoPlant’s widgets schema during master sync.',
        system: 'AUTOPLANT_MYSQL',
        table: 'devices ← ap_widgets.tb_vehiclemaster',
        refreshTrigger: 'Daily master sync. Was NULL fleet-wide until the 2026-07-17 enrichment join.',
        excludes: ['Rows synced before 2026-07-17 that have not re-synced since'],
        developer: {
          column: 'devices.device_type',
          expression: 'd.device_type',
          ownedBy: 'AutoPlantSourceReader.readVehicleMasters (LEFT JOIN ap_widgets.tb_vehiclemaster)',
        },
      },
    },
    {
      key: 'imsiNo',
      label: 'IMSI',
      type: 'string',
      sql: 'd.imsi_no',
      filterable: true,
      sortable: false,
      defaultVisible: false,
      lineage: {
        definition: 'SIM IMSI, from the same AutoPlant widgets join as device type.',
        system: 'AUTOPLANT_MYSQL',
        table: 'devices ← ap_widgets.tb_vehiclemaster',
        refreshTrigger: 'Daily master sync.',
        developer: { column: 'devices.imsi_no', expression: 'd.imsi_no' },
      },
    },
    {
      key: 'dealType',
      label: 'Deal type',
      type: 'enum',
      sql: 'd.deal_type::text',
      enumValues: ['RECURRING', 'ONE_TIME'],
      filterable: true,
      sortable: true,
      defaultVisible: false,
      lineage: {
        definition:
          'Commercial deal classification. FSM-owned: set by Operations Head, never overwritten by master sync.',
        system: 'FSM_POSTGRES',
        table: 'devices',
        refreshTrigger: 'Operations Head manual tagging (Issue 49). No automatic writer.',
        excludes: ['Devices never tagged — NULL is the norm, not an error'],
        developer: { column: 'devices.deal_type', expression: 'd.deal_type::text' },
      },
    },
    {
      key: 'vehicleNo',
      label: 'Vehicle',
      type: 'string',
      sql: 'v.vehicle_no',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      lineage: {
        definition: 'Registration of the vehicle this device is currently fitted to.',
        system: 'AUTOPLANT_MYSQL',
        table: 'vehicles (mirrored)',
        refreshTrigger: 'Daily master sync; a re-fitment moves devices.current_vehicle_id.',
        excludes: ['Devices with no current fitment — the join is LEFT, so these show blank rather than vanish'],
        developer: { column: 'vehicles.vehicle_no', expression: 'v.vehicle_no' },
      },
    },
    {
      key: 'plantName',
      label: 'Plant',
      type: 'string',
      sql: 'p.name',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      // The link needs the plant's ID; the column displays its NAME. valueSql carries the id as a
      // hidden companion projection — see the DatasetColumn.drilldown docstring.
      drilldown: { label: 'Plant devices', route: '/reports/device?plantId=:value', valueSql: 'p.plant_id::text' },
      lineage: {
        definition: 'The site the fitted vehicle belongs to. The clustering unit for dispatch batches.',
        system: 'AUTOPLANT_MYSQL',
        table: 'plants (mirrored)',
        refreshTrigger: 'Daily master sync.',
        developer: { column: 'plants.name', expression: 'p.name' },
      },
    },
    {
      key: 'zoneName',
      label: 'Zone',
      type: 'string',
      sql: 'z.name',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      // `zones.zone_id::text` — UNZONED is a real zones row (a real id), not a null, so the numeric id
      // works the same as any other zone's; DeviceDetailPage separately also accepts the literal
      // string "UNZONED" but the id is unambiguous and needs no special-casing here.
      drilldown: { label: 'Zone devices', route: '/reports/device?zoneId=:value', valueSql: 'z.zone_id::text' },
      lineage: {
        definition:
          'The FSM zone of the device’s plant — the unit of Zonal Manager authority. NOTE: the literal zone named "UNZONED" is a real holding zone containing thousands of devices; it is NOT the same population as "plant has no zone" (issue #192). This column reports the holding zone, by name.',
        system: 'FSM_POSTGRES',
        table: 'zones ← plants.zone_id',
        refreshTrigger:
          'Master sync zone resolution (plant_zone_overrides pin → zone_mappings MAPPED → UNZONED), and any ZoneMappingService.reapply.',
        excludes: [
          'This is the plant’s CURRENT zone. A ticket dispatched before a mid-day zone move stays under the old zone until the next run.',
        ],
        developer: {
          column: 'zones.name',
          expression: 'z.name',
          ownedBy: 'MappingTableZoneResolver',
        },
      },
    },
    {
      key: 'companyName',
      label: 'Company',
      type: 'string',
      sql: 'c.name',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      drilldown: {
        label: 'Company devices',
        route: '/reports/device?companyId=:value',
        valueSql: 'c.company_id::text',
      },
      lineage: {
        definition: 'The customer account owning the vehicle.',
        system: 'AUTOPLANT_MYSQL',
        table: 'company_master (mirrored)',
        refreshTrigger: 'Daily master sync; companies are derived — created only when an in-scope plant names them.',
        developer: { column: 'company_master.name', expression: 'c.name' },
      },
    },
    {
      key: 'companyTier',
      label: 'Tier',
      type: 'enum',
      sql: 'c.company_tier::text',
      enumValues: ['PLATINUM', 'GOLD', 'SILVER'],
      filterable: true,
      sortable: true,
      defaultVisible: false,
      lineage: {
        definition:
          'The company’s GLOBAL tier — sort key 1 of the recommender’s canonical order. This is not necessarily the tier the recommender used: a zone-scoped, unexpired company_tier_overrides row wins over it (#157).',
        system: 'FSM_POSTGRES',
        table: 'company_master',
        refreshTrigger: 'Operations Head edit. FSM-owned — excluded from the master-sync update set (anti-drift R4).',
        excludes: ['Zone-scoped tier overrides — see the effective-tier resolver, not this column'],
        developer: {
          column: 'company_master.company_tier',
          expression: 'c.company_tier::text',
          ownedBy: 'effective-tier.ts (resolves the override this column ignores)',
        },
      },
    },
    {
      key: 'transporterName',
      label: 'Transporter',
      type: 'string',
      sql: 't.name',
      filterable: true,
      sortable: true,
      defaultVisible: false,
      lineage: {
        definition: 'The transporter operating the vehicle, where AutoPlant records one.',
        system: 'AUTOPLANT_MYSQL',
        table: 'transporters (mirrored)',
        refreshTrigger: 'Daily master sync.',
        developer: { column: 'transporters.name', expression: 't.name' },
      },
    },
    {
      key: 'latestGpsDatetime',
      label: 'Last ping',
      type: 'date',
      sql: 'ds.latest_gps_datetime',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      lineage: {
        definition: 'Timestamp of the most recent GPS ping seen for this device. The anchor for every inactivity figure.',
        system: 'FSM_POSTGRES',
        table: 'device_states',
        refreshTrigger:
          'Maintained incrementally AT INGEST by SnapshotIngestionService (30-min telemetry tick), not by the daily master sync.',
        excludes: [
          'Pings that arrived while INGESTION_SCHEDULER_ENABLED was false — nothing writes them, so this stamp ages without the device being silent',
        ],
        developer: {
          column: 'device_states.latest_gps_datetime',
          expression: 'ds.latest_gps_datetime',
          ownedBy: 'SnapshotIngestionService (set-based unnest + GREATEST upsert)',
        },
      },
    },
    {
      key: 'inactivityHours',
      label: 'Inactive (h)',
      type: 'number',
      sql: 'ds.inactivity_hours',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      lineage: {
        definition: 'Hours since the last ping, clamped at zero. Recomputed on the telemetry tick because it ages with wall-clock time.',
        system: 'DERIVED',
        table: 'device_states',
        refreshTrigger: '30-minute device-state recompute.',
        developer: {
          column: 'device_states.inactivity_hours',
          expression: 'ds.inactivity_hours',
          formula: 'GREATEST(0, EXTRACT(EPOCH FROM (now() - latest_gps_datetime)) / 3600)',
          ownedBy: 'DeviceStateService.recompute',
        },
      },
    },
    {
      key: 'slaBucket',
      label: 'SLA bucket',
      type: 'enum',
      sql: 'ds.sla_bucket::text',
      // The eight bands, in the schema's `sla_bucket` enum order (schema.prisma). NOT severity order —
      // severity is the ordinal ramp in `lib/slaBucket.ts`; listing them by declaration order keeps this
      // a faithful mirror of the database rather than a second, driftable opinion about severity.
      enumValues: [
        'WARNING',
        'EARLY_RISK',
        'RISK',
        'CRITICAL',
        'HIGH_CRITICAL',
        'SEVERE',
        'VERY_SEVERE',
        'LONG_PENDING',
      ],
      filterable: true,
      sortable: true,
      defaultVisible: true,
      lineage: {
        definition:
          'Stored severity band derived from inactivity hours. Stored rather than computed at read time so the queue can filter on it with an index.',
        system: 'DERIVED',
        table: 'device_states',
        refreshTrigger: '30-minute device-state recompute.',
        excludes: [DEPARTED_NOTE, 'Healthy devices — the bucket is NULL when the device is not inactive'],
        developer: {
          column: 'device_states.sla_bucket',
          expression: 'ds.sla_bucket::text',
          formula: 'SQL CASE generated from the same SLA_BANDS the TS classifier uses (sla-bucket.ts) — the two cannot drift',
          ownedBy: 'DeviceStateService.recompute',
        },
      },
    },
    {
      key: 'isInactive',
      label: 'Inactive?',
      type: 'boolean',
      sql: 'ds.is_inactive',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      lineage: {
        definition:
          'Whether the device has been silent for longer than the inactivity threshold (system_settings.inactivity_threshold_hours, default 24).',
        system: 'DERIVED',
        table: 'device_states',
        refreshTrigger: '30-minute device-state recompute.',
        excludes: [DEPARTED_NOTE],
        developer: {
          column: 'device_states.is_inactive',
          expression: 'ds.is_inactive',
          formula: 'NOT is_departed AND inactivity_hours >= inactivity_threshold_hours',
          ownedBy: 'DeviceStateService.recompute',
        },
      },
    },
    {
      key: 'isDeparted',
      label: 'Warehouse?',
      type: 'boolean',
      sql: 'ds.is_departed',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      lineage: {
        definition:
          'Whether the device has been removed from field operations (an open device_departures row). A departed device is in a warehouse, not broken.',
        system: 'DERIVED',
        table: 'device_states ← device_departures',
        refreshTrigger: '30-minute device-state recompute (Issue 128).',
        developer: {
          column: 'device_states.is_departed',
          expression: 'ds.is_departed',
          formula: 'EXISTS (an ACTIVE device_departures row for this device)',
          ownedBy: 'DeviceStateService.recompute',
        },
      },
    },
    {
      key: 'eligibleForUptime',
      label: 'Uptime-eligible?',
      type: 'boolean',
      sql: 'ds.eligible_for_uptime',
      filterable: true,
      sortable: true,
      defaultVisible: false,
      lineage: {
        definition:
          'Whether this device counts toward Fleet Uptime and can have a ticket opened for it. Gated by the eligibility_mode setting.',
        system: 'DERIVED',
        table: 'device_states',
        refreshTrigger: '30-minute device-state recompute; changes wholesale when Ops flips eligibility_mode.',
        excludes: [
          'Under eligibility_mode = "pgi" over an empty pgi_history this is false fleet-wide, and zero tickets are created (blocker B7)',
        ],
        developer: {
          column: 'device_states.eligible_for_uptime',
          expression: 'ds.eligible_for_uptime',
          formula:
            'pgi mode: EXISTS a pgi_history row within DEFAULT_PGI_WINDOW_DAYS (15). all-deployed mode: vehicle status IN (ACTIVE, DEPLOYED). Both AND NOT an active Non-Op marking.',
          ownedBy: 'eligibility.ts (#112)',
        },
      },
    },
    {
      key: 'hasOpenFailureCycle',
      label: 'Open cycle?',
      type: 'boolean',
      sql: 'ds.has_open_failure_cycle',
      filterable: true,
      sortable: true,
      defaultVisible: false,
      lineage: {
        definition: 'Whether an inactivity episode is currently open for this device — i.e. it already has live work.',
        system: 'FSM_POSTGRES',
        table: 'device_states',
        refreshTrigger:
          'Flipped by ticket creation and by cycle closure — deliberately NOT touched by the device-state recompute.',
        developer: {
          column: 'device_states.has_open_failure_cycle',
          expression: 'ds.has_open_failure_cycle',
          ownedBy: 'TicketCreationService / cycle closure paths',
        },
      },
    },
    {
      key: 'computedAt',
      label: 'State computed at',
      type: 'date',
      sql: 'ds.computed_at',
      filterable: true,
      sortable: true,
      defaultVisible: false,
      lineage: {
        definition: 'When this device_states row was last recomputed — the freshness stamp for every derived column above.',
        system: 'FSM_POSTGRES',
        table: 'device_states',
        refreshTrigger: 'Every device-state recompute.',
        developer: { column: 'device_states.computed_at', expression: 'ds.computed_at' },
      },
    },
    {
      key: 'plantStatus',
      label: 'Plant status',
      type: 'string',
      sql: 'p.status',
      filterable: true,
      sortable: true,
      defaultVisible: false,
      lineage: {
        definition: 'The AutoPlant-reported plant status. Distinct from FSM plant deactivation, which lives in its own side table.',
        system: 'AUTOPLANT_MYSQL',
        table: 'plants (mirrored)',
        refreshTrigger: 'Daily master sync (scope anchors on status = ACTIVE).',
        excludes: ['FSM-owned deactivation (#119) — that is plant_deactivations, not this column'],
        developer: { column: 'plants.status', expression: 'p.status' },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// zones / companies / plants / vehicles — the remaining FSM + AutoPlant master data (#217 S2).
// Every drilldown here targets `/reports/device`'s existing zoneId/companyId/plantId query params
// (`DeviceDetailPage.tsx`) — no new routes, no new pages. Where the display column and the link
// target differ (an id-taking route, a name-showing column), `drilldown.valueSql` carries the real
// target as a hidden companion projection; see the `DatasetColumn.drilldown` docstring.
// ---------------------------------------------------------------------------------------------

const ZONES: DatasetDefinition = {
  key: 'zones',
  name: 'Zones',
  description: 'The unit of Zonal Manager authority, and the FSM-owned home for every plant.',
  grain: 'One row per zone_id.',
  from: `zones z LEFT JOIN users u ON u.user_id = z.zonal_manager_user_id`,
  searchColumns: ['name', 'zonalManagerName'],
  defaultSort: { column: 'name', direction: 'asc' },
  columns: [
    {
      key: 'zoneId',
      label: 'Zone ID',
      type: 'number',
      sql: 'z.zone_id',
      filterable: true,
      sortable: true,
      defaultVisible: false,
      lineage: {
        definition: 'The internal FSM zone id — the value every other dataset’s zoneId filter/drilldown targets.',
        system: 'FSM_POSTGRES',
        table: 'zones',
        refreshTrigger: 'Never changes after creation.',
        developer: { column: 'zones.zone_id', expression: 'z.zone_id' },
      },
    },
    {
      key: 'name',
      label: 'Zone',
      type: 'string',
      sql: 'z.name',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      drilldown: { label: 'Zone devices', route: '/reports/device?zoneId=:value', valueSql: 'z.zone_id::text' },
      lineage: {
        definition:
          'The zone’s display name. Includes the literal "UNZONED" holding zone — a real row, not an absence (issue #192).',
        system: 'FSM_POSTGRES',
        table: 'zones',
        refreshTrigger: 'Operations Head edit (zone creation is an OH admin action).',
        developer: { column: 'zones.name', expression: 'z.name' },
      },
    },
    {
      key: 'zonalManagerName',
      label: 'Zonal Manager',
      type: 'string',
      sql: 'u.name',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      lineage: {
        definition: 'The user assigned as this zone’s Zonal Manager.',
        system: 'FSM_POSTGRES',
        table: 'zones ← zonal_manager_user_id → users',
        refreshTrigger: 'Operations Head assigns/reassigns a ZM to a zone.',
        excludes: ['A zone with no ZM assigned yet — the LEFT JOIN leaves this blank, not zero'],
        developer: { column: 'users.name', expression: 'u.name' },
      },
    },
    {
      key: 'createdAt',
      label: 'Created',
      type: 'date',
      sql: 'z.created_at',
      filterable: true,
      sortable: true,
      defaultVisible: false,
      lineage: {
        definition: 'When this zone was created.',
        system: 'FSM_POSTGRES',
        table: 'zones',
        refreshTrigger: 'Never changes after creation.',
        developer: { column: 'zones.created_at', expression: 'z.created_at' },
      },
    },
  ],
};

const COMPANIES: DatasetDefinition = {
  key: 'companies',
  name: 'Companies',
  description: 'Customer accounts — the tier and priority-rank source for the recommender’s canonical sort.',
  grain: 'One row per company_id.',
  from: `company_master c`,
  searchColumns: ['name', 'contractRef'],
  defaultSort: { column: 'name', direction: 'asc' },
  columns: [
    {
      key: 'companyId',
      label: 'Company ID',
      type: 'number',
      sql: 'c.company_id',
      filterable: true,
      sortable: true,
      defaultVisible: false,
      lineage: {
        definition: 'The internal FSM company id.',
        system: 'FSM_POSTGRES',
        table: 'company_master',
        refreshTrigger: 'Never changes after creation.',
        developer: { column: 'company_master.company_id', expression: 'c.company_id' },
      },
    },
    {
      key: 'name',
      label: 'Company',
      type: 'string',
      sql: 'c.name',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      drilldown: {
        label: 'Company devices',
        route: '/reports/device?companyId=:value',
        valueSql: 'c.company_id::text',
      },
      lineage: {
        definition: 'The customer account name.',
        system: 'AUTOPLANT_MYSQL',
        table: 'company_master (mirrored)',
        refreshTrigger: 'Daily master sync; companies are derived — created only when an in-scope plant names them.',
        developer: { column: 'company_master.name', expression: 'c.name' },
      },
    },
    {
      key: 'companyTier',
      label: 'Global tier',
      type: 'enum',
      sql: 'c.company_tier::text',
      enumValues: ['PLATINUM', 'GOLD', 'SILVER'],
      filterable: true,
      sortable: true,
      defaultVisible: true,
      lineage: {
        definition:
          'The company’s GLOBAL tier — sort key 1 of the recommender’s canonical order, before any zone-scoped override.',
        system: 'FSM_POSTGRES',
        table: 'company_master',
        refreshTrigger: 'Operations Head edit. FSM-owned — excluded from the master-sync update set (anti-drift R4).',
        excludes: ['Zone-scoped, expiring company_tier_overrides rows (#157) — not reflected here'],
        developer: {
          column: 'company_master.company_tier',
          expression: 'c.company_tier::text',
          ownedBy: 'effective-tier.ts (resolves the override this column ignores)',
        },
      },
    },
    {
      key: 'companyPriorityRank',
      label: 'Priority rank',
      type: 'string',
      sql: 'c.company_priority_rank',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      lineage: {
        definition: 'The tie-break rank within a tier, used by the recommender’s canonical sort.',
        system: 'FSM_POSTGRES',
        table: 'company_master',
        refreshTrigger: 'Operations Head edit.',
        developer: { column: 'company_master.company_priority_rank', expression: 'c.company_priority_rank' },
      },
    },
    {
      key: 'opsOverride',
      label: 'Ops override?',
      type: 'boolean',
      sql: 'c.ops_override',
      filterable: true,
      sortable: true,
      defaultVisible: false,
      lineage: {
        definition: 'Whether this company’s tier/rank was manually set by Operations rather than inherited from source.',
        system: 'FSM_POSTGRES',
        table: 'company_master',
        refreshTrigger: 'Operations Head edit.',
        developer: { column: 'company_master.ops_override', expression: 'c.ops_override' },
      },
    },
    {
      key: 'contractRef',
      label: 'Contract ref',
      type: 'string',
      sql: 'c.contract_ref',
      filterable: true,
      sortable: true,
      defaultVisible: false,
      lineage: {
        definition: 'Free-text reference to the commercial contract backing this account.',
        system: 'FSM_POSTGRES',
        table: 'company_master',
        refreshTrigger: 'Operations Head edit.',
        developer: { column: 'company_master.contract_ref', expression: 'c.contract_ref' },
      },
    },
    {
      key: 'companyType',
      label: 'Source type',
      type: 'string',
      sql: 'c.company_type',
      filterable: true,
      sortable: true,
      defaultVisible: false,
      lineage: {
        definition: 'AutoPlant’s own company-type field. Not used to scope master sync (deliberately — see plant-first derivation).',
        system: 'AUTOPLANT_MYSQL',
        table: 'company_master (mirrored)',
        refreshTrigger: 'Daily master sync.',
        excludes: ['Never used to gate which companies sync — that scope anchors on ACTIVE plants instead'],
        developer: { column: 'company_master.company_type', expression: 'c.company_type' },
      },
    },
    {
      key: 'status',
      label: 'Source status',
      type: 'string',
      sql: 'c.status',
      filterable: true,
      sortable: true,
      defaultVisible: false,
      lineage: {
        definition: 'AutoPlant’s own status field for this company.',
        system: 'AUTOPLANT_MYSQL',
        table: 'company_master (mirrored)',
        refreshTrigger: 'Daily master sync.',
        developer: { column: 'company_master.status', expression: 'c.status' },
      },
    },
    {
      key: 'createdAt',
      label: 'First synced',
      type: 'date',
      sql: 'c.created_at',
      filterable: true,
      sortable: true,
      defaultVisible: false,
      lineage: {
        definition: 'When this company was first created in FSM (its first in-scope plant’s sync).',
        system: 'FSM_POSTGRES',
        table: 'company_master',
        refreshTrigger: 'Never changes after creation.',
        developer: { column: 'company_master.created_at', expression: 'c.created_at' },
      },
    },
  ],
};

const PLANTS: DatasetDefinition = {
  key: 'plants',
  name: 'Plants',
  description: 'Sites — the clustering unit for dispatch batches, and the anchor of zone assignment.',
  grain: 'One row per plant_id.',
  from: `plants p
    LEFT JOIN zones z ON z.zone_id = p.zone_id
    LEFT JOIN districts d ON d.district_id = p.district_id`,
  searchColumns: ['name', 'sourceZoneName', 'plantState'],
  defaultSort: { column: 'name', direction: 'asc' },
  columns: [
    {
      key: 'plantId',
      label: 'Plant ID',
      type: 'number',
      sql: 'p.plant_id',
      filterable: true,
      sortable: true,
      defaultVisible: false,
      lineage: {
        definition: 'The internal FSM plant id — the value every drilldown into this plant’s devices targets.',
        system: 'FSM_POSTGRES',
        table: 'plants',
        refreshTrigger: 'Never changes after creation.',
        developer: { column: 'plants.plant_id', expression: 'p.plant_id' },
      },
    },
    {
      key: 'name',
      label: 'Plant',
      type: 'string',
      sql: 'p.name',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      drilldown: { label: 'Plant devices', route: '/reports/device?plantId=:value', valueSql: 'p.plant_id::text' },
      lineage: {
        definition: 'The site name.',
        system: 'AUTOPLANT_MYSQL',
        table: 'plants (mirrored)',
        refreshTrigger: 'Daily master sync.',
        developer: { column: 'plants.name', expression: 'p.name' },
      },
    },
    {
      key: 'zoneName',
      label: 'FSM zone',
      type: 'string',
      sql: 'z.name',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      drilldown: { label: 'Zone devices', route: '/reports/device?zoneId=:value', valueSql: 'z.zone_id::text' },
      lineage: {
        definition: 'The plant’s CURRENT FSM zone, per the zone-mapping crosswalk. The only stored copy of a plant’s zone — there is no separate history.',
        system: 'FSM_POSTGRES',
        table: 'plants.zone_id → zones',
        refreshTrigger: 'Master sync zone resolution, or a Plant Zones admin override + reapply (#158).',
        excludes: [
          'A mid-day zone move: today’s already-dispatched work_schedules stay under the OLD zone until the next dispatch run',
        ],
        developer: { column: 'zones.name', expression: 'z.name', ownedBy: 'MappingTableZoneResolver' },
      },
    },
    {
      key: 'sourceZoneName',
      label: 'AutoPlant zone (raw)',
      type: 'string',
      sql: 'p.source_zone_name',
      filterable: true,
      sortable: true,
      defaultVisible: false,
      lineage: {
        definition: 'The raw, un-normalised zone name as AutoPlant reported it — the crosswalk’s INPUT, before mapping.',
        system: 'AUTOPLANT_MYSQL',
        table: 'plants (mirrored)',
        refreshTrigger: 'Daily master sync.',
        excludes: ['Near-absent on ACTIVE plants fleet-wide — the root cause of the UNZONED backlog (SYSTEM-STATE §5)'],
        developer: { column: 'plants.source_zone_name', expression: 'p.source_zone_name' },
      },
    },
    {
      key: 'plantState',
      label: 'State',
      type: 'string',
      sql: 'p.plant_state',
      filterable: true,
      sortable: true,
      defaultVisible: false,
      lineage: {
        definition: 'AutoPlant’s plant_state (Indian state) field.',
        system: 'AUTOPLANT_MYSQL',
        table: 'plants (mirrored)',
        refreshTrigger: 'Daily master sync.',
        developer: { column: 'plants.plant_state', expression: 'p.plant_state' },
      },
    },
    {
      key: 'districtName',
      label: 'District',
      type: 'string',
      sql: 'd.name',
      filterable: true,
      sortable: true,
      defaultVisible: false,
      lineage: {
        definition: 'The FSM-side Indian district this plant is mapped to (used by FLOATING SE territory coverage).',
        system: 'FSM_POSTGRES',
        table: 'plants.district_id → districts',
        refreshTrigger: 'Set at plant creation from source geography.',
        excludes: ['A plant with no district mapping — the LEFT JOIN leaves this blank'],
        developer: { column: 'districts.name', expression: 'd.name' },
      },
    },
    {
      key: 'status',
      label: 'Source status',
      type: 'string',
      sql: 'p.status',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      lineage: {
        definition: 'AutoPlant’s reported plant status. Master sync scope anchors on status = ACTIVE.',
        system: 'AUTOPLANT_MYSQL',
        table: 'plants (mirrored)',
        refreshTrigger: 'Daily master sync.',
        excludes: ['FSM-owned deactivation (#119) — that is plant_deactivations, a separate side table not joined here'],
        developer: { column: 'plants.status', expression: 'p.status' },
      },
    },
    {
      key: 'masterPlantCode',
      label: 'Master plant code',
      type: 'string',
      sql: 'p.master_plant_code',
      filterable: true,
      sortable: true,
      defaultVisible: false,
      lineage: {
        definition: 'AutoPlant’s master plant code, distinct from the FSM-internal plant_id.',
        system: 'AUTOPLANT_MYSQL',
        table: 'plants (mirrored)',
        refreshTrigger: 'Daily master sync.',
        developer: { column: 'plants.master_plant_code', expression: 'p.master_plant_code' },
      },
    },
    {
      key: 'createdAt',
      label: 'First synced',
      type: 'date',
      sql: 'p.created_at',
      filterable: true,
      sortable: true,
      defaultVisible: false,
      lineage: {
        definition: 'When this plant was first created in FSM.',
        system: 'FSM_POSTGRES',
        table: 'plants',
        refreshTrigger: 'Never changes after creation.',
        developer: { column: 'plants.created_at', expression: 'p.created_at' },
      },
    },
  ],
};

const VEHICLES: DatasetDefinition = {
  key: 'vehicles',
  name: 'Vehicles',
  description: 'The fitment anchor between a device and its plant/company/transporter.',
  grain: 'One row per vehicle_id.',
  from: `vehicles v
    LEFT JOIN plants p ON p.plant_id = v.plant_id
    LEFT JOIN company_master c ON c.company_id = v.company_id
    LEFT JOIN transporters t ON t.transporter_id = v.transporter_id`,
  searchColumns: ['vehicleNo', 'plantName', 'companyName'],
  defaultSort: { column: 'vehicleNo', direction: 'asc' },
  columns: [
    {
      key: 'vehicleId',
      label: 'Vehicle ID',
      type: 'number',
      sql: 'v.vehicle_id',
      filterable: true,
      sortable: true,
      defaultVisible: false,
      lineage: {
        definition: 'The internal FSM vehicle id.',
        system: 'FSM_POSTGRES',
        table: 'vehicles',
        refreshTrigger: 'Never changes after creation.',
        developer: { column: 'vehicles.vehicle_id', expression: 'v.vehicle_id' },
      },
    },
    {
      key: 'vehicleNo',
      label: 'Vehicle',
      type: 'string',
      sql: 'v.vehicle_no',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      lineage: {
        definition: 'The vehicle registration number.',
        system: 'AUTOPLANT_MYSQL',
        table: 'vehicles (mirrored)',
        refreshTrigger: 'Daily master sync.',
        developer: { column: 'vehicles.vehicle_no', expression: 'v.vehicle_no' },
      },
    },
    {
      key: 'plantName',
      label: 'Plant',
      type: 'string',
      sql: 'p.name',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      drilldown: { label: 'Plant devices', route: '/reports/device?plantId=:value', valueSql: 'p.plant_id::text' },
      lineage: {
        definition: 'The plant this vehicle is fitted at.',
        system: 'AUTOPLANT_MYSQL',
        table: 'plants (mirrored)',
        refreshTrigger: 'Daily master sync.',
        developer: { column: 'plants.name', expression: 'p.name' },
      },
    },
    {
      key: 'companyName',
      label: 'Company',
      type: 'string',
      sql: 'c.name',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      drilldown: {
        label: 'Company devices',
        route: '/reports/device?companyId=:value',
        valueSql: 'c.company_id::text',
      },
      lineage: {
        definition: 'The customer account owning this vehicle.',
        system: 'AUTOPLANT_MYSQL',
        table: 'company_master (mirrored)',
        refreshTrigger: 'Daily master sync.',
        developer: { column: 'company_master.name', expression: 'c.name' },
      },
    },
    {
      key: 'transporterName',
      label: 'Transporter',
      type: 'string',
      sql: 't.name',
      filterable: true,
      sortable: true,
      defaultVisible: false,
      lineage: {
        definition: 'The transporter operating this vehicle, where AutoPlant records one.',
        system: 'AUTOPLANT_MYSQL',
        table: 'transporters (mirrored)',
        refreshTrigger: 'Daily master sync.',
        excludes: ['No transporter on record — the LEFT JOIN leaves this blank'],
        developer: { column: 'transporters.name', expression: 't.name' },
      },
    },
    {
      key: 'status',
      label: 'Deployment status',
      type: 'string',
      sql: 'v.status',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      lineage: {
        definition: 'AutoPlant’s deployment_status mirror. Master sync filters to DEPLOYED only.',
        system: 'AUTOPLANT_MYSQL',
        table: 'vehicles (mirrored)',
        refreshTrigger: 'Daily master sync.',
        developer: { column: 'vehicles.status', expression: 'v.status' },
      },
    },
    {
      key: 'createdAt',
      label: 'First synced',
      type: 'date',
      sql: 'v.created_at',
      filterable: true,
      sortable: true,
      defaultVisible: false,
      lineage: {
        definition: 'When this vehicle was first created in FSM.',
        system: 'FSM_POSTGRES',
        table: 'vehicles',
        refreshTrigger: 'Never changes after creation.',
        developer: { column: 'vehicles.created_at', expression: 'v.created_at' },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// engineers / tickets / batches / dispatchRuns / recommendations / auditLogs — operational state,
// dispatch, and the audit trail (#217 S3/S4). Each drilldown targets an EXISTING detail route:
// `/schedules/:engineerId`, `/tickets/:ticketId`, `/batches/:batchId`, `/dispatch-runs/:runId` — all
// already shipped for other features. `auditLogs` gets none: `entityType` varies row to row with no
// single safe target, and a wrong link is worse than an absent one in a tool built for trust.
// ---------------------------------------------------------------------------------------------

const ENGINEERS: DatasetDefinition = {
  key: 'engineers',
  name: 'Engineers (SEs)',
  description: 'Service Engineer profile, coverage type, and capacity — the recommender’s candidate pool.',
  grain: 'One row per engineer_id.',
  from: `engineer_master e
    JOIN users u ON u.user_id = e.engineer_id
    LEFT JOIN zones z ON z.zone_id = e.zone_id`,
  searchColumns: ['name', 'phone', 'email'],
  defaultSort: { column: 'name', direction: 'asc' },
  columns: [
    {
      key: 'engineerId',
      label: 'Engineer ID',
      type: 'string',
      sql: 'e.engineer_id::text',
      filterable: true,
      sortable: true,
      defaultVisible: false,
      lineage: {
        definition: 'The SE’s user id — 1:1 with users.user_id (Issue 02).',
        system: 'FSM_POSTGRES',
        table: 'engineer_master',
        refreshTrigger: 'Never changes after creation.',
        developer: { column: 'engineer_master.engineer_id', expression: 'e.engineer_id::text' },
      },
    },
    {
      key: 'name',
      label: 'Name',
      type: 'string',
      sql: 'u.name',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      drilldown: { label: 'Day plan', route: '/schedules/:value', valueSql: 'e.engineer_id::text' },
      lineage: {
        definition: 'The SE’s display name.',
        system: 'FSM_POSTGRES',
        table: 'users',
        refreshTrigger: 'Admin SE-management edit (Phase 4).',
        developer: { column: 'users.name', expression: 'u.name' },
      },
    },
    {
      key: 'phone',
      label: 'Phone',
      type: 'string',
      sql: 'u.phone',
      filterable: true,
      sortable: true,
      defaultVisible: false,
      lineage: {
        definition: 'The SE’s registered phone number (unique across users).',
        system: 'FSM_POSTGRES',
        table: 'users',
        refreshTrigger: 'Admin SE-management edit.',
        developer: { column: 'users.phone', expression: 'u.phone' },
      },
    },
    {
      key: 'email',
      label: 'Email',
      type: 'string',
      sql: 'u.email',
      filterable: true,
      sortable: true,
      defaultVisible: false,
      lineage: {
        definition: 'The SE’s registered email (unique across users).',
        system: 'FSM_POSTGRES',
        table: 'users',
        refreshTrigger: 'Admin SE-management edit.',
        developer: { column: 'users.email', expression: 'u.email' },
      },
    },
    {
      key: 'zoneName',
      label: 'Zone',
      type: 'string',
      sql: 'z.name',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      drilldown: { label: 'Zone devices', route: '/reports/device?zoneId=:value', valueSql: 'z.zone_id::text' },
      lineage: {
        definition: 'The SE’s home zone. A ZM can only see/manage SEs in their own zone.',
        system: 'FSM_POSTGRES',
        table: 'engineer_master.zone_id → zones',
        refreshTrigger: 'Admin SE-management edit.',
        developer: { column: 'zones.name', expression: 'z.name' },
      },
    },
    {
      key: 'coverageType',
      label: 'Coverage type',
      type: 'enum',
      sql: 'e.coverage_type::text',
      enumValues: ['DEDICATED', 'MULTI_PLANT', 'FLOATING'],
      filterable: true,
      sortable: true,
      defaultVisible: true,
      lineage: {
        definition: 'DEDICATED (1 plant) → MULTI_PLANT (se_coverage rows) → FLOATING (territory) — the recommender’s strict candidate-selection precedence order (ADR-0001).',
        system: 'FSM_POSTGRES',
        table: 'engineer_master',
        refreshTrigger: 'Admin SE-management edit.',
        developer: {
          column: 'engineer_master.coverage_type',
          expression: 'e.coverage_type::text',
          ownedBy: 'candidate-selection.service.ts',
        },
      },
    },
    {
      key: 'dailyCapacity',
      label: 'Daily capacity',
      type: 'number',
      sql: 'e.daily_capacity',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      lineage: {
        definition: 'Max tickets assignable to this SE per day — the OVER_CAPACITY hard filter’s limit.',
        system: 'FSM_POSTGRES',
        table: 'engineer_master',
        refreshTrigger: 'Admin SE-management edit.',
        developer: {
          column: 'engineer_master.daily_capacity',
          expression: 'e.daily_capacity',
          ownedBy: 'hard-filters.ts (OVER_CAPACITY), scored against committedDayLoad',
        },
      },
    },
    {
      key: 'isActive',
      label: 'Active?',
      type: 'boolean',
      sql: 'e.is_active',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      lineage: {
        definition: 'Whether this SE is currently eligible for dispatch at all (independent of SE_AVAILABILITY windows).',
        system: 'FSM_POSTGRES',
        table: 'engineer_master',
        refreshTrigger: 'Admin SE-management edit.',
        developer: { column: 'engineer_master.is_active', expression: 'e.is_active' },
      },
    },
    {
      key: 'lastActivityAt',
      label: 'Last activity ping',
      type: 'date',
      sql: 'e.last_activity_at',
      filterable: true,
      sortable: true,
      defaultVisible: false,
      lineage: {
        definition: 'The SE’s most recent mobile activity ping.',
        system: 'FSM_POSTGRES',
        table: 'engineer_master',
        refreshTrigger: 'Mobile app activity ping.',
        excludes: ['Deliberately NEVER a recommender gate (ADR-0023/24) — staleness here does not exclude an SE from scoring'],
        developer: { column: 'engineer_master.last_activity_at', expression: 'e.last_activity_at' },
      },
    },
    {
      key: 'createdAt',
      label: 'Created',
      type: 'date',
      sql: 'e.created_at',
      filterable: true,
      sortable: true,
      defaultVisible: false,
      lineage: {
        definition: 'When this SE profile was created.',
        system: 'FSM_POSTGRES',
        table: 'engineer_master',
        refreshTrigger: 'Never changes after creation.',
        developer: { column: 'engineer_master.created_at', expression: 'e.created_at' },
      },
    },
  ],
};

const TICKETS: DatasetDefinition = {
  key: 'tickets',
  name: 'Tickets',
  description: 'The unified work item — troubleshoot, install, and recovery — with its full assignment and closure state.',
  grain: 'One row per ticket_id.',
  from: `tickets t
    LEFT JOIN plants p ON p.plant_id = t.plant_id
    LEFT JOIN zones z ON z.zone_id = p.zone_id
    LEFT JOIN company_master c ON c.company_id = t.company_id
    LEFT JOIN engineer_master se ON se.engineer_id = t.assigned_se_id
    LEFT JOIN users su ON su.user_id = se.engineer_id`,
  searchColumns: ['deviceId', 'plantName', 'companyName', 'assignedSeName'],
  defaultSort: { column: 'lastStateChangedAt', direction: 'desc' },
  columns: [
    {
      key: 'ticketId',
      label: 'Ticket',
      type: 'string',
      sql: 't.ticket_id::text',
      filterable: true,
      sortable: false,
      defaultVisible: true,
      drilldown: { label: 'Open ticket', route: '/tickets/:value' },
      lineage: {
        definition: 'The ticket’s canonical UUID identity and API route param.',
        system: 'FSM_POSTGRES',
        table: 'tickets',
        refreshTrigger: 'Never changes after creation.',
        developer: { column: 'tickets.ticket_id', expression: 't.ticket_id::text' },
      },
    },
    {
      key: 'ticketNo',
      label: 'Ticket #',
      type: 'number',
      sql: 't.ticket_no',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      lineage: {
        definition: 'Human-readable display label (TCK-nnnnn on screen) — a global monotonic sequence, chronologically comparable. Never a foreign key.',
        system: 'FSM_POSTGRES',
        table: 'tickets',
        refreshTrigger: 'Assigned once at creation.',
        developer: { column: 'tickets.ticket_no', expression: 't.ticket_no' },
      },
    },
    {
      key: 'workType',
      label: 'Work type',
      type: 'enum',
      sql: 't.work_type::text',
      enumValues: ['TROUBLESHOOT', 'INSTALL', 'RECOVERY'],
      filterable: true,
      sortable: true,
      defaultVisible: true,
      lineage: {
        definition: 'Which column family this row uses — TROUBLESHOOT/INSTALL/RECOVERY each populate a different subset of the columns below.',
        system: 'FSM_POSTGRES',
        table: 'tickets',
        refreshTrigger: 'Set at creation, never changes.',
        developer: { column: 'tickets.work_type', expression: 't.work_type::text' },
      },
    },
    {
      key: 'status',
      label: 'Status',
      type: 'enum',
      sql: 't.status::text',
      enumValues: [
        'OPEN',
        'SUBMITTED',
        'VERIFICATION_PENDING',
        'CLOSED',
        'CLOSED_AUTO_RECOVERY',
        'FAILED_VERIFICATION',
        'ESCALATED',
        'CLOSED_NON_OPERATIONAL',
        'REQUESTED',
        'SCHEDULED',
        'ON_SITE',
        'FITTED',
        'ACTIVATED',
        'FAILED_ACTIVATION',
        'COLLECTED',
        'RECEIVED_AT_WAREHOUSE',
        'FAILED_RECOVERY',
      ],
      filterable: true,
      sortable: true,
      defaultVisible: true,
      lineage: {
        definition: 'Current lifecycle state. The enum is shared across all three work types, so its live values depend on workType.',
        system: 'FSM_POSTGRES',
        table: 'tickets',
        refreshTrigger: 'Every lifecycle transition (troubleshoot submit, verification, install fitment, recovery collection…).',
        developer: { column: 'tickets.status', expression: 't.status::text' },
      },
    },
    {
      key: 'assignmentState',
      label: 'Assignment',
      type: 'enum',
      sql: 't.assignment_state::text',
      enumValues: ['UNASSIGNED', 'FORMALLY_ASSIGNED'],
      filterable: true,
      sortable: true,
      defaultVisible: true,
      lineage: {
        definition: 'Whether this ticket has left the Shared Pool via batch dispatch.',
        system: 'FSM_POSTGRES',
        table: 'tickets',
        refreshTrigger: 'Batch dispatch (#100) flips UNASSIGNED → FORMALLY_ASSIGNED.',
        developer: { column: 'tickets.assignment_state', expression: 't.assignment_state::text' },
      },
    },
    {
      key: 'deviceId',
      label: 'Device',
      type: 'string',
      sql: 't.device_id',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      lineage: {
        definition: 'The device this ticket concerns.',
        system: 'FSM_POSTGRES',
        table: 'tickets',
        refreshTrigger: 'Set at creation, never changes.',
        developer: { column: 'tickets.device_id', expression: 't.device_id' },
      },
    },
    {
      key: 'plantName',
      label: 'Plant',
      type: 'string',
      sql: 'p.name',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      drilldown: { label: 'Plant devices', route: '/reports/device?plantId=:value', valueSql: 'p.plant_id::text' },
      lineage: {
        definition: 'The plant this ticket’s device belongs to.',
        system: 'AUTOPLANT_MYSQL',
        table: 'plants (mirrored)',
        refreshTrigger: 'Set at ticket creation; does NOT follow a later plant zone move (see zoneName excludes).',
        developer: { column: 'plants.name', expression: 'p.name' },
      },
    },
    {
      key: 'zoneName',
      label: 'Zone',
      type: 'string',
      sql: 'z.name',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      drilldown: { label: 'Zone devices', route: '/reports/device?zoneId=:value', valueSql: 'z.zone_id::text' },
      lineage: {
        definition: 'The ticket’s plant’s CURRENT zone — read live through the plant, not stamped at ticket creation.',
        system: 'FSM_POSTGRES',
        table: 'plants.zone_id → zones',
        refreshTrigger: 'Follows the plant’s zone in real time; a mid-day zone move changes this immediately even for old tickets.',
        excludes: ['Already-dispatched work_schedules stay under the OLD zone until the next dispatch run — this column and that one can disagree for a day'],
        developer: { column: 'zones.name', expression: 'z.name' },
      },
    },
    {
      key: 'companyName',
      label: 'Company',
      type: 'string',
      sql: 'c.name',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      drilldown: {
        label: 'Company devices',
        route: '/reports/device?companyId=:value',
        valueSql: 'c.company_id::text',
      },
      lineage: {
        definition: 'The customer account this ticket belongs to.',
        system: 'AUTOPLANT_MYSQL',
        table: 'company_master (mirrored)',
        refreshTrigger: 'Set at ticket creation, never changes.',
        developer: { column: 'company_master.name', expression: 'c.name' },
      },
    },
    {
      key: 'companyTier',
      label: 'Tier (stamped)',
      type: 'enum',
      sql: 't.company_tier::text',
      enumValues: ['PLATINUM', 'GOLD', 'SILVER'],
      filterable: true,
      sortable: true,
      defaultVisible: false,
      lineage: {
        definition: 'The EFFECTIVE company tier at the moment this ticket was created — stamped once, never re-stamped, even if the tier or an override changes later (#157 Q-B).',
        system: 'FSM_POSTGRES',
        table: 'tickets',
        refreshTrigger: 'Set once at ticket creation.',
        excludes: ['The company’s CURRENT tier — see the companies dataset for that; they can disagree by design'],
        developer: { column: 'tickets.company_tier', expression: 't.company_tier::text', ownedBy: 'effective-tier.ts' },
      },
    },
    {
      key: 'assignedSeName',
      label: 'Assigned SE',
      type: 'string',
      sql: 'su.name',
      filterable: true,
      sortable: true,
      defaultVisible: false,
      drilldown: { label: 'Day plan', route: '/schedules/:value', valueSql: 't.assigned_se_id::text' },
      lineage: {
        definition: 'RECOVERY-only: the SE assigned to collect this device. TROUBLESHOOT/INSTALL assignment lives in the batches dataset instead.',
        system: 'FSM_POSTGRES',
        table: 'tickets.assigned_se_id → engineer_master → users',
        refreshTrigger: 'Set when a Recovery ticket is assigned.',
        excludes: ['TROUBLESHOOT/INSTALL tickets — this column is populated for RECOVERY work_type only'],
        developer: { column: 'users.name', expression: 'su.name' },
      },
    },
    {
      key: 'repeatFailure',
      label: 'Repeat?',
      type: 'boolean',
      sql: 't.repeat_failure',
      filterable: true,
      sortable: true,
      defaultVisible: false,
      lineage: {
        definition: 'Whether this ticket’s parent failure cycle re-opened within 24h of a VERIFIED closure (ADR-0021).',
        system: 'FSM_POSTGRES',
        table: 'tickets',
        refreshTrigger: 'Set at ticket creation.',
        developer: { column: 'tickets.repeat_failure', expression: 't.repeat_failure' },
      },
    },
    {
      key: 'deferredUntil',
      label: 'Deferred until',
      type: 'date',
      sql: 't.deferred_until',
      filterable: true,
      sortable: true,
      defaultVisible: false,
      lineage: {
        definition: 'A ZM deferral date (#146 B1) — the ticket returns to UNASSIGNED and every unassigned-work reader skips it until this date.',
        system: 'FSM_POSTGRES',
        table: 'tickets',
        refreshTrigger: 'ZM deferral action; cleared on re-dispatch.',
        developer: { column: 'tickets.deferred_until', expression: 't.deferred_until' },
      },
    },
    {
      key: 'closureType',
      label: 'Closure type',
      type: 'enum',
      sql: 't.closure_type::text',
      enumValues: [
        'AUTO_CLOSED_ON_WAREHOUSE_RECEIPT',
        'FAILED_RECOVERY_CLOSE',
        'ZM_MANUAL_CLOSE',
        'OPERATIONS_HEAD_OVERRIDE_CLOSE',
        'CSM_ACTING_CLOSE',
        'DEVICE_UNDEPLOYED_CLOSE',
      ],
      filterable: true,
      sortable: true,
      defaultVisible: false,
      lineage: {
        definition: 'How a RECOVERY ticket was manually closed, when it was not closed by the normal warehouse-receipt path.',
        system: 'FSM_POSTGRES',
        table: 'tickets',
        refreshTrigger: 'Set on manual closure.',
        excludes: ['Null for every ticket closed the normal way, and for every non-RECOVERY ticket'],
        developer: { column: 'tickets.closure_type', expression: 't.closure_type::text' },
      },
    },
    {
      key: 'closureReason',
      label: 'Closure reason',
      type: 'string',
      sql: 't.closure_reason',
      filterable: true,
      sortable: false,
      defaultVisible: false,
      lineage: {
        definition: 'Free-text mandatory reason accompanying a manual closure.',
        system: 'FSM_POSTGRES',
        table: 'tickets',
        refreshTrigger: 'Set on manual closure.',
        developer: { column: 'tickets.closure_reason', expression: 't.closure_reason' },
      },
    },
    {
      key: 'closedAt',
      label: 'Closed at',
      type: 'date',
      sql: 't.closed_at',
      filterable: true,
      sortable: true,
      defaultVisible: false,
      lineage: {
        definition: 'When this ticket closed, of any closure kind.',
        system: 'FSM_POSTGRES',
        table: 'tickets',
        refreshTrigger: 'Set on closure.',
        developer: { column: 'tickets.closed_at', expression: 't.closed_at' },
      },
    },
    {
      key: 'lastStateChangedAt',
      label: 'Last state change',
      type: 'date',
      sql: 't.last_state_changed_at',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      lineage: {
        definition: 'When this ticket’s status last changed — the freshness stamp for the row.',
        system: 'FSM_POSTGRES',
        table: 'tickets',
        refreshTrigger: 'Every status transition.',
        developer: { column: 'tickets.last_state_changed_at', expression: 't.last_state_changed_at' },
      },
    },
    {
      key: 'createdAt',
      label: 'Created',
      type: 'date',
      sql: 't.created_at',
      filterable: true,
      sortable: true,
      defaultVisible: false,
      lineage: {
        definition: 'When this ticket was created.',
        system: 'FSM_POSTGRES',
        table: 'tickets',
        refreshTrigger: 'Never changes after creation.',
        developer: { column: 'tickets.created_at', expression: 't.created_at' },
      },
    },
  ],
};

const BATCHES: DatasetDefinition = {
  key: 'batches',
  name: 'Plant batches',
  description: 'One SE’s stop at one plant within a Day Plan — the unit the ZM override engine acts on.',
  grain: 'One row per batch_id.',
  from: `plant_batch_assignments b
    JOIN work_schedules s ON s.schedule_id = b.schedule_id
    JOIN plants p ON p.plant_id = b.plant_id
    JOIN engineer_master e ON e.engineer_id = b.se_id
    JOIN users u ON u.user_id = e.engineer_id
    LEFT JOIN zones z ON z.zone_id = s.zone_id`,
  searchColumns: ['plantName', 'seName'],
  defaultSort: { column: 'createdAt', direction: 'desc' },
  columns: [
    {
      key: 'batchId',
      label: 'Batch',
      type: 'number',
      sql: 'b.batch_id',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      drilldown: { label: 'Batch detail', route: '/batches/:value' },
      lineage: {
        definition: 'The batch’s id — the API route param for its own detail page.',
        system: 'FSM_POSTGRES',
        table: 'plant_batch_assignments',
        refreshTrigger: 'Never changes after creation.',
        developer: { column: 'plant_batch_assignments.batch_id', expression: 'b.batch_id' },
      },
    },
    {
      key: 'plantName',
      label: 'Plant',
      type: 'string',
      sql: 'p.name',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      drilldown: { label: 'Plant devices', route: '/reports/device?plantId=:value', valueSql: 'p.plant_id::text' },
      lineage: {
        definition: 'The plant this batch is a stop at — the clustering unit for dispatch.',
        system: 'AUTOPLANT_MYSQL',
        table: 'plants (mirrored)',
        refreshTrigger: 'Set at batch creation.',
        developer: { column: 'plants.name', expression: 'p.name' },
      },
    },
    {
      key: 'seName',
      label: 'Assigned SE',
      type: 'string',
      sql: 'u.name',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      drilldown: { label: 'Day plan', route: '/schedules/:value', valueSql: 'e.engineer_id::text' },
      lineage: {
        definition: 'The SE this batch is (currently) assigned to — can change via ZM reassignment.',
        system: 'FSM_POSTGRES',
        table: 'plant_batch_assignments.se_id → engineer_master → users',
        refreshTrigger: 'Batch dispatch, or a ZM reassign override.',
        developer: { column: 'users.name', expression: 'u.name' },
      },
    },
    {
      key: 'zoneName',
      label: 'Zone',
      type: 'string',
      sql: 'z.name',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      drilldown: { label: 'Zone devices', route: '/reports/device?zoneId=:value', valueSql: 'z.zone_id::text' },
      lineage: {
        definition: 'The zone of the WORK SCHEDULE this batch belongs to — deliberately in the schedule’s own key so cross-zone plans are possible (INDEX.md:97).',
        system: 'FSM_POSTGRES',
        table: 'work_schedules.zone_id → zones',
        refreshTrigger: 'Set at schedule creation.',
        developer: { column: 'zones.name', expression: 'z.name' },
      },
    },
    {
      key: 'status',
      label: 'Status',
      type: 'enum',
      sql: 'b.status::text',
      enumValues: ['AUTO_ASSIGNED', 'OVERRIDDEN', 'COMPLETED', 'PARTIAL'],
      filterable: true,
      sortable: true,
      defaultVisible: true,
      lineage: {
        definition: 'AUTO_ASSIGNED at dispatch; flips to OVERRIDDEN on any ZM change (reassign/split/remove/defer/reorder). No approval gate — the batch is already live in the SE’s Day Plan when created.',
        system: 'FSM_POSTGRES',
        table: 'plant_batch_assignments',
        refreshTrigger: 'Dispatch (#100), any ZM override (#13a), or the daily schedule-closure cron (#147).',
        developer: { column: 'plant_batch_assignments.status', expression: 'b.status::text' },
      },
    },
    {
      key: 'stopSequence',
      label: 'Stop #',
      type: 'number',
      sql: 'b.stop_sequence',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      lineage: {
        definition: 'This batch’s order within the SE’s Day Plan for its schedule.',
        system: 'FSM_POSTGRES',
        table: 'plant_batch_assignments',
        refreshTrigger: 'Set at dispatch; a ZM reorder override changes it.',
        developer: { column: 'plant_batch_assignments.stop_sequence', expression: 'b.stop_sequence' },
      },
    },
    {
      key: 'scheduleDateFrom',
      label: 'Schedule date',
      type: 'date',
      sql: 's.date_from',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      lineage: {
        definition: 'The Day Plan date this batch belongs to.',
        system: 'FSM_POSTGRES',
        table: 'work_schedules',
        refreshTrigger: 'Set at schedule creation.',
        developer: { column: 'work_schedules.date_from', expression: 's.date_from' },
      },
    },
    {
      key: 'overrideReason',
      label: 'Override reason',
      type: 'string',
      sql: 'b.override_reason',
      filterable: true,
      sortable: false,
      defaultVisible: false,
      lineage: {
        definition: 'The mandatory reason code recorded on the ZM override that last touched this batch.',
        system: 'FSM_POSTGRES',
        table: 'plant_batch_assignments',
        refreshTrigger: 'Any ZM override action.',
        excludes: ['Null for a batch never overridden'],
        developer: { column: 'plant_batch_assignments.override_reason', expression: 'b.override_reason' },
      },
    },
    {
      key: 'runId',
      label: 'Dispatch run',
      type: 'number',
      sql: 'b.run_id',
      filterable: true,
      sortable: true,
      defaultVisible: false,
      drilldown: { label: 'Run detail', route: '/dispatch-runs/:value' },
      lineage: {
        definition: 'The dispatch run that CREATED this batch (transparency). A same-day re-run appends fresh batches onto an existing schedule, so run attribution lives here, not on the schedule.',
        system: 'FSM_POSTGRES',
        table: 'plant_batch_assignments',
        refreshTrigger: 'Set at batch creation, never changes.',
        excludes: ['Null for pre-run-attribution history and ZM_MANUAL batches — those fall back to the schedule’s own run_id'],
        developer: { column: 'plant_batch_assignments.run_id', expression: 'b.run_id' },
      },
    },
    {
      key: 'createdAt',
      label: 'Created',
      type: 'date',
      sql: 'b.created_at',
      filterable: true,
      sortable: true,
      defaultVisible: false,
      lineage: {
        definition: 'When this batch was created.',
        system: 'FSM_POSTGRES',
        table: 'plant_batch_assignments',
        refreshTrigger: 'Never changes after creation.',
        developer: { column: 'plant_batch_assignments.created_at', expression: 'b.created_at' },
      },
    },
    {
      key: 'updatedAt',
      label: 'Last updated',
      type: 'date',
      sql: 'b.updated_at',
      filterable: true,
      sortable: true,
      defaultVisible: false,
      lineage: {
        definition: 'When this batch row last changed (creation, or any ZM override).',
        system: 'FSM_POSTGRES',
        table: 'plant_batch_assignments',
        refreshTrigger: 'Any write to this row.',
        developer: { column: 'plant_batch_assignments.updated_at', expression: 'b.updated_at' },
      },
    },
  ],
};

const DISPATCH_RUNS: DatasetDefinition = {
  key: 'dispatchRuns',
  name: 'Dispatch runs',
  description: 'The run ledger — one row per recommender + batch-dispatch execution, cron or manual.',
  grain: 'One row per run_id.',
  from: `dispatch_runs r`,
  searchColumns: ['reason', 'actorRole'],
  defaultSort: { column: 'startedAt', direction: 'desc' },
  columns: [
    {
      key: 'runId',
      label: 'Run',
      type: 'number',
      sql: 'r.run_id',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      drilldown: { label: 'Run detail', route: '/dispatch-runs/:value' },
      lineage: {
        definition: 'The run’s id — the API route param for its own detail page.',
        system: 'FSM_POSTGRES',
        table: 'dispatch_runs',
        refreshTrigger: 'Never changes after creation.',
        developer: { column: 'dispatch_runs.run_id', expression: 'r.run_id' },
      },
    },
    {
      key: 'trigger',
      label: 'Trigger',
      type: 'enum',
      sql: 'r.trigger::text',
      enumValues: ['CRON', 'MANUAL'],
      filterable: true,
      sortable: true,
      defaultVisible: true,
      lineage: {
        definition: 'Whether this run fired from the daily cron or a manual "Run Dispatch Now" action (#213).',
        system: 'FSM_POSTGRES',
        table: 'dispatch_runs',
        refreshTrigger: 'Set at run start.',
        developer: { column: 'dispatch_runs.trigger', expression: 'r.trigger::text' },
      },
    },
    {
      key: 'status',
      label: 'Status',
      type: 'enum',
      sql: 'r.status::text',
      enumValues: ['RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED'],
      filterable: true,
      sortable: true,
      defaultVisible: true,
      lineage: {
        definition: 'The run’s terminal outcome. A per-zone error is contained — one failed zone does not fail the whole run (§3g).',
        system: 'FSM_POSTGRES',
        table: 'dispatch_runs',
        refreshTrigger: 'Set on finish; RUNNING is a live in-flight run.',
        developer: { column: 'dispatch_runs.status', expression: 'r.status::text' },
      },
    },
    {
      key: 'actorRole',
      label: 'Actor role',
      type: 'string',
      sql: 'r.actor_role',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      lineage: {
        definition: 'Who triggered this run — null for CRON, the acting role for MANUAL.',
        system: 'FSM_POSTGRES',
        table: 'dispatch_runs',
        refreshTrigger: 'Set at run start.',
        excludes: ['Always null on a CRON-triggered row'],
        developer: { column: 'dispatch_runs.actor_role', expression: 'r.actor_role' },
      },
    },
    {
      key: 'reason',
      label: 'Reason',
      type: 'string',
      sql: 'r.reason',
      filterable: true,
      sortable: false,
      defaultVisible: false,
      lineage: {
        definition: 'Optional operator note on a MANUAL run (#213) — "why". Always null for CRON.',
        system: 'FSM_POSTGRES',
        table: 'dispatch_runs',
        refreshTrigger: 'Set at run start, MANUAL only.',
        developer: { column: 'dispatch_runs.reason', expression: 'r.reason' },
      },
    },
    {
      key: 'zones',
      label: 'Zones',
      type: 'number',
      sql: 'r.zones',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      lineage: {
        definition: 'Count of zones this run processed.',
        system: 'FSM_POSTGRES',
        table: 'dispatch_runs',
        refreshTrigger: 'Set on finish.',
        developer: { column: 'dispatch_runs.zones', expression: 'r.zones' },
      },
    },
    {
      key: 'batches',
      label: 'Batches',
      type: 'number',
      sql: 'r.batches',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      lineage: {
        definition: 'Count of plant_batch_assignments rows this run created. Reconciled against the live batches dataset in the reconciliation panel (identity `dispatchBatchLedger`).',
        system: 'FSM_POSTGRES',
        table: 'dispatch_runs',
        refreshTrigger: 'Set on finish.',
        developer: { column: 'dispatch_runs.batches', expression: 'r.batches' },
      },
    },
    {
      key: 'schedules',
      label: 'Schedules',
      type: 'number',
      sql: 'r.schedules',
      filterable: true,
      sortable: true,
      defaultVisible: false,
      lineage: {
        definition: 'Count of work_schedules rows this run created.',
        system: 'FSM_POSTGRES',
        table: 'dispatch_runs',
        refreshTrigger: 'Set on finish.',
        developer: { column: 'dispatch_runs.schedules', expression: 'r.schedules' },
      },
    },
    {
      key: 'ticketsDispatched',
      label: 'Tickets dispatched',
      type: 'number',
      sql: 'r.tickets_dispatched',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      lineage: {
        definition: 'Count of tickets flipped SUGGESTED → DISPATCHED (i.e. FORMALLY_ASSIGNED) by this run, at the time it ran.',
        system: 'FSM_POSTGRES',
        table: 'dispatch_runs',
        refreshTrigger: 'Set on finish.',
        excludes: ['A ticket later REMOVED from its batch by a ZM override still counts here — this is a point-in-time dispatch count, not a live "still assigned" count'],
        developer: { column: 'dispatch_runs.tickets_dispatched', expression: 'r.tickets_dispatched' },
      },
    },
    {
      key: 'recommended',
      label: 'Recommended',
      type: 'number',
      sql: 'r.recommended',
      filterable: true,
      sortable: true,
      defaultVisible: false,
      lineage: {
        definition: 'Count of SUGGESTED recommendations this run produced (before batch dispatch).',
        system: 'FSM_POSTGRES',
        table: 'dispatch_runs',
        refreshTrigger: 'Set on finish.',
        developer: { column: 'dispatch_runs.recommended', expression: 'r.recommended' },
      },
    },
    {
      key: 'unassignable',
      label: 'Unassignable',
      type: 'number',
      sql: 'r.unassignable',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      lineage: {
        definition: 'Count of tickets the recommender could not assign (a hard filter dropped every candidate). Never silently dropped — see the recommendations dataset for the per-ticket reason.',
        system: 'FSM_POSTGRES',
        table: 'dispatch_runs',
        refreshTrigger: 'Set on finish.',
        developer: { column: 'dispatch_runs.unassignable', expression: 'r.unassignable' },
      },
    },
    {
      key: 'startedAt',
      label: 'Started',
      type: 'date',
      sql: 'r.started_at',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      lineage: {
        definition: 'When this run started.',
        system: 'FSM_POSTGRES',
        table: 'dispatch_runs',
        refreshTrigger: 'Set at run start.',
        developer: { column: 'dispatch_runs.started_at', expression: 'r.started_at' },
      },
    },
    {
      key: 'finishedAt',
      label: 'Finished',
      type: 'date',
      sql: 'r.finished_at',
      filterable: true,
      sortable: true,
      defaultVisible: false,
      lineage: {
        definition: 'When this run finished. Null for a still-RUNNING run.',
        system: 'FSM_POSTGRES',
        table: 'dispatch_runs',
        refreshTrigger: 'Set on finish.',
        developer: { column: 'dispatch_runs.finished_at', expression: 'r.finished_at' },
      },
    },
    {
      key: 'buildFingerprint',
      label: 'Build',
      type: 'string',
      sql: 'r.build_fingerprint',
      filterable: true,
      sortable: false,
      defaultVisible: false,
      lineage: {
        definition: 'The git commit/build that produced this run (#130 L3) — for correlating a bad run with a specific deploy.',
        system: 'FSM_POSTGRES',
        table: 'dispatch_runs',
        refreshTrigger: 'Stamped at run creation from build-info.',
        developer: { column: 'dispatch_runs.build_fingerprint', expression: 'r.build_fingerprint' },
      },
    },
  ],
};

const RECOMMENDATIONS: DatasetDefinition = {
  key: 'recommendations',
  name: 'Recommendations',
  description: 'The recommender’s append-only "why this SE was suggested" explainability trail.',
  grain: 'One row per recommendation_id.',
  from: `recommendations rec
    JOIN tickets t ON t.ticket_id = rec.ticket_id
    LEFT JOIN engineer_master e ON e.engineer_id = rec.se_id
    LEFT JOIN users u ON u.user_id = e.engineer_id`,
  searchColumns: ['deviceId', 'seName'],
  defaultSort: { column: 'createdAt', direction: 'desc' },
  columns: [
    {
      key: 'recommendationId',
      label: 'Recommendation',
      type: 'number',
      sql: 'rec.recommendation_id',
      filterable: true,
      sortable: true,
      defaultVisible: false,
      lineage: {
        definition: 'The recommendation row’s own id.',
        system: 'FSM_POSTGRES',
        table: 'recommendations',
        refreshTrigger: 'Never changes after creation.',
        developer: { column: 'recommendations.recommendation_id', expression: 'rec.recommendation_id' },
      },
    },
    {
      key: 'deviceId',
      label: 'Device',
      type: 'string',
      sql: 't.device_id',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      drilldown: { label: 'Open ticket', route: '/tickets/:value', valueSql: 'rec.ticket_id::text' },
      lineage: {
        definition: 'The device behind the ticket this recommendation was made for.',
        system: 'FSM_POSTGRES',
        table: 'tickets ← recommendations.ticket_id',
        refreshTrigger: 'Set at recommendation creation.',
        developer: { column: 'tickets.device_id', expression: 't.device_id' },
      },
    },
    {
      key: 'seName',
      label: 'Candidate SE',
      type: 'string',
      sql: 'u.name',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      drilldown: { label: 'Day plan', route: '/schedules/:value', valueSql: 'rec.se_id::text' },
      lineage: {
        definition: 'The SE this row recommends. Null on an UNASSIGNABLE row — no candidate survived the hard filters.',
        system: 'FSM_POSTGRES',
        table: 'recommendations.se_id → engineer_master → users',
        refreshTrigger: 'Set at recommendation creation.',
        excludes: ['UNASSIGNABLE rows — the LEFT JOIN leaves this blank rather than dropping the row'],
        developer: { column: 'users.name', expression: 'u.name' },
      },
    },
    {
      key: 'status',
      label: 'Status',
      type: 'string',
      sql: 'rec.status',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      lineage: {
        definition: 'SUGGESTED, DISPATCHED (consumed by batch dispatch), or UNASSIGNABLE — a recommendation is never silently dropped.',
        system: 'FSM_POSTGRES',
        table: 'recommendations',
        refreshTrigger: 'SUGGESTED at creation; batch dispatch (#100) flips to DISPATCHED.',
        developer: { column: 'recommendations.status', expression: 'rec.status' },
      },
    },
    {
      key: 'path',
      label: 'Path',
      type: 'enum',
      sql: 'rec.path::text',
      enumValues: ['MORNING_BATCH', 'INTRADAY'],
      filterable: true,
      sortable: true,
      defaultVisible: true,
      lineage: {
        definition: 'Which recommender entry point produced this row — the daily batch run, or an intraday CRITICAL insertion.',
        system: 'FSM_POSTGRES',
        table: 'recommendations',
        refreshTrigger: 'Set at creation.',
        developer: { column: 'recommendations.path', expression: 'rec.path::text' },
      },
    },
    {
      key: 'companyTier',
      label: 'Tier',
      type: 'enum',
      sql: 'rec.company_tier::text',
      enumValues: ['PLATINUM', 'GOLD', 'SILVER'],
      filterable: true,
      sortable: true,
      defaultVisible: false,
      lineage: {
        definition: 'The effective company tier used as canonical-sort key 1 for this recommendation.',
        system: 'FSM_POSTGRES',
        table: 'recommendations',
        refreshTrigger: 'Set at creation.',
        developer: { column: 'recommendations.company_tier', expression: 'rec.company_tier::text' },
      },
    },
    {
      key: 'deviceBucket',
      label: 'SLA bucket',
      type: 'enum',
      sql: 'rec.device_bucket::text',
      enumValues: [
        'WARNING',
        'EARLY_RISK',
        'RISK',
        'CRITICAL',
        'HIGH_CRITICAL',
        'SEVERE',
        'VERY_SEVERE',
        'LONG_PENDING',
      ],
      filterable: true,
      sortable: true,
      defaultVisible: true,
      lineage: {
        definition: 'The device’s SLA bucket at the moment of recommendation — canonical-sort key 2.',
        system: 'FSM_POSTGRES',
        table: 'recommendations',
        refreshTrigger: 'Set at creation.',
        developer: { column: 'recommendations.device_bucket', expression: 'rec.device_bucket::text' },
      },
    },
    {
      key: 'processingRank',
      label: 'Rank',
      type: 'number',
      sql: 'rec.processing_rank',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      lineage: {
        definition: 'The persisted canonical-sort position (ADR-0017): tier → bucket → priority rank → oldest-inactive → device id.',
        system: 'FSM_POSTGRES',
        table: 'recommendations',
        refreshTrigger: 'Set at creation.',
        developer: { column: 'recommendations.processing_rank', expression: 'rec.processing_rank', ownedBy: 'canonical-sort.ts' },
      },
    },
    {
      key: 'runId',
      label: 'Dispatch run',
      type: 'number',
      sql: 'rec.run_id',
      filterable: true,
      sortable: true,
      defaultVisible: false,
      drilldown: { label: 'Run detail', route: '/dispatch-runs/:value' },
      lineage: {
        definition: 'The dispatch run that produced this recommendation. Null for the intraday path and for pre-ledger history.',
        system: 'FSM_POSTGRES',
        table: 'recommendations',
        refreshTrigger: 'Set at creation.',
        excludes: ['Always null for path = INTRADAY'],
        developer: { column: 'recommendations.run_id', expression: 'rec.run_id' },
      },
    },
    {
      key: 'createdAt',
      label: 'Created',
      type: 'date',
      sql: 'rec.created_at',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      lineage: {
        definition: 'When this recommendation row was written.',
        system: 'FSM_POSTGRES',
        table: 'recommendations',
        refreshTrigger: 'Never changes after creation.',
        developer: { column: 'recommendations.created_at', expression: 'rec.created_at' },
      },
    },
  ],
};

const AUDIT_LOGS: DatasetDefinition = {
  key: 'auditLogs',
  name: 'Audit log',
  description: 'The same-transaction audit trail every mutating admin action writes — who did what, acting as what role, in what zone.',
  grain: 'One row per audit_logs.id.',
  from: `audit_logs a`,
  searchColumns: ['action', 'entityType', 'entityId', 'actorId'],
  defaultSort: { column: 'createdAt', direction: 'desc' },
  columns: [
    {
      key: 'id',
      label: 'ID',
      type: 'number',
      sql: 'a.id',
      filterable: true,
      sortable: true,
      defaultVisible: false,
      lineage: {
        definition: 'The audit row’s own id.',
        system: 'FSM_POSTGRES',
        table: 'audit_logs',
        refreshTrigger: 'Never changes after creation.',
        developer: { column: 'audit_logs.id', expression: 'a.id' },
      },
    },
    {
      key: 'action',
      label: 'Action',
      type: 'string',
      sql: 'a.action',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      lineage: {
        definition: 'The audited action name (e.g. TIER_OVERRIDE_CREATED, EXPORT_DOWNLOADED). Free-text, not an enum — the vocabulary grows as features are audited.',
        system: 'FSM_POSTGRES',
        table: 'audit_logs',
        refreshTrigger: 'Written same-transaction with the audited mutation (AuditService.withAudit).',
        developer: { column: 'audit_logs.action', expression: 'a.action' },
      },
    },
    {
      key: 'entityType',
      label: 'Entity type',
      type: 'string',
      sql: 'a.entity_type',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      lineage: {
        definition: 'What kind of thing was acted on.',
        system: 'FSM_POSTGRES',
        table: 'audit_logs',
        refreshTrigger: 'Written same-transaction with the audited mutation.',
        developer: { column: 'audit_logs.entity_type', expression: 'a.entity_type' },
      },
    },
    {
      key: 'entityId',
      label: 'Entity ID',
      type: 'string',
      sql: 'a.entity_id',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      lineage: {
        definition: 'The id of the specific row acted on, in whatever id-space entityType uses (a UUID, a numeric id-as-string, or a dataset key for a tool-level action).',
        system: 'FSM_POSTGRES',
        table: 'audit_logs',
        refreshTrigger: 'Written same-transaction with the audited mutation.',
        developer: { column: 'audit_logs.entity_id', expression: 'a.entity_id' },
      },
    },
    {
      key: 'actorId',
      label: 'Actor',
      type: 'string',
      sql: 'a.actor_id',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      lineage: {
        definition: 'The user id who performed the action.',
        system: 'FSM_POSTGRES',
        table: 'audit_logs',
        refreshTrigger: 'Written same-transaction with the audited mutation.',
        developer: { column: 'audit_logs.actor_id', expression: 'a.actor_id' },
      },
    },
    {
      key: 'actorRole',
      label: 'Actor role',
      type: 'string',
      sql: 'a.actor_role',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      lineage: {
        definition: 'The actor’s own role at the time of the action.',
        system: 'FSM_POSTGRES',
        table: 'audit_logs',
        refreshTrigger: 'Written same-transaction with the audited mutation.',
        developer: { column: 'audit_logs.actor_role', expression: 'a.actor_role' },
      },
    },
    {
      key: 'actedAsRole',
      label: 'Acted as',
      type: 'string',
      sql: 'a.acted_as_role',
      filterable: true,
      sortable: true,
      defaultVisible: false,
      lineage: {
        definition: 'When a CSM or OH is exercising backup authority in a ZM’s scope, the role they were ACTING AS — distinct from their own actorRole (Decision §15).',
        system: 'FSM_POSTGRES',
        table: 'audit_logs',
        refreshTrigger: 'Written same-transaction with the audited mutation, only when acting.',
        excludes: ['Null for the overwhelming majority of rows — most actions are not taken under backup authority'],
        developer: { column: 'audit_logs.acted_as_role', expression: 'a.acted_as_role' },
      },
    },
    {
      key: 'actingZone',
      label: 'Acting zone',
      type: 'number',
      sql: 'a.acting_zone',
      filterable: true,
      sortable: true,
      defaultVisible: false,
      lineage: {
        definition: 'The zone the acted-as authority applied to, when actedAsRole is set.',
        system: 'FSM_POSTGRES',
        table: 'audit_logs',
        refreshTrigger: 'Written same-transaction with the audited mutation, only when acting.',
        developer: { column: 'audit_logs.acting_zone', expression: 'a.acting_zone' },
      },
    },
    {
      key: 'metadata',
      label: 'Metadata',
      type: 'string',
      sql: 'a.metadata::text',
      filterable: true,
      sortable: false,
      defaultVisible: false,
      lineage: {
        definition: 'Free-form JSON detail attached to this action (e.g. an export’s applied filters, an override’s before/after values). Shape varies by action.',
        system: 'FSM_POSTGRES',
        table: 'audit_logs',
        refreshTrigger: 'Written same-transaction with the audited mutation.',
        developer: { column: 'audit_logs.metadata', expression: 'a.metadata::text' },
      },
    },
    {
      key: 'createdAt',
      label: 'When',
      type: 'date',
      sql: 'a.created_at',
      filterable: true,
      sortable: true,
      defaultVisible: true,
      lineage: {
        definition: 'When this action was audited.',
        system: 'FSM_POSTGRES',
        table: 'audit_logs',
        refreshTrigger: 'Written same-transaction with the audited mutation.',
        developer: { column: 'audit_logs.created_at', expression: 'a.created_at' },
      },
    },
  ],
};

const DATASETS: readonly DatasetDefinition[] = [
  DEVICES,
  ZONES,
  COMPANIES,
  PLANTS,
  VEHICLES,
  ENGINEERS,
  TICKETS,
  BATCHES,
  DISPATCH_RUNS,
  RECOMMENDATIONS,
  AUDIT_LOGS,
];

const BY_KEY = new Map(DATASETS.map((d) => [d.key, d]));

export function listDatasets(): readonly DatasetDefinition[] {
  return DATASETS;
}

/** Registry lookup. Returns `undefined` for an unknown key — callers turn that into a 404, never a query. */
export function getDataset(key: string): DatasetDefinition | undefined {
  return BY_KEY.get(key);
}

/**
 * Column lookup **by key only**. This is the single chokepoint that makes AC-8 true: no other function
 * in this module turns caller input into an identifier, so a column that is not in the registry cannot
 * reach the database.
 */
export function getColumn(dataset: DatasetDefinition, key: string): DatasetColumn | undefined {
  return dataset.columns.find((c) => c.key === key);
}

/** The code-authored SQL for a column, as a Prisma fragment. Only ever called with a resolved column. */
export function columnSql(column: DatasetColumn): Prisma.Sql {
  return Prisma.raw(column.sql);
}

// ---------------------------------------------------------------------------------------------
// Serialization — the developer-mode strip (#217 Developer Mode table).
// ---------------------------------------------------------------------------------------------

export interface SerializedColumn extends Omit<DatasetColumn, 'sql' | 'lineage' | 'drilldown'> {
  /** `valueSql` never reaches the client, in either mode — see `serializeDataset`. */
  drilldown?: { label: string; route: string };
  lineage: OperationalLineage & { developer?: DeveloperLineage };
}

export interface SerializedDataset extends Omit<DatasetDefinition, 'columns' | 'from' | 'baseWhere'> {
  columns: SerializedColumn[];
  /** Present in Developer Mode only. */
  from?: string;
  baseWhere?: { sql?: string; reason: string };
}

/**
 * Project a dataset for the wire. With `developerMode` false the SQL, the FROM clause and the whole
 * `developer` lineage block are **absent from the payload** — not flagged, not empty, absent. The
 * operator asked for the deep layer to be gated; hiding it client-side would make the flag cosmetic.
 */
export function serializeDataset(dataset: DatasetDefinition, developerMode: boolean): SerializedDataset {
  return {
    key: dataset.key,
    name: dataset.name,
    description: dataset.description,
    grain: dataset.grain,
    searchColumns: dataset.searchColumns,
    defaultSort: dataset.defaultSort,
    ...(developerMode ? { from: dataset.from } : {}),
    ...(dataset.baseWhere
      ? {
          baseWhere: developerMode
            ? { sql: dataset.baseWhere.sql, reason: dataset.baseWhere.reason }
            : { reason: dataset.baseWhere.reason },
        }
      : {}),
    columns: dataset.columns.map(({ sql: _sql, lineage, drilldown, ...rest }) => ({
      ...rest,
      // `valueSql` is a raw SQL expression like every other field this function strips — omitted in
      // BOTH modes (unlike `lineage.developer`, which Developer Mode is specifically for). The client
      // never needs it: the query response carries the resolved value as a hidden `__dd_<key>` row
      // field, so the FE looks the value up on the ROW, never on this metadata.
      ...(drilldown ? { drilldown: { label: drilldown.label, route: drilldown.route } } : {}),
      lineage: developerMode
        ? lineage
        : {
            definition: lineage.definition,
            system: lineage.system,
            table: lineage.table,
            refreshTrigger: lineage.refreshTrigger,
            ...(lineage.excludes ? { excludes: lineage.excludes } : {}),
          },
    })),
  };
}
