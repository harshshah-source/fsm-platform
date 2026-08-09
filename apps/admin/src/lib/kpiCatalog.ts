/**
 * The KPI catalog — one entry per number the dashboard shows, and the single source of truth for what
 * that number means.
 *
 * Every KPI card and every table column that reports a count renders its entry through `KpiInfo`, so a
 * manager can answer "what exactly is in this figure?" without leaving the page or reading a doc.
 * `docs/kpi-definitions.md` is written from these same entries, so the tooltip and the documentation
 * cannot drift apart.
 *
 * Two families, deliberately never mixed on one line of arithmetic:
 *
 *  - `source`      — what ANOTHER system (AutoPlant) reports, as of its last sync. A point-in-time
 *                    counter about a different inventory. Never a denominator for an FSM rate.
 *  - `operational` — what FSM tracks in `device_states` right now. Every rate on the dashboard divides
 *                    one operational count by another.
 *  - `derived`     — a ratio of two operational counts.
 *
 * The 2026-07-29 defect was exactly a family mix-up: an operational numerator over a denominator that
 * silently included warehouse devices. Stating the family per KPI is what stops that recurring.
 */
export type KpiFamily = 'source' | 'operational' | 'derived';

export interface KpiDefinition {
  /** Stable key — also the `data-testid` suffix on the info button (`kpi-info-<key>`). */
  key: string;
  /** The explicit business name shown on the card. Never "Total Devices" / "Active Fleet". */
  name: string;
  family: KpiFamily;
  /** One sentence: what this number means to the business. */
  definition: string;
  /** What is counted, in domain terms. */
  counts: string;
  /** What is deliberately left out — the half operators cannot infer from the label. */
  excludes: string[];
  /** The table or endpoint the figure is read from. */
  source: string;
  /** What makes it change, and how often. */
  refresh: string;
  /** The computation, in terms of the source columns. */
  formula: string;
  /** Set when the KPI reconciles into a larger identity — shown as a "Reconciles with" line. */
  reconciles?: string;
}

const EXCLUDED_EVERYWHERE = [
  'Devices on a deactivated plant (Issue 119) — surfaced on the OH "Plant Deactivations" list instead',
  'Devices with no plant fitment (never mirrored to a plant)',
];

export const KPI_CATALOG: Record<string, KpiDefinition> = {
  autoplantCatalog: {
    key: 'autoplantCatalog',
    name: 'AutoPlant Catalog',
    family: 'source',
    definition:
      'Total unique devices discovered in AutoPlant during the latest successful master sync. Includes deployed, warehouse, retired, and other non-operational devices.',
    counts:
      'Every distinct fitted device_id the master-sync source read returned, across all deployment statuses, pan-India.',
    excludes: [
      'Nothing — this is the unfiltered source catalog',
      'Not zone-attributable: AutoPlant does not report an FSM zone, so this figure is pan-India only',
      'Not comparable to the operational counts: a different system, as of a different moment',
    ],
    source: 'master_sync_runs.entity_stats → devices.observed (latest SUCCESS run)',
    refresh: 'Daily master sync (and any manual "Run Ingestion Now"). Shown with its sync timestamp.',
    formula:
      "SELECT (entity_stats->'devices'->>'observed')::int FROM master_sync_runs WHERE status = 'SUCCESS' ORDER BY finished_at DESC LIMIT 1",
    reconciles:
      'Catalog − Not mirrored = Mirrored into FSM; devices FSM never mirrors are non-operational at source and were never known to FSM (GET /api/dashboard/fleet-composition has the full breakdown).',
  },

  mirroredDevices: {
    key: 'mirroredDevices',
    name: 'Mirrored Devices',
    family: 'operational',
    definition: 'Every device FSM holds a record for at this entity — operational plus warehouse.',
    counts: 'All device_states rows for the entity, on live plants.',
    excludes: EXCLUDED_EVERYWHERE,
    source: 'device_states (joined to plants)',
    refresh: 'Master sync (fitment changes) + the 30-minute device-state recompute.',
    formula: 'COUNT(device_states)',
    reconciles: 'Mirrored = Operational + Warehouse.',
  },

  operationalDevices: {
    key: 'operationalDevices',
    name: 'Operational Devices',
    family: 'operational',
    definition: 'Devices currently deployed in the field and tracked by FSM. No longer the denominator for the dashboard rates — since #223 that is Reporting Operational Devices (this figure minus Never-Reported).',
    counts: 'Mirrored devices whose deployment is live — no open device_departures row.',
    excludes: [
      'Warehouse / departed devices (removed from field operations)',
      ...EXCLUDED_EVERYWHERE,
    ],
    source: 'device_states',
    refresh: 'Master sync detects departures/restores; the device-state recompute mirrors them to is_departed.',
    formula: 'COUNT(device_states WHERE is_departed = false)',
    reconciles:
      'Σ company = Σ zone = this figure. Also equals Healthy + Inactive Operational + Never-Reported.',
  },

  warehouseDevices: {
    key: 'warehouseDevices',
    name: 'Warehouse Devices',
    family: 'operational',
    definition: 'Devices removed from field operations and held in a warehouse. Not broken — not counted against anyone.',
    counts: 'Mirrored devices with an open (unrestored) departure record.',
    excludes: [
      'Operational devices',
      'They are excluded from inactivity, SLA bucketing and uptime eligibility by design — a warehoused device must not age through the SLA bands',
      ...EXCLUDED_EVERYWHERE,
    ],
    source: 'device_states.is_departed, derived from device_departures',
    refresh: 'Master sync reconciles departures each run; recompute mirrors the flag.',
    formula: 'COUNT(device_states WHERE is_departed = true)',
    reconciles: 'Reconciles separately from the operational fleet: Operational + Warehouse = Mirrored.',
  },

  inactiveOperational: {
    key: 'inactiveOperational',
    name: 'Inactive Operational Devices',
    family: 'operational',
    definition: 'Devices that have reported at least once and have since gone silent for longer than the inactivity threshold, and are therefore in an SLA band.',
    counts: 'Reporting operational devices with an SLA bucket assigned (silent ≥ the configured inactivity threshold, canonically 24h).',
    excludes: [
      'Warehouse devices — a departed device is never counted inactive',
      'Devices inside the 0–4h ACTIVE band (no SLA bucket)',
      'Never-reported devices — they are counted once, under Never-Reported, even when their install-date age puts them past the threshold',
      ...EXCLUDED_EVERYWHERE,
    ],
    source: 'device_states.is_inactive + sla_bucket + latest_gps_datetime',
    refresh: 'Recomputed on the 30-minute telemetry tick — ages advance with wall-clock time, not only on new pings.',
    formula:
      'COUNT(device_states WHERE is_departed = false AND latest_gps_datetime IS NOT NULL AND is_inactive = true AND sla_bucket IS NOT NULL)',
    reconciles: 'Σ company = Σ zone = this figure. Also equals the sum of the per-SLA-bucket columns.',
  },

  healthyOperational: {
    key: 'healthyOperational',
    name: 'Healthy Operational Devices',
    family: 'operational',
    definition: 'Operational devices reporting normally — deployed, tracked, has reported at least once, and not inactive.',
    counts: 'Reporting operational devices with no SLA bucket (inside the ACTIVE band).',
    excludes: [
      'Warehouse devices',
      'Inactive operational devices',
      'Never-reported devices — until 2026-08-09 these were counted HERE, by construction (#223)',
      ...EXCLUDED_EVERYWHERE,
    ],
    source: 'device_states',
    refresh: 'Same 30-minute recompute as Inactive Operational Devices.',
    formula:
      'COUNT(device_states WHERE is_departed = false AND latest_gps_datetime IS NOT NULL AND NOT (is_inactive = true AND sla_bucket IS NOT NULL))',
    reconciles:
      'Healthy + Inactive Operational + Never-Reported = Operational Devices, exactly, at every level.',
  },

  neverReported: {
    key: 'neverReported',
    name: 'Never-Reported Devices',
    family: 'operational',
    definition:
      'Operational devices that have never sent a single GPS fix since being fitted. The third fleet state — not healthy, not silent-since-reporting, never alive.',
    counts:
      'Operational devices with no latest_gps_datetime at all. Fleet-wide this is 913 devices, 753 of them at two companies; 892 were confirmed at the AutoPlant source as fitted, deployed, and never having reported.',
    excludes: [
      'Warehouse devices',
      'Devices that reported once and later went silent — those are Inactive Operational',
      ...EXCLUDED_EVERYWHERE,
    ],
    source: 'device_states.latest_gps_datetime IS NULL',
    refresh:
      'Maintained at ingest, not by the recompute — the column is null until a first ping arrives, so a device leaves this count the moment it reports.',
    formula: 'COUNT(device_states WHERE is_departed = false AND latest_gps_datetime IS NULL)',
    reconciles:
      'Healthy + Inactive Operational + Never-Reported = Operational Devices. Shown beside Fleet Health rather than inside it, so an installation-quality failure is not read as a device failure.',
  },

  reportingOperational: {
    key: 'reportingOperational',
    name: 'Reporting Operational Devices',
    family: 'operational',
    definition:
      'Operational devices that have reported at least once. The denominator for Fleet Health % and Inactive %.',
    counts: 'Operational Devices minus Never-Reported Devices.',
    excludes: ['Warehouse devices', 'Never-reported devices', ...EXCLUDED_EVERYWHERE],
    source: 'device_states',
    refresh: 'Same 30-minute recompute; the never-reported side moves at ingest.',
    formula:
      'COUNT(device_states WHERE is_departed = false AND latest_gps_datetime IS NOT NULL)',
    reconciles: 'Healthy + Inactive Operational = this figure.',
  },

  fleetHealthPct: {
    key: 'fleetHealthPct',
    name: 'Fleet Health %',
    family: 'derived',
    definition: 'The share of the REPORTING fleet reporting normally.',
    counts: 'Healthy Operational Devices as a percentage of Reporting Operational Devices.',
    excludes: [
      'Warehouse devices are in neither the numerator nor the denominator',
      'Never-reported devices are in neither, since 2026-08-09 (#223) — they are excluded rather than scored 0%, so this KPI measures the reliability of devices that have actually reported. The never-reported count is shown beside it.',
      'Shown as "—" rather than 0% when the entity has nothing that has reported',
    ],
    source: 'Derived from device_states counts',
    refresh: 'Moves with the underlying counts (30-minute recompute).',
    formula: 'Healthy Operational Devices ÷ Reporting Operational Devices × 100',
    reconciles:
      'Fleet Health % + Inactive % = 100% for every row. Expect a one-off step change on the day #222+#223 landed: 82.96% → 84.84% pan-India.',
  },

  inactivePct: {
    key: 'inactivePct',
    name: 'Inactive %',
    family: 'derived',
    definition: 'The share of the REPORTING fleet currently inactive.',
    counts: 'Inactive Operational Devices as a percentage of Reporting Operational Devices.',
    excludes: [
      'Warehouse devices are in neither the numerator nor the denominator — including them understated this rate on every zone before 2026-07-29',
      'Never-reported devices are in neither, since 2026-08-09 (#223)',
      'Shown as "—" rather than 0% when the entity has nothing that has reported',
    ],
    source: 'Derived from device_states counts',
    refresh: 'Moves with the underlying counts (30-minute recompute).',
    formula: 'Inactive Operational Devices ÷ Reporting Operational Devices × 100',
    reconciles: 'Inactive % + Fleet Health % = 100% for every row.',
  },

  criticalDevices: {
    key: 'criticalDevices',
    name: 'Critical Devices',
    family: 'operational',
    definition: 'Operational devices in the CRITICAL SLA band — inactive between 24 and 48 hours.',
    counts: 'Strictly the CRITICAL band (Issue 122 operator decision); worse bands are shown in the Zone Overview and the SLA distribution.',
    excludes: [
      'Worse bands (High-Critical, Severe, Very-Severe, Long-Pending) — deliberately, so this is not a "critical and above" superset',
      'Warehouse devices',
    ],
    source: 'device_states.sla_bucket, via the zone-overview byBucket breakdown',
    refresh: '30-minute recompute.',
    formula: "Σ zone.byBucket['CRITICAL']",
    reconciles: "Equals the Zone Scorecard's Critical column summed across zones.",
  },

  fleetUptime: {
    key: 'fleetUptime',
    name: 'Fleet Uptime',
    family: 'derived',
    definition: 'Share of eligible device-time spent reporting, for the current month.',
    counts: 'Uptime across devices eligible for the uptime measure this month.',
    excludes: [
      'Devices not eligible for uptime (no active PGI in window, or a confirmed Non-Operational marking)',
      'Warehouse devices',
    ],
    source: 'Fleet Uptime monthly summary (/api/reports/fleet-uptime)',
    refresh: 'Recomputed by the monthly Fleet Uptime run; "—" until one has been computed.',
    formula: 'Reported by the Fleet Uptime report, not derived on this page',
  },

  companies: {
    key: 'companies',
    name: 'Companies',
    family: 'operational',
    definition: 'Distinct companies with at least one mirrored device in your scope.',
    counts: 'Distinct company_id across device_states in scope.',
    excludes: EXCLUDED_EVERYWHERE,
    source: 'device_states.company_id',
    refresh: 'Master sync.',
    formula: 'COUNT(DISTINCT device_states.company_id)',
    reconciles: 'Equals the Fleet Directory companies row count.',
  },

  plants: {
    key: 'plants',
    name: 'Plants',
    family: 'operational',
    definition: 'Distinct plants with at least one mirrored device in your scope.',
    counts: 'Distinct plant_id across device_states in scope.',
    excludes: EXCLUDED_EVERYWHERE,
    source: 'device_states.plant_id',
    refresh: 'Master sync.',
    formula: 'COUNT(DISTINCT device_states.plant_id)',
  },

  lastActivityAt: {
    key: 'lastActivityAt',
    name: 'Last Activity',
    family: 'operational',
    definition: 'When this entity’s fleet last reported a GPS position from the field.',
    counts: 'The most recent GPS ping across the entity’s devices.',
    excludes: ['Nothing — the newest ping wins, including from a device that has since gone inactive'],
    source: 'device_states.latest_gps_datetime',
    refresh: 'Maintained at telemetry ingest (30-minute snapshot).',
    formula: 'MAX(device_states.latest_gps_datetime)',
  },

  lastSnapshotAt: {
    key: 'lastSnapshotAt',
    name: 'Last Snapshot',
    family: 'operational',
    definition: 'When FSM last re-derived this entity’s device state — how fresh the inactivity ages below are.',
    counts: 'The most recent device-state recompute timestamp for the entity.',
    excludes: ['Not the same as Last Activity: FSM can recompute long after a device stopped pinging'],
    source: 'device_states.computed_at (per entity) / snapshot_runs.finished_at (fleet-wide)',
    refresh: '30-minute telemetry tick.',
    formula: 'MAX(device_states.computed_at)',
  },
};

/** Look up a KPI definition by key; returns undefined for an unknown key rather than throwing. */
export function kpiDef(key: string): KpiDefinition | undefined {
  return KPI_CATALOG[key];
}

/** Every definition, in catalog order — used by the docs generator and the KPI reference page. */
export const KPI_LIST: KpiDefinition[] = Object.values(KPI_CATALOG);

const FAMILY_LABEL: Record<KpiFamily, string> = {
  source: 'Source metric (AutoPlant)',
  operational: 'Operational metric (FSM)',
  derived: 'Derived rate',
};

export function familyLabel(family: KpiFamily): string {
  return FAMILY_LABEL[family];
}
