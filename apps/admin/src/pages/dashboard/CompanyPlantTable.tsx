import { Fragment, useMemo, useState } from 'react';
import type { CompanyPlantRow } from '../../api/dashboard';
import { FilterBar, FilterSelect } from '../../components/data';
import { TierBadge } from '../../components/domain';
import { Button } from '../../components/ui';
import { apiTicketsByPlant, type TicketRow } from '../../api/tickets';
import { cn } from '../../lib/cn';
import { downloadCsv, toCsv } from '../../lib/csv';
import { BUCKET_CLASS, BUCKET_LABEL, SLA_BUCKETS } from '../../lib/slaBucket';

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

  const togglePlant = async (plantId: string) => {
    if (openPlant === plantId) {
      setOpenPlant(null);
      return;
    }
    setOpenPlant(plantId);
    if (!devices[plantId]) {
      const loaded = await apiTicketsByPlant(plantId);
      setDevices((prev) => ({ ...prev, [plantId]: loaded }));
    }
  };

  const exportCsv = () => {
    const headers = ['Company', 'Tier', 'Plant', 'Total inactive', ...SLA_BUCKETS.map((b) => BUCKET_LABEL[b])];
    const body = rows.map((r) => [
      r.companyName,
      r.companyTier,
      r.plantName,
      r.totalInactive,
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
                <th className={cn(th, 'text-right')}>Total</th>
                {SLA_BUCKETS.map((b) => (
                  <th key={b} className={cn(th, 'text-right')}>
                    {BUCKET_LABEL[b]}
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
                        <td className="px-4 py-2.5 text-right tabular-nums text-ink">{p.totalInactive}</td>
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
                            View devices
                          </Button>
                        </td>
                      </tr>
                      {openPlant === p.plantId && (
                        <tr>
                          <td colSpan={COLSPAN} className="bg-surface-sunken/40 px-8 py-3 text-xs">
                            {(devices[p.plantId] ?? []).length === 0 ? (
                              <span className="text-ink-muted">No open device tickets at this plant.</span>
                            ) : (
                              <ul className="flex flex-col gap-1">
                                {(devices[p.plantId] ?? []).map((d) => (
                                  <li key={d.ticketId} className="text-ink">
                                    Device {d.deviceId} — {d.slaBucket ?? '—'} ({d.status})
                                  </li>
                                ))}
                              </ul>
                            )}
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
