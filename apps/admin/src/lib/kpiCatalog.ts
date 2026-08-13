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

  // --- Commissioning cohort (#232 / #233 / #234) --------------------------------------------------
  // An INSTALL-QUALITY measure, not a fault queue. Every entry below is over the OPERATIONAL cohort —
  // fitments in the window whose device is `is_departed = false` on a live plant — which is the same
  // population every other rate in this catalog uses. Before #233 it was not, and a warehoused device
  // read as a failed install: 39.1% failure against an actual 5.2%.

  commissioningFitments: {
    key: 'commissioningFitments',
    name: 'Fitments in Window',
    family: 'operational',
    definition:
      'Commissioning events recorded in the selected window — one per (device, vehicle, install date), not one per device.',
    counts:
      'device_commissioning rows whose installed_at falls in the window, for devices in the operational fleet. A device re-mapped onto a second vehicle inside the window is TWO fitments; measured live, 6.4% of cohort devices have more than one.',
    excludes: [
      'Warehouse devices (an open device_departures row) — silent because they are in a box, not because an install failed',
      'Devices on a deactivated plant (#119)',
      'Fitments whose device has no device_states row at all (the fact outlived the mirror, #227)',
      'Fitments with no install date at source (~13% of source rows)',
    ],
    source: 'device_commissioning ⋈ device_states ⋈ plants',
    refresh:
      'Appended by the daily master sync, which is manual today (INGESTION_SCHEDULER_ENABLED is off). The window itself is derived at read time, so a device ageing out requires no write.',
    formula: "COUNT(device_commissioning WHERE installed_at >= now() - N days AND is_departed = false)",
    reconciles:
      'Operational + Warehouse + Deactivated-plant + Unmirrored = every fitment the window held. The page shows all four so the drop is named rather than silent.',
  },

  commissioningOnline: {
    key: 'commissioningOnline',
    name: 'Came Online',
    family: 'operational',
    definition: 'Fitments whose device has sent its first GPS fix, at or after the moment it was fitted.',
    counts:
      'Fitments where device_states.first_reported_at is set AND is at or after installed_at. The comparison is load-bearing, not defensive: a stamp EARLIER than its own fitment is a pre-existing device’s last-seen ping captured by the write-once column, and 2,138 rows on the mirror are in exactly that state.',
    excludes: [
      'device_commissioning.first_reported_at — that column is an observation-time snapshot (371 of 25,387 rows), so a reader requiring both to agree would report almost nothing as commissioned',
      ...EXCLUDED_EVERYWHERE,
    ],
    source: 'device_states.first_reported_at',
    refresh:
      'Write-once at ingest, by COALESCE in the same upsert that advances latest_gps_datetime. Nothing else in FSM retains a first-ever ping — it is observable exactly once, as it happens.',
    formula: 'COUNT(WHERE first_reported_at IS NOT NULL AND first_reported_at >= installed_at)',
    reconciles: 'Came Online + Awaiting First Report + Failed to Report = Fitments in Window.',
  },

  commissioningPending: {
    key: 'commissioningPending',
    name: 'Awaiting First Report',
    family: 'operational',
    definition: 'Fitted, still silent, and still inside the grace window. Not yet a defect.',
    counts: 'Fitments with no qualifying first report whose install is more recent than the grace cutoff (48 h by default).',
    excludes: ['Fitments past the grace window — those are Failed to Report', ...EXCLUDED_EVERYWHERE],
    source: 'device_commissioning.installed_at vs now() − graceHours',
    refresh: 'Ages continuously — a fitment crosses into Failed to Report on wall-clock, with no write.',
    formula: 'COUNT(WHERE NOT online AND installed_at > now() - graceHours)',
  },

  commissioningFailed: {
    key: 'commissioningFailed',
    name: 'Failed to Report',
    family: 'operational',
    definition: 'Fitted, past the grace window, and never seen. Broken, not slow.',
    counts:
      'Fitments with no qualifying first report whose install is older than the grace cutoff. There is essentially no commissioning tail: 96.97% of genuine new installations report within 12–24 h and the curve is flat after, so silence past the window is a defect rather than patience.',
    excludes: [
      'Warehouse devices — the single largest correction #233 made; they were 4,187 of the window’s fitments and dominated this count',
      ...EXCLUDED_EVERYWHERE,
    ],
    source: 'device_commissioning ⋈ device_states.first_reported_at',
    refresh: 'Ages continuously on wall-clock; a device that reports late leaves this count at the next telemetry tick.',
    formula: 'COUNT(WHERE NOT online AND installed_at <= now() - graceHours)',
  },

  commissioningTtfr: {
    key: 'commissioningTtfr',
    name: 'Median Time to First Report',
    family: 'derived',
    definition: 'How long a fitment took to come online, from install to first GPS fix.',
    counts:
      'The median over fitments that came online AND were fitted after the TTFR epoch. Sample size is always shown beside it, because it is much smaller than the online count and honestly so.',
    excludes: [
      'Fitments from before COMMISSIONING_TTFR_EPOCH — the write-once column captured a LAST-seen value for devices already reporting when it shipped, which yields a median of ~8,707 h against 17.26 h after',
      'Fitments that never came online (they have no duration, and averaging them in as zero or as “now” would both be fiction)',
    ],
    source: 'device_states.first_reported_at − device_commissioning.installed_at',
    refresh: 'Grows as post-epoch fitments accumulate. The epoch is fixed, so the excluded population shrinks on its own.',
    formula: 'percentile_cont(0.5) WITHIN GROUP (ORDER BY first_reported_at - installed_at)',
    reconciles:
      'Shown as “—” rather than 0 when nothing was measured. Zero would claim every device commissioned instantly; “—” says nothing was measured, and they are different answers.',
  },

  commissioningResolution: {
    key: 'commissioningResolution',
    name: 'Online Within 48 h',
    family: 'derived',
    definition:
      'The share of a fitment batch that came online inside 48 hours — the shape of an install cohort resolving, rather than a point-in-time count.',
    counts:
      'Measured over MATURED, POST-EPOCH fitments only: sample + never-online. Both exclusions are symmetric and both are reported on the page.',
    excludes: [
      'Fitments younger than 72 h — they have not had the full window the curve plots, and counting them biases it hardest on exactly the newest cohort',
      'Fitments from before the TTFR epoch, WHATEVER they did. Excluding only the pre-epoch fitments that came online, while keeping the silent ones, read 37.2% against an actual 83.1% — an inverted conclusion, not a rounding error',
    ],
    source: 'device_states.first_reported_at − device_commissioning.installed_at, banded',
    refresh:
      'Recomputed per request in the same pass as the counts. The pre-epoch exclusion ages out with no backfill: once the epoch is older than the 90-day ceiling, no cohort window can contain a pre-epoch fitment.',
    formula: 'COUNT(ttfr_hours < 48) / (sample + neverOnline), over matured post-epoch fitments',
    reconciles: 'Sample + Never-online = curve population; + pre-epoch excluded = matured; + immature = Fitments in Window.',
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
