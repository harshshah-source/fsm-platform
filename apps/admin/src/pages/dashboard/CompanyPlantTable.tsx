import { Fragment, useMemo, useState } from 'react';
import type { CompanyPlantRow } from '../../api/dashboard';
import { EmptyState, FilterBar, FilterSelect, Skeleton } from '../../components/data';
import { DurationBadge, StatusPill, TierBadge } from '../../components/domain';
import { Button } from '../../components/ui';
import { IconEye, IconEyeOff, IconTruck } from '../../components/ui/icons';
import { apiTicketsByPlant, type TicketRow } from '../../api/tickets';
import { cn } from '../../lib/cn';
import { downloadCsv, toCsv } from '../../lib/csv';
import { BUCKET_CLASS, BUCKET_LABEL, BUCKET_RANGE_LABEL, SLA_BUCKETS } from '../../lib/slaBucket';
import { formatInactiveOfTotal } from '../../lib/inactiveDuration';

interface CompanyGroup {
  companyId: string;
  companyName: string;
  companyTier: string;
  plants: CompanyPlantRow[];
}

function groupByCompany(rows: CompanyPlantRow[]): CompanyGroup[] {
  const byCompany = new Map<string, CompanyGroup>();
  for (const r of rows) {
    let g = byCompany.get(r.companyId);
    if (!g) {
      g = { companyId: r.companyId, companyName: r.companyName, companyTier: r.companyTier, plants: [] };
      byCompany.set(r.companyId, g);
    }
    g.plants.push(r);
  }
  return [...byCompany.values()];
}

const COLSPAN = 3 + SLA_BUCKETS.length;

/**
 * Company/Plant Overview (Issue 06 AC#3 · FE-06). Plants group under their company (with tier); a plant
 * drills down to its devices, loaded on demand from the ticket list. CSV export of the aggregates.
 *
 * Presentation-only refactor (FE-06): the company→plant→device grouping and drill-down are unique to
 * this page (the flat `DataTable` cannot express them), so the bespoke table is preserved but re-skinned
 * onto the design tokens + `TierBadge`. The `aria-label`, `bucket-<B>` test ids, filter label, the
 * devices toggle, and the export button are all preserved.
 */
export function CompanyPlantTable({ rows }: { rows: CompanyPlantRow[] }) {
  const [companyFilter, setCompanyFilter] = useState('');
  const allCompanies = useMemo(() => [...new Set(rows.map((r) => r.companyName))], [rows]);
  const companies = useMemo(
    () => groupByCompany(rows.filter((r) => companyFilter === '' || r.companyName === companyFilter)),
    [rows, companyFilter],
  );
  const [openPlant, setOpenPlant] = useState<string | null>(null);
  const [devices, setDevices] = useState<Record<string, TicketRow[]>>({});
  const [loadingPlant, setLoadingPlant] = useState<string | null>(null);

  const togglePlant = async (plantId: string) => {
    if (openPlant === plantId) {
      setOpenPlant(null);
      return;
    }
    setOpenPlant(plantId);
    if (!devices[plantId]) {
      setLoadingPlant(plantId);
      try {
        const loaded = await apiTicketsByPlant(plantId);
        setDevices((prev) => ({ ...prev, [plantId]: loaded }));
      } finally {
        setLoadingPlant((p) => (p === plantId ? null : p));
      }
    }
  };

  const exportCsv = () => {
    const headers = ['Company', 'Tier', 'Plant', 'Total inactive', 'Total devices', ...SLA_BUCKETS.map((b) => BUCKET_LABEL[b])];
    const body = rows.map((r) => [
      r.companyName,
      r.companyTier,
      r.plantName,
      r.totalInactive,
      r.totalDevices,
      ...SLA_BUCKETS.map((b) => r.byBucket[b] ?? 0),
    ]);
    downloadCsv('company-plant-overview.csv', toCsv(headers, body));
  };

  const th =
    'whitespace-nowrap px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-caps';

  return (
    <section aria-labelledby="company-plant-heading" className="mb-8">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3
          id="company-plant-heading"
          className="text-[11px] font-semibold uppercase tracking-wider text-ink-caps"
        >
          Company / Plant Overview
        </h3>
        <FilterBar className="mb-0">
          <FilterSelect
            aria-label="Filter by company"
            value={companyFilter}
            onChange={(e) => setCompanyFilter(e.target.value)}
          >
            <option value="">All companies</option>
            {allCompanies.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </FilterSelect>
          <Button variant="secondary" size="sm" onClick={exportCsv}>
            Export Company/Plant Overview
          </Button>
        </FilterBar>
      </div>
      <div className="overflow-hidden rounded-card border border-line bg-surface-card shadow-sm">
        <div className="overflow-x-auto">
          <table aria-label="Company/Plant Overview" className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-sunken/60">
                <th className={th}>Plant</th>
                <th className={cn(th, 'text-right')}>Inactive / Total</th>
                {SLA_BUCKETS.map((b) => (
                  <th key={b} className={cn(th, 'text-right')}>
                    {/* Column #2 — bucket label with its real inactivity range beneath (shared mapping). */}
                    <span className="flex flex-col items-end leading-tight">
                      <span>{BUCKET_LABEL[b]}</span>
                      <span className="text-[10px] font-normal normal-case tracking-normal text-ink-muted tabular-nums">
                        {BUCKET_RANGE_LABEL[b]}
                      </span>
                    </span>
                  </th>
                ))}
                <th className={cn(th, 'text-right')}>Devices</th>
              </tr>
            </thead>
            <tbody>
              {companies.map((co) => (
                <Fragment key={co.companyId}>
                  <tr className="bg-surface-sunken/60">
                    <td colSpan={COLSPAN} className="px-4 py-2 font-semibold text-ink-strong">
                      {co.companyName}
                      <TierBadge tier={co.companyTier} className="ml-2 align-middle" />
                    </td>
                  </tr>
                  {co.plants.map((p) => (
                    <Fragment key={p.plantId}>
                      <tr className="border-b border-line last:border-b-0">
                        <td className="px-4 py-2.5 pl-8 text-ink">{p.plantName}</td>
                        <td
                          data-testid="plant-inactive-total"
                          className="px-4 py-2.5 text-right tabular-nums text-ink"
                        >
                          {formatInactiveOfTotal(p.totalInactive, p.totalDevices)}
                        </td>
                        {SLA_BUCKETS.map((b) => {
                          const count = p.byBucket[b] ?? 0;
                          return (
                            <td key={b} className="px-4 py-2.5 text-right">
                              <span
                                data-testid={`bucket-${b}`}
                                className={cn(
                                  'inline-block min-w-7 rounded-full px-1.5 text-center text-xs font-semibold tabular-nums',
                                  count > 0 ? BUCKET_CLASS[b] : 'text-ink-muted/40',
                                )}
                              >
                                {count}
                              </span>
                            </td>
                          );
                        })}
                        <td className="px-4 py-2.5 text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => togglePlant(p.plantId)}
                            aria-expanded={openPlant === p.plantId}
                          >
                            {openPlant === p.plantId ? (
                              <IconEyeOff className="h-4 w-4" />
                            ) : (
                              <IconEye className="h-4 w-4" />
                            )}
                            {openPlant === p.plantId ? 'Hide devices' : 'View devices'}
                          </Button>
                        </td>
                      </tr>
                      {openPlant === p.plantId && (
                        <tr>
                          <td colSpan={COLSPAN} className="bg-surface-sunken/40 p-0">
                            <div className="px-6 py-4 sm:px-8">
                              <div className="overflow-hidden rounded-card border border-line bg-surface-card shadow-sm">
                                <div className="flex items-center justify-between gap-2 border-b border-line bg-surface-raised px-4 py-2.5">
                                  <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-caps">
                                    Open device tickets — {p.plantName}
                                  </span>
                                  {!loadingPlant && (
                                    <span className="text-xs tabular-nums text-ink-muted">
                                      {(devices[p.plantId] ?? []).length}
                                    </span>
                                  )}
                                </div>
                                {loadingPlant === p.plantId ? (
                                  <ul>
                                    {Array.from({ length: 3 }).map((_, i) => (
                                      <li
                                        key={`sk-${i}`}
                                        className="flex items-center justify-between gap-3 border-b border-line/70 px-4 py-2.5 last:border-b-0"
                                      >
                                        <Skeleton className="h-4 w-28" />
                                        <Skeleton className="h-5 w-20" />
                                      </li>
                                    ))}
                                  </ul>
                                ) : (devices[p.plantId] ?? []).length === 0 ? (
                                  <EmptyState
                                    icon={<IconTruck />}
                                    message="No open device tickets at this plant."
                                  />
                                ) : (
                                  <ul>
                                    {(devices[p.plantId] ?? []).map((d) => (
                                      <li
                                        key={d.ticketId}
                                        className="flex items-center justify-between gap-3 border-b border-line/70 px-4 py-2.5 text-sm transition-colors last:border-b-0 hover:bg-surface-sunken/50"
                                      >
                                        <span className="flex min-w-0 items-baseline gap-1.5">
                                          <span className="text-[11px] font-medium uppercase tracking-wide text-ink-caps">
                                            Device
                                          </span>
                                          <span className="font-mono tabular-nums text-ink-strong">
                                            {d.deviceId}
                                          </span>
                                        </span>
                                        <span className="flex shrink-0 items-center gap-2">
                                          <DurationBadge
                                            bucket={d.slaBucket}
                                            latestGpsDatetime={d.latestGpsDatetime}
                                          />
                                          <StatusPill status={d.status} />
                                        </span>
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
