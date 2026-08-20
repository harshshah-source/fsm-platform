import { useEffect, useMemo, useState } from 'react';
import { apiEngineers, type EngineerListRow } from '../../api/engineers';
import { apiAssignPlants, type PlantAssignSummary } from '../../api/schedules';
import type { DeviceFilterOptions } from '../../api/devices';
import { FilterSelect, SearchInput, useToastOptional } from '../../components/data';
import { Badge, Button } from '../../components/ui';
import { IconClose, IconPlus } from '../../components/ui/icons';
import { formatLoad, isOverCapacity } from '../../lib/capacity';
import { cn } from '../../lib/cn';
import { formatPlantDisplayName } from '../../lib/plantNames';

const ACTIVITY_TONE: Record<string, 'success' | 'info' | 'warning' | 'neutral'> = {
  AVAILABLE: 'success',
  ON_SITE: 'info',
  BUSY: 'warning',
};

/**
 * Manual SE assignment panel (Issue 122b, Device Detail page). A three-step flow — pick plants
 * (company-scoped, searchable, multi-select), pick the SE (live roster with derived activity), then
 * assign. Drives `POST /api/schedules/assign-plants`, which routes through the SAME assignTicket
 * primitive as the Critical-Queue one-click and ZM same-day ADD — so schedules, batches, audit rows,
 * notifications and the Shared-Pool exit behave identically everywhere in the app.
 */
export function AssignSePanel({
  options,
  onAssigned,
  onClose,
}: {
  options: DeviceFilterOptions;
  /** Called after a successful assignment so the page can refresh its list. */
  onAssigned: () => void;
  onClose: () => void;
}) {
  const toast = useToastOptional();
  const [companyId, setCompanyId] = useState('');
  const [plantSearch, setPlantSearch] = useState('');
  const [selectedPlants, setSelectedPlants] = useState<Set<number>>(new Set());
  const [engineers, setEngineers] = useState<EngineerListRow[] | null>(null);
  const [seId, setSeId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<PlantAssignSummary | null>(null);

  // Roster loads once when the panel opens.
  useEffect(() => {
    let alive = true;
    apiEngineers()
      .then((rows) => alive && setEngineers(rows))
      .catch(() => alive && setEngineers([]));
    return () => {
      alive = false;
    };
  }, []);

  const plants = useMemo(() => {
    const all = options.plants ?? [];
    const byCompany = companyId ? all.filter((p) => String(p.companyId) === companyId) : all;
    const term = plantSearch.trim().toLowerCase();
    const searched = term
      ? byCompany.filter(
          (p) =>
            formatPlantDisplayName(p.name).toLowerCase().includes(term) || String(p.plantId).includes(term),
        )
      : byCompany;
    // De-duplicate a plant serving several companies when no company is picked.
    const seen = new Set<number>();
    return searched.filter((p) => (seen.has(p.plantId) ? false : (seen.add(p.plantId), true)));
  }, [options.plants, companyId, plantSearch]);

  const togglePlant = (plantId: number) => {
    setSelectedPlants((prev) => {
      const next = new Set(prev);
      if (next.has(plantId)) next.delete(plantId);
      else next.add(plantId);
      return next;
    });
  };

  const se = engineers?.find((e) => e.seId === seId);
  const canAssign = selectedPlants.size > 0 && !!seId && !submitting;

  const assign = async () => {
    if (!canAssign) return;
    setSubmitting(true);
    setResult(null);
    try {
      const summary = await apiAssignPlants(seId, [...selectedPlants].map(String));
      setResult(summary);
      if (summary.assigned > 0) {
        toast?.success(
          `${summary.assigned} ticket${summary.assigned === 1 ? '' : 's'} assigned to ${se?.name ?? 'the SE'} across ${summary.perPlant.length} plant${summary.perPlant.length === 1 ? '' : 's'}.`,
        );
        setSelectedPlants(new Set());
        onAssigned();
      } else {
        toast?.push('No open unassigned tickets at the selected plants — nothing to assign.', 'info');
      }
    } catch {
      toast?.error('Assignment failed — please retry.');
    } finally {
      setSubmitting(false);
    }
  };

  const stepTitle = 'text-[11px] font-semibold uppercase tracking-wider text-ink-caps';

  return (
    <section
      aria-label="Assign SE to plants"
      data-testid="assign-se-panel"
      className="mb-5 overflow-hidden rounded-card border border-brand-600/25 bg-surface-card shadow-card"
    >
      <div className="flex items-center justify-between gap-2 border-b border-line bg-gradient-to-r from-brand-600/10 to-transparent px-4 py-2.5">
        <span className="text-sm font-semibold text-ink-strong">Assign SE to plants</span>
        <button
          type="button"
          aria-label="Close assignment panel"
          onClick={onClose}
          className="flex h-7 w-7 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink-strong"
        >
          <IconClose className="h-4 w-4" />
        </button>
      </div>

      <div className="grid gap-4 p-4 lg:grid-cols-[1.2fr,1fr,0.9fr]">
        {/* Step 1 — plants */}
        <div className="min-w-0">
          <div className={cn(stepTitle, 'mb-2')}>1 · Select plants ({selectedPlants.size})</div>
          <div className="mb-2 flex flex-wrap gap-2">
            <FilterSelect
              aria-label="Assignment company"
              value={companyId}
              onChange={(e) => {
                setCompanyId(e.target.value);
                setSelectedPlants(new Set());
              }}
              className="h-8 text-xs"
            >
              <option value="">All companies</option>
              {options.companies.map((c) => (
                <option key={c.companyId} value={String(c.companyId)}>
                  {c.name}
                </option>
              ))}
            </FilterSelect>
            <SearchInput
              aria-label="Search plants to assign"
              placeholder="Search plants…"
              value={plantSearch}
              onChange={(e) => setPlantSearch(e.target.value)}
              className="h-8 w-44 text-xs"
            />
          </div>
          <ul className="max-h-56 overflow-y-auto rounded-md border border-line bg-surface-sunken/40">
            {plants.length === 0 && (
              <li className="px-3 py-3 text-xs text-ink-muted">No plants match.</li>
            )}
            {plants.map((p) => (
              <li key={p.plantId} className="border-b border-line/60 last:border-b-0">
                <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-surface-sunken">
                  <input
                    type="checkbox"
                    checked={selectedPlants.has(p.plantId)}
                    onChange={() => togglePlant(p.plantId)}
                  />
                  <span className="min-w-0 truncate text-ink">{formatPlantDisplayName(p.name)}</span>
                  <span className="ml-auto shrink-0 text-[11px] tabular-nums text-ink-muted">#{p.plantId}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>

        {/* Step 2 — SE */}
        <div className="min-w-0">
          <div className={cn(stepTitle, 'mb-2')}>2 · Select the Service Engineer</div>
          <ul className="max-h-64 overflow-y-auto rounded-md border border-line bg-surface-sunken/40">
            {(engineers ?? []).length === 0 && (
              <li className="px-3 py-3 text-xs text-ink-muted">No engineers in your scope.</li>
            )}
            {(engineers ?? []).map((e) => (
              <li key={e.seId} className="border-b border-line/60 last:border-b-0">
                <label className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm hover:bg-surface-sunken">
                  <input
                    type="radio"
                    name="assign-se"
                    checked={seId === e.seId}
                    onChange={() => setSeId(e.seId)}
                  />
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-ink-strong">{e.name}</span>
                    {/* #269 — the roster line now answers "can they carry it?": today's committed
                        load over the cap, in the same `n/cap` vocabulary as every other assign
                        surface. Marked over capacity, never disabled (#258 Q2 — no gate). */}
                    <span className="block text-[11px] text-ink-muted">
                      {e.coverageType} · {formatLoad({ committed: e.activeTicketCount, dailyCapacity: e.dailyCapacity })}
                      {isOverCapacity({ committed: e.activeTicketCount, dailyCapacity: e.dailyCapacity }) && (
                        <span className="ml-1 font-semibold text-critical">over capacity</span>
                      )}
                    </span>
                  </span>
                  <Badge tone={ACTIVITY_TONE[e.activityStatus] ?? 'neutral'} className="ml-auto shrink-0">
                    {e.activityStatus}
                  </Badge>
                </label>
              </li>
            ))}
          </ul>
        </div>

        {/* Step 3 — confirm */}
        <div className="flex min-w-0 flex-col">
          <div className={cn(stepTitle, 'mb-2')}>3 · Assign</div>
          <div className="flex-1 rounded-md border border-line bg-surface-sunken/40 p-3 text-sm">
            {selectedPlants.size === 0 || !se ? (
              <p className="text-ink-muted">
                Every <span className="font-medium text-ink">open, unassigned</span> ticket at the
                selected plants joins the SE&apos;s Day Plan as plant stops — the same flow the
                dispatcher uses, fully audited.
              </p>
            ) : (
              <p className="text-ink">
                Assign all open unassigned tickets at{' '}
                <span className="font-semibold">{selectedPlants.size}</span> plant
                {selectedPlants.size === 1 ? '' : 's'} to{' '}
                <span className="font-semibold">{se.name}</span>.
              </p>
            )}
            {result && (
              <p data-testid="assign-result" className="mt-2 border-t border-line pt-2 text-xs text-ink-muted">
                Last run: {result.assigned} assigned
                {result.alreadyAssigned > 0 ? `, ${result.alreadyAssigned} already assigned` : ''} across{' '}
                {result.perPlant.length} plant{result.perPlant.length === 1 ? '' : 's'}.
              </p>
            )}
          </div>
          <Button
            type="button"
            className="mt-3 w-full"
            disabled={!canAssign}
            loading={submitting}
            onClick={() => void assign()}
            data-testid="assign-se-submit"
          >
            <IconPlus className="h-4 w-4" />
            Assign {selectedPlants.size > 0 ? `${selectedPlants.size} plant${selectedPlants.size === 1 ? '' : 's'}` : 'plants'}
          </Button>
        </div>
      </div>
    </section>
  );
}
