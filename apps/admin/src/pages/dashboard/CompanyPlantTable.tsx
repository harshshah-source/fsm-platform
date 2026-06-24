import { Fragment, useMemo, useState } from 'react';
import type { CompanyPlantRow } from '../../api/dashboard';
import { apiTicketsByPlant, type TicketRow } from '../../api/tickets';
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
 * Company/Plant Overview (Issue 06 AC#3). Plants group under their company (with tier); a plant
 * drills down to its devices, loaded on demand from the ticket list. CSV export of the aggregates.
 */
export function CompanyPlantTable({ rows }: { rows: CompanyPlantRow[] }) {
  const [companyFilter, setCompanyFilter] = useState('');
  const allCompanies = useMemo(
    () => [...new Set(rows.map((r) => r.companyName))],
    [rows],
  );
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

  return (
    <section aria-labelledby="company-plant-heading" className="mb-8">
      <div className="mb-2 flex items-center justify-between">
        <h3 id="company-plant-heading" className="text-lg font-semibold">
          Company / Plant Overview
        </h3>
        <div className="flex items-center gap-2 text-sm">
          <select
            aria-label="Filter by company"
            value={companyFilter}
            onChange={(e) => setCompanyFilter(e.target.value)}
            className="rounded border px-2 py-1"
          >
            <option value="">All companies</option>
            {allCompanies.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <button type="button" onClick={exportCsv} className="rounded border px-2 py-1">
            Export Company/Plant Overview
          </button>
        </div>
      </div>
      <table aria-label="Company/Plant Overview" className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b text-left">
            <th className="py-1 pr-3">Plant</th>
            <th className="py-1 pr-3">Total</th>
            {SLA_BUCKETS.map((b) => (
              <th key={b} className="py-1 pr-2">
                {BUCKET_LABEL[b]}
              </th>
            ))}
            <th className="py-1 pr-2">Devices</th>
          </tr>
        </thead>
        <tbody>
          {companies.map((co) => (
            <Fragment key={co.companyId}>
              <tr className="bg-slate-50">
                <td colSpan={COLSPAN} className="py-1 pr-3 font-semibold">
                  {co.companyName}{' '}
                  <span className="ml-2 rounded bg-slate-200 px-1 text-xs">{co.companyTier}</span>
                </td>
              </tr>
              {co.plants.map((p) => (
                <Fragment key={p.plantId}>
                  <tr className="border-b">
                    <td className="py-1 pr-3 pl-4">{p.plantName}</td>
                    <td className="py-1 pr-3">{p.totalInactive}</td>
                    {SLA_BUCKETS.map((b) => {
                      const count = p.byBucket[b] ?? 0;
                      return (
                        <td key={b} className="py-1 pr-2">
                          <span
                            data-testid={`bucket-${b}`}
                            className={`inline-block min-w-6 rounded px-1 text-center ${
                              count > 0 ? BUCKET_CLASS[b] : 'text-slate-300'
                            }`}
                          >
                            {count}
                          </span>
                        </td>
                      );
                    })}
                    <td className="py-1 pr-2">
                      <button
                        type="button"
                        onClick={() => togglePlant(p.plantId)}
                        aria-expanded={openPlant === p.plantId}
                        className="rounded border px-2 py-0.5 text-xs"
                      >
                        View devices
                      </button>
                    </td>
                  </tr>
                  {openPlant === p.plantId && (
                    <tr>
                      <td colSpan={COLSPAN} className="bg-slate-50 px-4 py-2 text-xs">
                        {(devices[p.plantId] ?? []).length === 0 ? (
                          <span className="text-slate-500">No open device tickets at this plant.</span>
                        ) : (
                          <ul className="flex flex-col gap-1">
                            {(devices[p.plantId] ?? []).map((d) => (
                              <li key={d.ticketId}>
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
    </section>
  );
}
