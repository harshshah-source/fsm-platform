import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  apiCompanyPlantOverview,
  apiFleetSummary,
  apiZoneOperations,
  type CompanyPlantRow,
  type ZoneOperationsSummary,
} from '../../api/dashboard';
import type { DeviceStatusFilter } from '../../api/devices';
import { BarList, ChartCard, DistributionBar, type BarListItem, type DistSegment } from '../../components/charts';
import { EmptyState, MetricStrip, Skeleton, type Metric } from '../../components/data';
import { CompanyPlantTable } from '../dashboard/CompanyPlantTable';
import { formatCount, formatPct, formatStamp } from '../../lib/fleetFormat';
import { resolvePlantName } from '../../lib/plantNames';
import { BUCKET_COLOR, BUCKET_LABEL_RANGE, criticalPlusCount, SLA_BUCKETS } from '../../lib/slaBucket';

/** How many plants the ranked chart names before the tail is folded into one "other" row. */
const TOP_PLANTS = 8;

/** Aggregate of the zone's company×plant rows — every band on this section reads from this one object. */
interface ZoneRollup {
  operational: number;
  inactive: number;
  healthy: number;
  warehouse: number;
  byBucket: Record<string, number>;
  companies: number;
  plants: number;
  /** Per-plant totals, keyed by plantId (a plant serving two companies contributes one row here). */
  plantTotals: { plantId: string; plantName: string; inactive: number; healthy: number; operational: number }[];
}

function rollUp(rows: CompanyPlantRow[]): ZoneRollup {
  const byBucket: Record<string, number> = {};
  const companies = new Set<string>();
  const plants = new Map<string, { plantId: string; plantName: string; inactive: number; healthy: number; operational: number }>();
  let operational = 0;
  let inactive = 0;
  let healthy = 0;
  let warehouse = 0;

  for (const r of rows) {
    operational += r.operationalDevices;
    inactive += r.inactiveOperational;
    healthy += r.healthyOperational;
    warehouse += r.warehouseDevices;
    companies.add(r.companyId);
    for (const b of SLA_BUCKETS) byBucket[b] = (byBucket[b] ?? 0) + (r.byBucket[b] ?? 0);
    // A plant can appear once per company it serves; the plant-level chart wants it once, summed.
    const p = plants.get(r.plantId) ?? {
      plantId: r.plantId,
      plantName: r.plantName,
      inactive: 0,
      healthy: 0,
      operational: 0,
    };
    p.inactive += r.inactiveOperational;
    p.healthy += r.healthyOperational;
    p.operational += r.operationalDevices;
    plants.set(r.plantId, p);
  }

  return {
    operational,
    inactive,
    healthy,
    warehouse,
    byBucket,
    companies: companies.size,
    plants: plants.size,
    plantTotals: [...plants.values()],
  };
}

/** `n / d` as a 0–1 share for a KPI card's proportion bar; null when there is nothing to divide by. */
const share = (n: number, d: number): number | null => (d > 0 ? n / d : null);

/**
 * Plant label for the ranked chart: `ACP-9106 · ARASMETA CEMENT PLANT`, i.e. the AutoPlant code
 * first. The table and every other surface keep the house format (name, code in parentheses) — this
 * one inverts it because a ranked bar's label lives in a fixed-width gutter and truncates, and the
 * code is what makes two plants of the same group tellable apart. Unmapped identifiers are left as-is.
 */
function plantChartLabel(raw: string): string {
  const { full, id } = resolvePlantName(raw);
  return full ? `${id} · ${full}` : id;
}

/**
 * The company → plant breakdown that sits above the Device Detail table when the page is entered as a
 * ZONE drill-down (`/reports/device?zoneId=…&status=…`, the Zone Performance Scorecard's row
 * click-through). It answers the questions an operator would otherwise navigate away for — how big is
 * this zone's problem, how severe, which plants own it, and who is holding the work — so the device
 * table below stays the detail view rather than the only view.
 *
 * **Everything here is scoped by the page's live `zoneId` + `status`**, including the aggregates: the
 * company/plant rows are fetched zone-filtered server-side, and the assignment band re-queries on a
 * status change. The one deliberate exception is the Operational Devices card and the composition
 * bar, which always describe the zone's full operational fleet — they are the denominator the
 * filtered numbers sit inside, and are labelled as such. A rate needs its reference visible.
 *
 * `status` narrows what the bands describe rather than hiding rows:
 *   - `INACTIVE` — the headline pair becomes Inactive + Inactive >24Hr, plants rank by inactive count
 *   - `ACTIVE`   — headline becomes Healthy + Fleet Health %, and the SLA spread is dropped entirely
 *                  (every band is zero by definition — a column with no information, not a result)
 *   - `ALL`      — the full picture
 *
 * Zero rows are never hidden. A plant with no inactive devices is a *result* — it is the one doing
 * well — and dropping it would leave an operator unable to tell a healthy plant from a missing one.
 */
export function ZoneDrilldownSection({
  zoneId,
  zoneName,
  status,
}: {
  /** The live zone filter: '' (none), 'UNZONED', or a numeric zone id as a string. */
  zoneId: string;
  /** Display name for the scope chip; falls back to the id when the options haven't loaded. */
  zoneName?: string;
  status: DeviceStatusFilter;
}) {
  const [rows, setRows] = useState<CompanyPlantRow[] | null>(null);
  const [ops, setOps] = useState<ZoneOperationsSummary | null>(null);
  const [snapshotAt, setSnapshotAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Only a real, numeric zone is aggregatable. '' (all zones in scope) and 'UNZONED' are refused
  // rather than answered — see the explanation block below for why.
  const scoped = /^\d+$/.test(zoneId);

  useEffect(() => {
    if (!scoped) {
      setRows(null);
      setOps(null);
      return;
    }
    let live = true;
    setRows(null);
    setOps(null);
    setError(null);
    // Fired in parallel with — never before — the device list the page already loads, so the table
    // below renders on its own schedule and this section fills in underneath it.
    Promise.all([
      apiCompanyPlantOverview({ zoneId }),
      apiZoneOperations({ zoneId, status }),
    ])
      .then(([overview, operations]) => {
        if (!live) return;
        setRows(overview);
        setOps(operations);
      })
      .catch(() => live && setError('Failed to load the zone breakdown'));
    return () => {
      live = false;
    };
  }, [zoneId, status, scoped]);

  // Snapshot freshness for the scope chip — the same stamp the dashboard's Operational Fleet strip
  // shows. Global (the latest successful snapshot run), so it is fetched once, not per zone.
  useEffect(() => {
    let live = true;
    apiFleetSummary()
      .then((f) => live && setSnapshotAt(f.lastSnapshotAt))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const roll = useMemo(() => (rows ? rollUp(rows) : null), [rows]);

  // Ranked plants — the "where do I send someone" chart. Ranked bars, one colour: bar length already
  // carries the magnitude, so colouring each bar differently would spend the only free channel
  // restating it. The tail folds into one row instead of generating a ninth hue.
  //
  // Declared here, above every early return, because hooks may not sit behind a conditional.
  const rankMetric: 'healthy' | 'inactive' = status === 'ACTIVE' ? 'healthy' : 'inactive';
  const plantBars: BarListItem[] = useMemo(() => {
    if (!roll) return [];
    const sorted = [...roll.plantTotals].sort((a, b) => b[rankMetric] - a[rankMetric]);
    const head = sorted.slice(0, TOP_PLANTS);
    const tail = sorted.slice(TOP_PLANTS);
    const items: BarListItem[] = head.map((p) => ({
      // Code FIRST, then the mapped name. `formatPlantDisplayName` renders "ARASMETA CEMENT PLANT
      // (ACP-9106)", whose unique part is the suffix — in a truncating gutter two different plants of
      // the same group both render "ARASMETA CEMENT P…" and the chart names two bars identically.
      // Leading with the code keeps every row distinguishable however narrow the label gets.
      label: plantChartLabel(p.plantName),
      value: p[rankMetric],
      id: p.plantId,
    }));
    if (tail.length > 0) {
      items.push({
        label: `Other (${tail.length} plant${tail.length === 1 ? '' : 's'})`,
        value: tail.reduce((s, p) => s + p[rankMetric], 0),
        color: 'var(--color-neutral)',
        id: '__other__',
      });
    }
    return items;
  }, [roll, rankMetric]);

  if (!scoped) {
    return (
      <section aria-labelledby="zone-drilldown-heading" className="mb-5">
        <h3 id="zone-drilldown-heading" className="sr-only">
          Zone breakdown
        </h3>
        <div
          data-testid="zone-drilldown-unscoped"
          className="rounded-card border border-dashed border-line bg-surface-card px-4 py-3 text-sm text-ink-muted"
        >
          {zoneId === 'UNZONED'
            ? 'No zone breakdown for UNZONED — this filter and the zone dashboards currently count different device populations, so any total shown here would answer a question you did not ask. The device table below is unaffected.'
            : 'Pick a single zone to see its company and plant breakdown. The device table below is unaffected.'}
        </div>
      </section>
    );
  }

  const criticalPlus = roll ? criticalPlusCount(roll.byBucket) : 0;
  const showSla = status !== 'ACTIVE';

  // ── KPI strip ────────────────────────────────────────────────────────────────
  // Six cards, each answering one question. The headline pair follows the status filter; the rest is
  // fixed so the strip does not reshuffle under the operator when they flip the filter.
  const headline: Metric[] =
    status === 'ACTIVE'
      ? [
          {
            label: 'Healthy Operational',
            value: roll ? formatCount(roll.healthy) : '—',
            hint: roll ? `of ${formatCount(roll.operational)} operational` : undefined,
            share: roll ? share(roll.healthy, roll.operational) : null,
            tone: 'success',
            kpi: 'healthyOperational',
            testId: 'zone-kpi-healthy',
          },
          {
            label: 'Fleet Health %',
            value: roll ? formatPct(share(roll.healthy, roll.operational) == null ? null : (roll.healthy / roll.operational) * 100) : '—',
            hint: 'healthy ÷ operational',
            tone: 'success',
            kpi: 'fleetHealthPct',
            testId: 'zone-kpi-health-pct',
          },
        ]
      : [
          {
            label: 'Inactive Operational',
            value: roll ? formatCount(roll.inactive) : '—',
            hint: roll ? `of ${formatCount(roll.operational)} operational` : undefined,
            share: roll ? share(roll.inactive, roll.operational) : null,
            tone: 'warning',
            kpi: 'inactiveOperational',
            testId: 'zone-kpi-inactive',
          },
          {
            label: 'Inactive > 24Hr',
            value: roll ? formatCount(criticalPlus) : '—',
            hint: roll ? `of ${formatCount(roll.inactive)} inactive` : undefined,
            share: roll ? share(criticalPlus, roll.inactive) : null,
            tone: 'critical',
            testId: 'zone-kpi-critical-plus',
          },
        ];

  const metrics: Metric[] = [
    ...headline,
    {
      label: 'Operational Devices',
      value: roll ? formatCount(roll.operational) : '—',
      hint: roll ? `${formatCount(roll.warehouse)} more in warehouse` : undefined,
      tone: 'brand',
      kpi: 'operationalDevices',
      testId: 'zone-kpi-operational',
    },
    {
      label: 'Companies',
      value: roll ? formatCount(roll.companies) : '—',
      hint: roll ? `across ${formatCount(roll.plants)} plant${roll.plants === 1 ? '' : 's'}` : undefined,
      tone: 'info',
      kpi: 'companies',
      testId: 'zone-kpi-companies',
    },
    {
      label: 'Unassigned Work',
      value: ops ? formatCount(ops.unassigned) : '—',
      hint: ops ? `of ${formatCount(ops.openTickets)} open ticket${ops.openTickets === 1 ? '' : 's'}` : undefined,
      share: ops ? share(ops.unassigned, ops.openTickets) : null,
      tone: 'critical',
      testId: 'zone-kpi-unassigned',
    },
    {
      label: 'Live Batches',
      value: ops ? formatCount(ops.liveBatches) : '—',
      hint: ops
        ? `${formatCount(ops.engineersEngaged)} SE${ops.engineersEngaged === 1 ? '' : 's'} engaged · ${formatCount(ops.overriddenBatches)} overridden`
        : undefined,
      tone: 'verified',
      testId: 'zone-kpi-batches',
    },
  ];

  // ── Charts ───────────────────────────────────────────────────────────────────
  // Composition: healthy vs inactive over the zone's operational fleet. Two directly-labelled
  // segments, so identity never rests on colour; the pair is CVD-validated (ΔE 12.5 deutan) and the
  // inactive side reuses the page's own SLA ramp rather than introducing a second red.
  const composition: DistSegment[] = roll
    ? [
        { label: 'Healthy', value: roll.healthy, color: 'var(--color-success)' },
        { label: 'Inactive', value: roll.inactive, color: 'var(--sla-very-severe)' },
      ]
    : [];

  // SLA spread: the same eight ordered bands the table's columns use, least→most severe, on the
  // shared ordinal ramp. Composition is the question ("how much of the backlog is old?"), so it is
  // one proportion bar rather than eight columns.
  const slaSegments: DistSegment[] = roll
    ? [...SLA_BUCKETS]
        .reverse()
        .map((b) => ({ label: BUCKET_LABEL_RANGE[b], value: roll.byBucket[b] ?? 0, color: BUCKET_COLOR[b] }))
    : [];

  const loading = rows === null && error === null;
  const hasSla = slaSegments.some((s) => s.value > 0);
  const hasPlants = plantBars.some((p) => p.value > 0);

  return (
    <section aria-labelledby="zone-drilldown-heading" className="mb-6">
      <h3 id="zone-drilldown-heading" className="sr-only">
        Zone breakdown — {zoneName ?? zoneId}
      </h3>

      {/* Scope chips (v2 reference 22): what this page is currently showing, stated rather than
          implied by a pre-selected dropdown. */}
      <div data-testid="zone-scope-bar" className="mb-3 flex flex-wrap items-center gap-2">
        <ScopeChip tone="brand">{zoneName ?? `Zone ${zoneId}`}</ScopeChip>
        <ScopeChip>{STATUS_CHIP[status]}</ScopeChip>
        <ScopeChip>Data as of {formatStamp(snapshotAt)}</ScopeChip>
      </div>

      {error && (
        <div role="alert" className="mb-4 rounded-md border border-critical/30 bg-critical-bg px-3 py-2 text-sm text-critical">
          {error}
        </div>
      )}

      {loading ? (
        <div data-testid="zone-drilldown-loading" className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6 xl:gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-[104px] rounded-card" />
          ))}
        </div>
      ) : (
        <MetricStrip metrics={metrics} cols={6} />
      )}

      {/* Two-up on a laptop, stacked below it — neither card needs horizontal room to stay readable. */}
      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title={`Operational fleet — ${zoneName ?? 'this zone'}`}>
          {loading ? (
            <Skeleton className="h-16 w-full" />
          ) : roll && roll.operational > 0 ? (
            <>
              <DistributionBar segments={composition} testId="zone-composition" />
              <p className="mt-3 text-xs text-ink-muted">
                The zone's whole operational fleet — the denominator the filtered figures above sit
                inside. Warehouse devices ({formatCount(roll.warehouse)}) reconcile separately and are
                in neither side.
              </p>
            </>
          ) : (
            <EmptyState message="No operational devices in this zone." />
          )}
        </ChartCard>

        <ChartCard
          title={status === 'ACTIVE' ? 'Healthy devices by plant' : 'Inactive devices by plant'}
        >
          {loading ? (
            <Skeleton className="h-40 w-full" />
          ) : hasPlants ? (
            <>
              {/* One series, one colour — bar length already carries the magnitude. The colour still
                  has to mean the right thing: ranking HEALTHY devices in the same alarm red as
                  inactive ones would read as "these plants are the problem" when they are the
                  opposite. */}
              <BarList
                items={plantBars}
                color={status === 'ACTIVE' ? 'var(--color-success)' : 'var(--color-brand-600)'}
                labelWidth="w-44"
              />
              {plantBars.length === 1 && (
                <p className="mt-3 text-xs text-ink-muted">This zone has a single plant.</p>
              )}
            </>
          ) : (
            <EmptyState
              message={
                status === 'ACTIVE'
                  ? 'No healthy devices to rank in this zone.'
                  : 'No inactive devices in this zone — nothing to rank.'
              }
            />
          )}
        </ChartCard>
      </div>

      {showSla && (
        <ChartCard title="SLA spread — how old the inactivity is" className="mb-6">
          {loading ? (
            <Skeleton className="h-16 w-full" />
          ) : hasSla ? (
            <>
              <DistributionBar segments={slaSegments} testId="zone-sla-spread" />
              <p className="mt-3 text-xs text-ink-muted">
                Least to most severe, left to right. Severity is carried by shade as well as hue, so
                the order reads without relying on colour vision.
              </p>
            </>
          ) : (
            <EmptyState message="No inactive devices in this zone — no SLA spread to show." />
          )}
        </ChartCard>
      )}

      {loading ? (
        <Skeleton className="mb-6 h-48 w-full rounded-card" />
      ) : rows && rows.length > 0 ? (
        <CompanyPlantTable rows={rows} statusScope={status} />
      ) : (
        <div className="mb-6 rounded-card border border-line bg-surface-card px-4 py-6">
          <EmptyState message="No companies or plants with tracked devices in this zone." />
        </div>
      )}
    </section>
  );
}

const STATUS_CHIP: Record<DeviceStatusFilter, string> = {
  ALL: 'All device statuses',
  INACTIVE: 'Inactive devices only',
  ACTIVE: 'Active devices only',
};

/** Small scope pill — mirrors the v2 reference's `WEST ZONE · DATA AS OF … · ZONAL MANAGER` band. */
function ScopeChip({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'brand' }) {
  return (
    <span
      className={
        tone === 'brand'
          // `brand-600`, not `brand-700`: on the dark canvas `brand-700` resolves to #a5122a, which on a
        // near-black chip is the same unreadable dark-red the app already fixed once elsewhere.
        // `brand-600` re-points to a brighter #d81f3c in dark and stays legible in both themes.
        ? 'inline-flex items-center rounded-full border border-brand-600/30 bg-brand-600/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-brand-600'
          : 'inline-flex items-center rounded-full border border-line bg-surface-sunken px-2.5 py-1 text-[11px] font-medium uppercase tracking-wider text-ink-muted'
      }
    >
      {children}
    </span>
  );
}
