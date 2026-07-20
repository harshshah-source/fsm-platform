import { Fragment, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { DispatchBatchRow, PlantDeviceStats } from '../../api/dispatch-runs';
import { EmptyState, FilterBar, FilterSelect, SearchInput } from '../../components/data';
import { Badge } from '../../components/ui';
import { IconChevronRight, IconTruck } from '../../components/ui/icons';
import { cn } from '../../lib/cn';

const ZERO_STATS: PlantDeviceStats = { totalDevices: 0, inactiveDevices: 0, assignedDevices: 0, unassignedDevices: 0 };

interface PlantGroup {
  plantId: string;
  plantName: string;
  companyName: string;
  assignments: number;
  batches: DispatchBatchRow[];
  stats: PlantDeviceStats;
}

interface CompanyGroup {
  companyName: string;
  plants: PlantGroup[];
  assignments: number;
  batchCount: number;
  stats: PlantDeviceStats;
}

const UNKNOWN_COMPANY = 'Unknown company';

/** Sum the per-plant fleet stats of a company's plants for its aggregate row. */
function sumStats(plants: PlantGroup[]): PlantDeviceStats {
  return plants.reduce<PlantDeviceStats>(
    (acc, p) => ({
      totalDevices: acc.totalDevices + p.stats.totalDevices,
      inactiveDevices: acc.inactiveDevices + p.stats.inactiveDevices,
      assignedDevices: acc.assignedDevices + p.stats.assignedDevices,
      unassignedDevices: acc.unassignedDevices + p.stats.unassignedDevices,
    }),
    { ...ZERO_STATS },
  );
}

/** Group a zone's dispatched batches into company → plant, tallying assignments (tickets) and batches. */
function groupByCompanyPlant(
  batches: DispatchBatchRow[],
  plantStats: Record<string, PlantDeviceStats>,
): CompanyGroup[] {
  const byCompany = new Map<string, Map<string, PlantGroup>>();
  for (const b of batches) {
    const companyName = b.companyName ?? UNKNOWN_COMPANY;
    let plants = byCompany.get(companyName);
    if (!plants) {
      plants = new Map();
      byCompany.set(companyName, plants);
    }
    let plant = plants.get(b.plantId);
    if (!plant) {
      plant = {
        plantId: b.plantId,
        plantName: b.plantName,
        companyName,
        assignments: 0,
        batches: [],
        stats: plantStats[b.plantId] ?? ZERO_STATS,
      };
      plants.set(b.plantId, plant);
    }
    plant.assignments += b.ticketCount;
    plant.batches.push(b);
  }
  return [...byCompany.entries()].map(([companyName, plants]) => {
    const plantList = [...plants.values()];
    return {
      companyName,
      plants: plantList,
      assignments: plantList.reduce((n, p) => n + p.assignments, 0),
      batchCount: plantList.reduce((n, p) => n + p.batches.length, 0),
      stats: sumStats(plantList),
    };
  });
}

type SortOrder = '' | 'ASSIGN_DESC' | 'ASSIGN_ASC';

// company + plant + inactive/total + assigned + unassigned + assignments + batches + expander.
const COLSPAN = 8;

/** "inactive / total" fleet-health cell, muted when the plant has no devices on record. */
function InactiveTotal({ stats }: { stats: PlantDeviceStats }) {
  if (stats.totalDevices === 0) return <span className="text-ink-muted">—</span>;
  return (
    <span className="tabular-nums">
      <span className={cn(stats.inactiveDevices > 0 && 'font-semibold text-critical')}>{stats.inactiveDevices}</span>
      <span className="text-ink-muted"> / {stats.totalDevices}</span>
    </span>
  );
}

/**
 * Zone dispatch overview (change-request 2026-07). Instead of a flat per-engineer batch list, the zone
 * opens on its companies and plants: each plant shows how many assignments (tickets) and batches formed
 * in it. Expanding a company reveals its plants; a plant with one batch drills straight into that batch,
 * a plant with several expands to a batch list — each batch links to its assignment + decision trace.
 * Search (company / plant), a batch-status filter, and an assignment-count sort scope the tree.
 */
export function ZoneDispatchTable({
  batches,
  plantStats,
}: {
  batches: DispatchBatchRow[];
  plantStats: Record<string, PlantDeviceStats>;
}) {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [sortOrder, setSortOrder] = useState<SortOrder>('');
  const [openCompanies, setOpenCompanies] = useState<Set<string>>(new Set());
  const [openPlant, setOpenPlant] = useState<string | null>(null);

  const term = search.trim().toLowerCase();

  const statuses = useMemo(() => [...new Set(batches.map((b) => b.status))].sort(), [batches]);

  const companies = useMemo(() => {
    const scoped = status ? batches.filter((b) => b.status === status) : batches;
    const groups = groupByCompanyPlant(scoped, plantStats);
    const filtered = !term
      ? groups
      : groups
          .map((g) => {
            const companyMatch = g.companyName.toLowerCase().includes(term);
            const plants = companyMatch ? g.plants : g.plants.filter((p) => p.plantName.toLowerCase().includes(term));
            if (!companyMatch && plants.length === 0) return null;
            return {
              ...g,
              plants,
              assignments: plants.reduce((n, p) => n + p.assignments, 0),
              batchCount: plants.reduce((n, p) => n + p.batches.length, 0),
              stats: sumStats(plants),
            };
          })
          .filter((g): g is CompanyGroup => g !== null);

    if (!sortOrder) return [...filtered].sort((a, b) => a.companyName.localeCompare(b.companyName));
    const dir = sortOrder === 'ASSIGN_DESC' ? -1 : 1;
    return filtered
      .map((g) => ({ ...g, plants: [...g.plants].sort((a, b) => (a.assignments - b.assignments) * dir) }))
      .sort((a, b) => (a.assignments - b.assignments) * dir);
  }, [batches, plantStats, term, status, sortOrder]);

  const toggleCompany = (companyName: string) =>
    setOpenCompanies((prev) => {
      const next = new Set(prev);
      if (next.has(companyName)) next.delete(companyName);
      else next.add(companyName);
      return next;
    });

  const openBatch = (batchId: string) => navigate(`/batches/${batchId}`);

  const onPlantClick = (p: PlantGroup) => {
    // One batch → straight to its assignment table; several → expand an in-row batch list to choose.
    if (p.batches.length === 1) {
      openBatch(p.batches[0].batchId);
      return;
    }
    setOpenPlant((cur) => (cur === p.plantId ? null : p.plantId));
  };

  const th = 'whitespace-nowrap px-4 py-2.5 text-left text-[11px] font-bold uppercase tracking-wider text-white';

  return (
    <section aria-labelledby="zone-dispatch-heading" className="mb-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 id="zone-dispatch-heading" className="text-[0.82rem] font-semibold uppercase tracking-wider text-ink-caps">
          Companies &amp; plants
        </h3>
        <FilterBar className="mb-0">
          <SearchInput
            aria-label="Search company or plant"
            placeholder="Company, plant…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-56"
          />
          <FilterSelect aria-label="Batch status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </FilterSelect>
          <FilterSelect
            aria-label="Sort by assignments"
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value as SortOrder)}
          >
            <option value="">Sort: company name</option>
            <option value="ASSIGN_DESC">Most assignments first</option>
            <option value="ASSIGN_ASC">Fewest assignments first</option>
          </FilterSelect>
        </FilterBar>
      </div>

      <div className="overflow-hidden rounded-card border border-line bg-surface-card shadow-sm">
        <table aria-label="Zone companies and plants" className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-chrome-700 bg-chrome-900">
              <th className={th}>Company</th>
              <th className={th}>Plant</th>
              <th className={cn(th, 'text-right')} title="Inactive devices / total devices on record">
                Inactive / Total
              </th>
              <th className={cn(th, 'text-right')} title="Devices with a formally-assigned ticket">
                Assigned
              </th>
              <th className={cn(th, 'text-right')} title="Devices with an unassigned ticket">
                Unassigned
              </th>
              <th className={cn(th, 'text-right')} title="Tickets dispatched in this run">
                Assignments
              </th>
              <th className={cn(th, 'text-right')}>Batches</th>
              <th className={th} />
            </tr>
          </thead>
          <tbody>
            {companies.length === 0 && (
              <tr>
                <td colSpan={COLSPAN} className="p-0">
                  <EmptyState icon={<IconTruck />} message="No dispatched batches match this filter." />
                </td>
              </tr>
            )}
            {companies.map((co) => {
              const open = term !== '' || openCompanies.has(co.companyName);
              return (
                <Fragment key={co.companyName}>
                  <tr
                    className="cursor-pointer border-b border-line bg-surface-sunken/50 hover:bg-surface-sunken"
                    onClick={() => toggleCompany(co.companyName)}
                    data-testid={`zone-company-row-${co.companyName}`}
                  >
                    <td className="px-4 py-2.5 font-semibold text-ink-strong">
                      <span className="flex items-center gap-1.5">
                        <IconChevronRight
                          className={cn('h-4 w-4 shrink-0 text-ink-muted transition-transform', open && 'rotate-90')}
                        />
                        <span className="min-w-0 truncate">{co.companyName}</span>
                        <span className="ml-1 shrink-0 text-xs font-normal text-ink-muted">
                          {co.plants.length} plant{co.plants.length === 1 ? '' : 's'}
                        </span>
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-ink-muted">—</td>
                    <td className="px-4 py-2.5 text-right">
                      <InactiveTotal stats={co.stats} />
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-ink">{co.stats.assignedDevices}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-ink">{co.stats.unassignedDevices}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-ink">{co.assignments}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-ink">{co.batchCount}</td>
                    <td className="px-4 py-2.5" />
                  </tr>

                  {open &&
                    co.plants.map((p) => (
                      <Fragment key={p.plantId}>
                        <tr
                          className="cursor-pointer border-b border-line last:border-b-0 hover:bg-surface-sunken/40"
                          onClick={() => onPlantClick(p)}
                          data-testid={`zone-plant-row-${p.plantId}`}
                        >
                          <td className="px-4 py-2.5 pl-10 text-ink-muted">—</td>
                          <td className="px-4 py-2.5 text-ink">{p.plantName}</td>
                          <td className="px-4 py-2.5 text-right">
                            <InactiveTotal stats={p.stats} />
                          </td>
                          <td className="px-4 py-2.5 text-right tabular-nums text-ink">{p.stats.assignedDevices}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums text-ink">{p.stats.unassignedDevices}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums text-ink">{p.assignments}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums text-ink">{p.batches.length}</td>
                          <td className="px-4 py-2.5 text-right">
                            <span className="whitespace-nowrap text-xs font-medium text-brand-700">
                              {p.batches.length === 1
                                ? 'View batch →'
                                : openPlant === p.plantId
                                  ? 'Hide batches'
                                  : 'View batches'}
                            </span>
                          </td>
                        </tr>
                        {openPlant === p.plantId && p.batches.length > 1 && (
                          <tr>
                            <td colSpan={COLSPAN} className="bg-surface-sunken/40 p-0">
                              <div className="px-6 py-3 sm:px-10">
                                <PlantBatchList batches={p.batches} onOpen={openBatch} />
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** The batches formed at one plant — engineer, stop, status, tickets; a row opens the batch detail. */
function PlantBatchList({ batches, onOpen }: { batches: DispatchBatchRow[]; onOpen: (batchId: string) => void }) {
  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface-card shadow-sm">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-chrome-700 bg-chrome-900 text-left text-[11px] uppercase tracking-wider text-white">
            <th className="px-4 py-2 font-bold">Engineer</th>
            <th className="px-4 py-2 text-right font-bold">Stop</th>
            <th className="px-4 py-2 font-bold">Status</th>
            <th className="px-4 py-2 text-right font-bold">Tickets</th>
          </tr>
        </thead>
        <tbody>
          {[...batches]
            .sort((a, b) => a.stopSequence - b.stopSequence)
            .map((b) => (
              <tr
                key={b.batchId}
                onClick={() => onOpen(b.batchId)}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onOpen(b.batchId);
                  }
                }}
                data-testid={`zone-batch-row-${b.batchId}`}
                className="cursor-pointer border-b border-line/70 last:border-b-0 hover:bg-surface-sunken/50 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-600/50"
              >
                <td className="px-4 py-2.5 text-ink">
                  {b.seName ?? <span className="font-mono text-xs">{b.seId.slice(0, 8)}</span>}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-ink">{b.stopSequence}</td>
                <td className="px-4 py-2.5">
                  <Badge tone="neutral">{b.status}</Badge>
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-ink">{b.ticketCount}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}
